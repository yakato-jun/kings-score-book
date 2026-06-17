/** AI集計キック: ノートを保存し、集計ジョブ(全文を1コール ingestWholeGame→validate→repair)を起動。即 jobId を返す。 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { saveNote, loadNote } from "@/lib/db/notes";
import { getActiveJob, createJob } from "@/lib/db/jobs";
import { runAggregationJob } from "@/lib/ai/jobrunner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(req: Request) {
  try {
    const { gameId, text } = (await req.json()) as { gameId?: string; text?: string };
    if (!gameId) return NextResponse.json({ error: "対象試合が指定されていません" }, { status: 400 });
    const iso = new Date().toISOString();
    if (typeof text === "string") await saveNote(gameId, text, iso); // 最新を保存してから集計
    const notes = typeof text === "string" ? text : await loadNote(gameId);
    if (!notes.trim()) return NextResponse.json({ error: "ノートが空です" }, { status: 400 });

    const active = await getActiveJob(gameId, Date.now());
    if (active) return NextResponse.json({ jobId: active.job_id, already: true });
    const jobId = randomUUID();
    await createJob(jobId, gameId, iso);
    void runAggregationJob(jobId, gameId, notes); // fire-and-forget(ブラウザのポーリングがノードを生かす)
    return NextResponse.json({ jobId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
