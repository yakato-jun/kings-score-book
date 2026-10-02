import { describe, it, expect, vi } from "vitest";

// DBモック: getDb を差し替え、Atlas に接続せず保存先コレクションと保存内容を検証
vi.mock("../db/mongo", () => ({ getDb: vi.fn() }));
import { getDb } from "../db/mongo";
import { saveVoiceTranscript, type VoiceTranscriptDoc } from "../db/voice-transcripts";

describe("saveVoiceTranscript (getDbモック)", () => {
  it("voice_transcripts に1チャンク1件で追記する", async () => {
    const inserted: { col: string; doc: unknown }[] = [];
    (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      collection: (col: string) => ({ insertOne: async (doc: unknown) => { inserted.push({ col, doc }); return { acknowledged: true }; } }),
    });
    const doc: VoiceTranscriptDoc = {
      game_id: "g1", created_at: "2026-10-02T00:00:00.000Z", raw: "山下ヒット", text: "山田ヒット",
      corrections: [{ heard: "山下", corrected: "山田" }], stt_model: "gpt-transcribe", correct_model: "gpt-6.1-sol", keywords_count: 42,
    };
    await saveVoiceTranscript(doc);
    expect(inserted).toEqual([{ col: "voice_transcripts", doc }]);
  });
});
