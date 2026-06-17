/**
 * AIチャットの非同期ジョブ。送信は即返し、処理はバックグラウンドの drain ループで進む。
 * ジョブは試合ごとに同時1つ(=直列)。会話本体は game_chats、ジョブは状態/結果だけを持つ。
 * ブラウザの state ポーリングがノードを生かす間に進み、応答待ちが無くなれば止まる(別建てキュー不要)。
 */
import { getDb } from "./mongo";

export type JobStatus = "pending" | "running" | "done" | "error" | "timeout";
const COL = "chat_jobs";
export const STALE_MS = 180_000; // pending/running のまま更新が止まったら timeout 扱い(集計は長め)

export interface ChatJob {
  job_id: string;
  game_id: string;
  status: JobStatus;
  result?: unknown | null; // 集計結果(flags/F0/usage 等)。読み手がキャスト
  error?: string | null;
  created_at: string;
  updated_at: string;
}

export async function createJob(job_id: string, game_id: string, nowISO: string): Promise<void> {
  const db = await getDb();
  await db.collection<ChatJob>(COL).insertOne({ job_id, game_id, status: "pending", result: null, error: null, created_at: nowISO, updated_at: nowISO });
}

export async function updateJob(job_id: string, patch: Partial<ChatJob>, nowISO: string): Promise<void> {
  const db = await getDb();
  await db.collection<ChatJob>(COL).updateOne({ job_id }, { $set: { ...patch, updated_at: nowISO } });
}

/** 試合の進行中ジョブ(古くて止まったものは除く)。あれば二重起動しない。 */
export async function getActiveJob(game_id: string, nowMs: number): Promise<ChatJob | null> {
  const db = await getDb();
  const j = await db.collection<ChatJob>(COL).findOne(
    { game_id, status: { $in: ["pending", "running"] } },
    { sort: { created_at: -1 }, projection: { _id: 0 } }
  );
  if (!j) return null;
  if (nowMs - Date.parse(j.updated_at) > STALE_MS) return null; // 止まった残骸は無視
  return j;
}

/** 試合の最新ジョブ(状態表示用)。古い pending/running は timeout に倒す。 */
export async function getLatestJob(game_id: string, nowMs: number): Promise<ChatJob | null> {
  const db = await getDb();
  const j = await db.collection<ChatJob>(COL).findOne({ game_id }, { sort: { created_at: -1 }, projection: { _id: 0 } });
  if (!j) return null;
  if ((j.status === "pending" || j.status === "running") && nowMs - Date.parse(j.updated_at) > STALE_MS) {
    return { ...j, status: "timeout", error: "応答がタイムアウトしました" };
  }
  return j;
}
