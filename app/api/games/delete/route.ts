/** 試合まるごと削除(ハード): 公開doc・全版履歴・下書き・ノートを消す。復元はバックアップからのみ。 */
import { NextResponse } from "next/server";
import { deleteGame } from "@/lib/ops/games";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId } = (await req.json()) as { gameId?: string };
    if (!gameId) return NextResponse.json({ error: "gameId が必要です" }, { status: 400 });
    const r = await deleteGame(gameId);
    return NextResponse.json({ ok: true, versions: r.versions });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
