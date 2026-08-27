/**
 * 試合ごとの入力ノート(集計の元テキスト=正本)。自動保存で途中ロストを防ぐ・共有もする。
 * 「ノート=正本／下書き=導出」。これがあるから「編集点以降を再集計」(部分リビルド)ができる。
 */
import { getDb } from "./mongo";

const COL = "game_notes";
interface NoteDoc { game_id: string; text: string; updated_at: string }

export async function loadNote(gameId: string): Promise<string> {
  const db = await getDb();
  const d = await db.collection<NoteDoc>(COL).findOne({ game_id: gameId }, { projection: { _id: 0 } });
  return d?.text ?? "";
}

export async function saveNote(gameId: string, text: string, nowISO: string): Promise<void> {
  const db = await getDb();
  await db.collection<NoteDoc>(COL).updateOne({ game_id: gameId }, { $set: { text, updated_at: nowISO } }, { upsert: true });
}

/** 編集中ノートを消す(下書き破棄 / publishでの新ソース開始)。確定済みノートは publish版の input に凍結済み。 */
export async function clearNote(gameId: string): Promise<void> {
  const db = await getDb();
  await db.collection<NoteDoc>(COL).deleteOne({ game_id: gameId });
}
