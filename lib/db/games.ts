/**
 * 試合データのアクセス層。MongoDB から v2 試合doc を読む。
 * UI(RSC)・集計はここ経由でデータを取得する。テストは getDb をモックして検証。
 */
import { getDb } from "./mongo";
import type { GameDoc, GameVersion, EditSource, VersionInput } from "../types/v2";

const PROJ = { projection: { _id: 0 } } as const;
const HIST = "game_history";

/** 全試合を日付昇順で返す */
export async function loadGames(): Promise<GameDoc[]> {
  const db = await getDb();
  return db
    .collection<GameDoc>("games")
    .find({}, PROJ)
    .sort({ "game.date": 1 })
    .toArray();
}

/** 1試合を id で取得（無ければ null） */
export async function loadGame(id: string): Promise<GameDoc | null> {
  const db = await getDb();
  return db.collection<GameDoc>("games").findOne({ "game.id": id }, PROJ);
}

/** 履歴の先端gen。無ければ0（履歴前のシード状態を暗黙gen0とみなす）。 */
export async function currentGen(gameId: string): Promise<number> {
  const db = await getDb();
  const tip = await db
    .collection<GameVersion>(HIST)
    .findOne({ game_id: gameId }, { sort: { gen: -1 }, projection: { _id: 0 } });
  return tip?.gen ?? 0;
}

/** 作業中の最新状態(draft含む)。履歴があればその最新版、無ければ games(=確定)を gen0 として返す。編集側が読む。 */
export async function loadWorking(
  gameId: string
): Promise<{ doc: GameDoc; gen: number; draft: boolean } | null> {
  const db = await getDb();
  const tip = await db
    .collection<GameVersion>(HIST)
    .findOne({ game_id: gameId }, { sort: { gen: -1 }, projection: { _id: 0 } });
  if (tip) return { doc: tip.snapshot, gen: tip.gen, draft: tip.draft };
  const cur = await db.collection<GameDoc>("games").findOne({ "game.id": gameId }, PROJ);
  return cur ? { doc: cur, gen: 0, draft: false } : null;
}

/** 世代衝突(楽観ロック)。先端が base_gen と異なる＝誰かが先に積んだ。 */
export class GenConflictError extends Error {
  constructor(public expected: number, public actual: number) {
    super(`世代衝突: base_gen=${expected} ですが先端は ${actual} です。再読込してください`);
    this.name = "GenConflictError";
  }
}

/**
 * 追記コミット(唯一の書き込み口)。履歴へ1版append、draftでなければ games(最新=公開doc)も更新。
 * base_gen 指定時は楽観ロック(compare-and-append)で並行ドラフトの分岐を防止。
 * edit_source(どの機能で)・input(変更リソース正本)を版に刻む＝データ構造が編集の出自を語る。
 */
export async function commitGameDoc(
  nextDoc: GameDoc,
  opts: { source: string; edit_source: EditSource; input?: VersionInput | null; draft?: boolean; base_gen?: number }
): Promise<{ gen: number }> {
  const db = await getDb();
  const gameId = nextDoc.game.id;
  const tip = await currentGen(gameId);
  if (opts.base_gen !== undefined && opts.base_gen !== tip) {
    throw new GenConflictError(opts.base_gen, tip);
  }
  const gen = tip + 1;
  const version: GameVersion = {
    game_id: gameId,
    gen,
    draft: opts.draft ?? false,
    snapshot: nextDoc,
    updated_at: new Date().toISOString(),
    updated_by: opts.source,
    edit_source: opts.edit_source,
    input: opts.input ?? null,
  };
  await db.collection<GameVersion>(HIST).insertOne(version);
  if (!version.draft) {
    await db.collection<GameDoc>("games").replaceOne({ "game.id": gameId }, nextDoc, { upsert: true });
  }
  return { gen };
}

/** 最後に公開された版(draft:false)の gen。無ければ 0。public(games)＝この版の snapshot。 */
export async function publicGen(gameId: string): Promise<number> {
  const db = await getDb();
  const tip = await db
    .collection<GameVersion>(HIST)
    .findOne({ game_id: gameId, draft: false }, { sort: { gen: -1 }, projection: { gen: 1 } });
  return tip?.gen ?? 0;
}

