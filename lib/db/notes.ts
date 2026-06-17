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

export async function clearNote(gameId: string): Promise<void> {
  const db = await getDb();
  await db.collection<NoteDoc>(COL).deleteOne({ game_id: gameId });
}

/**
 * publish時: 現ノートを履歴(game_notes_history)へ世代として追記してから消す。＝試合確定でメモはクリア・履歴は残す。
 * 追記式(上書きしない)なので、将来「過去ノートの世代をマージしてAIに全量再集計させる」モードで全世代を順に引ける。
 */
export async function archiveAndClearNote(gameId: string, nowISO: string): Promise<void> {
  const db = await getDb();
  const cur = await db.collection<NoteDoc>(COL).findOne({ game_id: gameId }, { projection: { _id: 0 } });
  if (cur?.text?.trim()) {
    const gen = await db.collection(`${COL}_history`).countDocuments({ game_id: gameId });
    await db.collection(`${COL}_history`).insertOne({ game_id: gameId, gen: gen + 1, text: cur.text, archived_at: nowISO });
  }
  await db.collection<NoteDoc>(COL).deleteOne({ game_id: gameId });
}

interface NoteHistoryDoc { game_id: string; gen: number; text: string; archived_at: string }
/** 過去ノートの全世代(gen昇順)。将来のマージ→全量再集計モード用。 */
export async function loadNoteHistory(gameId: string): Promise<{ gen: number; text: string; archived_at: string }[]> {
  const db = await getDb();
  const rows = await db.collection<NoteHistoryDoc>(`${COL}_history`)
    .find({ game_id: gameId }, { projection: { _id: 0, gen: 1, text: 1, archived_at: 1 } })
    .sort({ gen: 1 })
    .toArray();
  return rows.map((r) => ({ gen: r.gen, text: r.text, archived_at: r.archived_at }));
}
