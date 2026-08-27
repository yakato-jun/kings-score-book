/** [§12 P3] 選手の名寄せ: from の出場を to へ付け替える(非破壊append・二重計上はskip)。選手マスタ一覧の行内操作から呼ぶ。 */
import { NextResponse } from "next/server";
import { mergePlayer } from "@/lib/ops/games";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { from, to, gameIds } = (await req.json()) as { from?: string; to?: string; gameIds?: string[] };
    if (!from || !to) return NextResponse.json({ error: "名寄せ元/名寄せ先の選手が必要です" }, { status: 400 });
    const r = await mergePlayer(from, to, gameIds ? { gameIds } : undefined);
    return NextResponse.json({ ok: true, updatedGames: r.updatedGames, skipped: r.skipped });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