/**
 * 試合の完全削除＝公開doc(games)と全版履歴(game_history)を消す(ハード削除)。
 * 復元はバックアップからのみ。編集中ノートは呼び出し側(ops)で消す。
 */
export async function deleteGameCompletely(gameId: string): Promise<{ versions: number; existed: boolean }> {
  const db = await getDb();
  const g = await db.collection<GameDoc>("games").deleteOne({ "game.id": gameId });
  const h = await db.collection<GameVersion>(HIST).deleteMany({ game_id: gameId });
  return { versions: h.deletedCount ?? 0, existed: (g.deletedCount ?? 0) > 0 };
}

/**
 * 下書きを破棄＝「最後の公開版より上に積まれた未確定(draft)版」だけ削除＝公開状態へ戻す。戻り値は削除件数。
 * 公開版(正本)・過去の公開サイクルの版には触れない(非破壊)。紐づくノートは呼び出し側(ops)で消す。
 */
export async function discardDrafts(gameId: string): Promise<number> {
  const db = await getDb();
  const pub = await publicGen(gameId);
  const r = await db.collection<GameVersion>(HIST).deleteMany({ game_id: gameId, draft: true, gen: { $gt: pub } });
  return r.deletedCount ?? 0;
}

/** 下書き(draft=true の履歴)を持つ試合IDの一覧。未公開の新規試合もここに出る。 */
export async function draftGameIds(): Promise<string[]> {
  const db = await getDb();
  return (await db.collection<GameVersion>(HIST).distinct("game_id", { draft: true })) as string[];
}

/**
 * 「先端版が未公開の下書き」の試合ID集合。公開後も履歴に残る過去のdraft版は含めない(distinctでは誤判定する)。
 * game_id ごとに最大gen版を取り、その draft が true のものだけ＝バッジ用の正確な"いま下書きがある"判定。
 */
export async function pendingDraftGameIds(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db
    .collection<GameVersion>(HIST)
    .aggregate<{ _id: string }>([
      { $sort: { gen: -1 } },
      { $group: { _id: "$game_id", draft: { $first: "$draft" } } },
      { $match: { draft: true } },
      { $project: { _id: 1 } },
    ])
    .toArray();
  return new Set(rows.map((r) => r._id));
}

/** 版一覧(新しい順)。snapshot は重いので外し、メタ＋入力(正本)だけ返す＝版履歴UI/過去ノート参照用。 */
export type VersionMeta = Omit<GameVersion, "snapshot">;
export async function listVersions(gameId: string): Promise<VersionMeta[]> {
  const db = await getDb();
  return db
    .collection<GameVersion>(HIST)
    .find({ game_id: gameId }, { projection: { _id: 0, snapshot: 0 } })
    .sort({ gen: -1 })
    .toArray() as Promise<VersionMeta[]>;
}

/** 特定 gen の版(snapshot込み)を返す。過去版のプレビュー(?gen=N)用。 */
export async function loadVersion(gameId: string, gen: number): Promise<GameVersion | null> {
  const db = await getDb();
  return db.collection<GameVersion>(HIST).findOne({ game_id: gameId, gen }, PROJ);
}

/**
 * 表示用にdocと文脈を解決する。gen指定=過去版(version)、preview=作業中(working)、それ以外=公開版(public)。
 * 公開/下書き/過去版でバナー表記を出し分けるための mode/draft/gen を返す。
 */
export interface ViewState { doc: GameDoc; gen: number; draft: boolean; mode: "public" | "preview" | "version" }
export async function loadForView(gameId: string, opts: { preview?: boolean; gen?: number }): Promise<ViewState | null> {
  if (opts.gen && opts.gen > 0) {
    const v = await loadVersion(gameId, opts.gen);
    return v ? { doc: v.snapshot, gen: v.gen, draft: v.draft, mode: "version" } : null;
  }
  if (opts.preview) {
    const w = await loadWorking(gameId);
    return w ? { doc: w.doc, gen: w.gen, draft: w.draft, mode: "preview" } : null;
  }
  const d = await loadGame(gameId);
  return d ? { doc: d, gen: 0, draft: false, mode: "public" } : null;
}
