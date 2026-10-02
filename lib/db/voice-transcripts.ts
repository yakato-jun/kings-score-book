/**
 * 音声入力の生テキスト記録(チャンク単位・追記のみ)。STTの生出力と補正後テキストを残し、
 * 後でノート(人の手直し後)と突き合わせて keywords の改善や補正の要否判断に使う。音声ファイル本体は保存しない。
 */
import { getDb } from "./mongo";
import type { VoiceCorrection } from "../ai/voice";

const COL = "voice_transcripts";

export interface VoiceTranscriptDoc {
  game_id: string;
  created_at: string;
  /** STTの生出力 */
  raw: string;
  /** 補正後(ノートへ挿入されたテキスト) */
  text: string;
  corrections: VoiceCorrection[];
  stt_model: string;
  correct_model: string;
  /** STTへ渡した keywords の件数(0=ヒント無し) */
  keywords_count: number;
}

export async function saveVoiceTranscript(doc: VoiceTranscriptDoc): Promise<void> {
  const db = await getDb();
  await db.collection<VoiceTranscriptDoc>(COL).insertOne({ ...doc });
}
