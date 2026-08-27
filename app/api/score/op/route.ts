/** 手動スコア入力: 1つの op(打席追加/編集/削除・スタメン・守備変更…)を作業中ドラフトに畳む(draft:true)。 */
import { NextResponse } from "next/server";
import { applyOps, type GameOpInput } from "@/lib/ops/games";
import { GenConflictError, currentGen } from "@/lib/db/games";
import { draftRaceMsg } from "@/lib/draft-msg";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId, op, baseGen } = (await req.json()) as { gameId?: string; op?: GameOpInput; baseGen?: number };
    if (!gameId || !op?.type) return NextResponse.json({ error: "gameId と op が必要です" }, { status: 400 });
    // AIノートと同じ下書きライフサイクルを共有(手動はフォーム→op逐次)。出口は applyOps→draftBar→公開。
    // baseGen=画面描画時のgen(楽観ロック §10.3④)。別タブ/端末の割り込みは GenConflictError→再読み込み文言。
    await applyOps(gameId, [op], {
      source: "admin", draft: true, edit_source: "manual",
      input: { kind: "manual", text: `スコア入力: ${op.type}` },
      ...(typeof baseGen === "number" ? { base_gen: baseGen } : {}),
    });
    return NextResponse.json({ ok: true, gen: await currentGen(gameId) }); // 新genを返す=クライアントが更新して自己競合を防ぐ
  } catch (e) {
    if (e instanceof GenConflictError) return NextResponse.json({ error: draftRaceMsg("スコア入力") }, { status: 409 });
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
