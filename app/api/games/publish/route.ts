/** 下書きを確定(publish)＝最新スナップショットを公開＋下書き世代を畳む。 */
import { NextResponse } from "next/server";
import { publishGame } from "@/lib/ops/games";
import { archiveAndClearNote } from "@/lib/db/notes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId } = (await req.json()) as { gameId: string };
    if (!gameId) return NextResponse.json({ error: "gameId が必要です" }, { status: 400 });
    await publishGame(gameId, { source: "note" });
    await archiveAndClearNote(gameId, new Date().toISOString()); // 確定でメモはクリア(履歴は残す)
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
