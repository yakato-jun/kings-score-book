/** 下書きを確定(publish)＝最新スナップショットを公開＋下書き世代を畳む。 */
import { NextResponse } from "next/server";
import { publishGame } from "@/lib/ops/games";
import { clearNote } from "@/lib/db/notes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId } = (await req.json()) as { gameId: string };
    if (!gameId) return NextResponse.json({ error: "gameId が必要です" }, { status: 400 });
    // 公開版を append(squashしない＝AI集計/AI修正の draft版が入力ごと履歴に残る＝ノート凍結)。
    await publishGame(gameId, { source: "admin" });
    await clearNote(gameId); // 編集バッファをクリア＝新しいノートソース開始(正本は draft版の input に残る)
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
