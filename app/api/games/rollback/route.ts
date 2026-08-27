/** ロールバック: 過去版 gen の内容を最新版として積む(public直コミット)。下書き中は楽観ロックで弾く。 */
import { NextResponse } from "next/server";
import { rollbackGame } from "@/lib/ops/games";
import { GenConflictError } from "@/lib/db/games";
import { draftRaceMsg } from "@/lib/draft-msg";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId, gen } = (await req.json()) as { gameId?: string; gen?: number };
    if (!gameId || !gen) return NextResponse.json({ error: "gameId と gen が必要です" }, { status: 400 });
    await rollbackGame(gameId, gen, { source: "admin" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof GenConflictError) {
      return NextResponse.json({ error: draftRaceMsg("ロールバック") }, { status: 409 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
