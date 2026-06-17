/** 集計ジョブの状態。クライアントは応答待ちの間だけポーリング。 */
import { NextResponse } from "next/server";
import { getLatestJob } from "@/lib/db/jobs";
import { loadWorking } from "@/lib/db/games";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const gameId = new URL(req.url).searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "gameId が必要です" }, { status: 400 });
  const job = await getLatestJob(gameId, Date.now());
  const w = await loadWorking(gameId);
  const result = (job?.result ?? null) as { flags?: unknown[]; F0?: number; usage?: unknown; calls?: number; clarification?: string | null } | null;
  return NextResponse.json({
    status: job?.status ?? "idle",
    flags: result?.flags ?? [],
    F0: result?.F0 ?? 0,
    calls: result?.calls ?? 0,
    clarification: result?.clarification ?? null,
    usage: result?.usage ?? null,
    error: job?.error ?? null,
    hasDraft: w?.draft ?? false,
  });
}
