/** revert: 指定版が加えた変更だけを取り消して下書き化する(AIが現公開版へ逆反映)。下書き中は弾く。 */
import { NextResponse } from "next/server";
import { revertVersion } from "@/lib/ai/aggregate";
import { GenConflictError } from "@/lib/db/games";
import { draftRaceMsg } from "@/lib/draft-msg";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId, gen } = (await req.json()) as { gameId?: string; gen?: number };
    if (!gameId || !gen) return NextResponse.json({ error: "gameId と gen が必要です" }, { status: 400 });
    const r = await revertVersion(gameId, gen);
    // applied=反映op数(0=取り消す変化点なし)。flags/F0=反映後に残る要確認。両者は別物。
    return NextResponse.json({ ok: true, applied: r.applied, flags: r.flags, count: r.F0, clarification: r.clarification });
  } catch (e) {
    if (e instanceof GenConflictError) {
      return NextResponse.json({ error: draftRaceMsg("取り消し") }, { status: 409 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
