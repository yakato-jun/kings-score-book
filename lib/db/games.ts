/**
 * 試合データのアクセス層。MongoDB から v2 試合doc を読む。
 * UI(RSC)・集計はここ経由でデータを取得する。テストは getDb をモックして検証。
 */
import { getDb } from "./mongo";
import type { GameDoc } from "../types/v2";

const PROJ = { projection: { _id: 0 } } as const;

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
