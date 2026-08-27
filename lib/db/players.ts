/** 選手マスタの読み込み（id→名前）。名前は機密のため Atlas players コレクションから取得。 */
import { getDb } from "./mongo";
import type { Player } from "../types/v2";

/** id → 名前 の Map を返す */
export async function loadPlayers(): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db
    .collection<Player>("players")
    .find({}, { projection: { _id: 0 } })
    .toArray();
  return new Map(rows.map((p) => [p.id, p.name]));
}

/** 全選手(id昇順)。管理画面用。 */
export async function loadPlayerList(): Promise<Player[]> {
  const db = await getDb();
  return db
    .collection<Player>("players")
    .find({}, { projection: { _id: 0 } })
    .sort({ id: 1 })
    .toArray();
}

/**
 * id → Player の Map を返す（種別 type / origin も運ぶ読み取り）。
 * loadPlayers（id→名前）とは別物。将来の助っ人一本化で種別を参照する経路の下ごしらえ。
 * 未設定/空の type は "regular"(正選手) を既定として正規化する＝メモリ上のみ・DBは書かない(非破壊)。
 * 既存の "member" 等の非空値はそのまま保持する。
 */
export async function loadPlayerMap(): Promise<Map<string, Player>> {
  const rows = await loadPlayerList();
  return new Map(
    rows.map((p) => [p.id, { ...p, type: (p.type ?? "").trim() || "regular" }]),
  );
}

/** 1選手を upsert(id一致で置換、無ければ新規)。 */
export async function writePlayer(p: Player): Promise<void> {
  const db = await getDb();
  await db.collection<Player>("players").replaceOne({ id: p.id }, p, { upsert: true });
}

/**
 * 1選手を削除(id一致・deleteOne)。[§12 P5] 名寄せ(mergePlayer)完了で現公開版のどこからも参照されなく
 * なった統合元マスタの除去に使う＝名寄せ後に選手マスタへ重複行を残さないための最小手段。
 */
export async function deletePlayer(id: string): Promise<void> {
  const db = await getDb();
  await db.collection<Player>("players").deleteOne({ id });
}
