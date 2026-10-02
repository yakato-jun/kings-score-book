/**
 * Live 音声入力の確定テキスト記録(1発話=1件)。Live は補正AIを通さないので text=raw・corrections=[]。
 * 記録用途(keywords改善・補正要否の分析)なので、失敗してもクライアントは入力を続ける(呼び出し側で握りつぶす)。
 */
import { NextResponse } from "next/server";
import { saveVoiceTranscript } from "@/lib/db/voice-transcripts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const b = (await req.json().catch(() => ({}))) as { gameId?: unknown; raw?: unknown; model?: unknown; keywordsCount?: unknown };
    if (typeof b.gameId !== "string" || !b.gameId) return NextResponse.json({ error: "対象試合が指定されていません" }, { status: 400 });
    if (typeof b.raw !== "string" || !b.raw.trim()) return NextResponse.json({ error: "テキストがありません" }, { status: 400 });
    await saveVoiceTranscript({
      game_id: b.gameId, created_at: new Date().toISOString(), raw: b.raw, text: b.raw, corrections: [],
      stt_model: typeof b.model === "string" ? b.model : "unknown", correct_model: "none",
      keywords_count: typeof b.keywordsCount === "number" ? b.keywordsCount : 0,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
