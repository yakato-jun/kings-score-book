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
