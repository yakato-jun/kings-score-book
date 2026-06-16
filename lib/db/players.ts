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

/** 1選手を upsert(id一致で置換、無ければ新規)。 */
export async function writePlayer(p: Player): Promise<void> {
  const db = await getDb();
  await db.collection<Player>("players").replaceOne({ id: p.id }, p, { upsert: true });
}
