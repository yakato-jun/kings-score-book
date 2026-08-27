/**
 * 集計キックの実行体。POST /api/aggregate から fire-and-forget で呼ぶ(1キック=1ジョブ)。
 * ノート全文を aggregateNotes(1コール ingestWholeGame→validate)に通すだけ。
 * ブラウザの status ポーリングがノードを生かす間に進む(別建てキュー不要)。
 */
import { aggregateNotes } from "./aggregate";
import { updateJob } from "../db/jobs";

const SERVER_TIMEOUT_MS = 170_000;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("__timeout__")), ms));
}

export async function runAggregationJob(jobId: string, gameId: string, notes: string, date?: string): Promise<void> {
  const iso = () => new Date().toISOString();
  try {
    await updateJob(jobId, { status: "running" }, iso());
    const result = await Promise.race([aggregateNotes(gameId, notes, { date }), timeout(SERVER_TIMEOUT_MS)]);
    await updateJob(jobId, { status: "done", result }, iso());
  } catch (e) {
    const msg = (e as Error).message;
    await updateJob(jobId, msg === "__timeout__" ? { status: "timeout", error: "集計がタイムアウトしました" } : { status: "error", error: msg }, iso());
  }
}
