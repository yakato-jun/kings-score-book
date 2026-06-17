/**
 * 試合データのアクセス層。MongoDB から v2 試合doc を読む。
 * UI(RSC)・集計はここ経由でデータを取得する。テストは getDb をモックして検証。
 */
import { getDb } from "./mongo";
import type { GameDoc, GameVersion, GameOp } from "../types/v2";

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
 * 追記コミット(唯一の書き込み口)。履歴へ1版append、draftでなければ games(最新)も更新。
 * base_gen 指定時は楽観ロック(compare-and-append)で並行ドラフトの分岐を防止。
 */
export async function commitGameDoc(
  nextDoc: GameDoc,
  opts: { source: string; op?: GameOp | null; draft?: boolean; base_gen?: number }
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
    snapshot: nextDoc,
    op: opts.op ?? null,
    updated_at: new Date().toISOString(),
    updated_by: opts.source,
    draft: opts.draft ?? false,
  };
  await db.collection<GameVersion>(HIST).insertOne(version);
  if (!version.draft) {
    await db.collection<GameDoc>("games").replaceOne({ "game.id": gameId }, nextDoc, { upsert: true });
  }
  return { gen };
}

/**
 * 下書き世代を畳む(publish時のsquash / 下書き破棄)。draft=true の履歴行を削除。
 * 公開済み版(draft=false)は過去版へのロールバック用に残す。戻り値は削除件数。
 */
export async function squashDrafts(gameId: string): Promise<number> {
  const db = await getDb();
  const r = await db.collection<GameVersion>(HIST).deleteMany({ game_id: gameId, draft: true });
  return r.deletedCount ?? 0;
}

/** 下書き(draft=true の履歴)を持つ試合IDの一覧。未公開の新規試合もここに出る。 */
export async function draftGameIds(): Promise<string[]> {
  const db = await getDb();
  return (await db.collection<GameVersion>(HIST).distinct("game_id", { draft: true })) as string[];
}
