/** 要確認の承認(解決): 打席に resolved 注記を足して要確認から外す(直さず「意図どおり」と認める)。 */
import { NextResponse } from "next/server";
import { resolveFlag } from "@/lib/ops/games";
import type { Half } from "@/lib/types/v2";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { gameId, inning, half, order, reason, rule } = (await req.json()) as {
      gameId?: string; inning?: number; half?: Half; order?: number; reason?: string; rule?: string | null;
    };
    if (!gameId || !inning || (half !== "top" && half !== "bottom") || !order) {
      return NextResponse.json({ error: "対象の打席が指定されていません" }, { status: 400 });
    }
    await resolveFlag(gameId, { inning, half, order }, (reason ?? "").trim(), rule ?? null, { source: "admin" });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
