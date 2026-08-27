/** 下書きを破棄＝最後の公開版より上の draft 版＋編集中ノートを削除し、公開状態へ戻す(未確定スクラッチのみ削除)。 */
import { NextResponse } from "next/server";
import { discardGame } from "@/lib/ops/games";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId } = (await req.json()) as { gameId: string };
    if (!gameId) return NextResponse.json({ error: "gameId が必要です" }, { status: 400 });
    const removed = await discardGame(gameId);
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
