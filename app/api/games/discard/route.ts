/** 下書きを破棄＝draft世代を削除し、最後のpublish状態へ戻す(未公開なら消滅)。ノート(正本)は残す。 */
import { NextResponse } from "next/server";
import { squashDrafts } from "@/lib/db/games";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId } = (await req.json()) as { gameId: string };
    if (!gameId) return NextResponse.json({ error: "gameId が必要です" }, { status: 400 });
    const removed = await squashDrafts(gameId);
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
