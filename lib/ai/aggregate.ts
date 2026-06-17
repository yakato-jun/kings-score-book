/**
 * 集計キックの心臓部: ノート(自由文・1試合分) → 1コールで全打席を取り込む → validate。
 * 最小スキーマでモデルは事実だけ転記し、得点(runs[])・投捕・runner_id・押し出しはエンジンが導出する。
 * モデルは状態を追わない(走者同定はfrom塁→エンジン)ので、1コールでも『辻褄の合った誤り』が出ない。
 * 残った不整合はバリデータ(R1/R2/R3/R4)が flag → ユーザー修正へ。
 * 再集計を冪等にするため、既存の下書き内容(打席/スナップショット)は取込前に一旦クリアする。
 */
import { ingestWholeGame } from "./agent";
import { loadWorking, commitGameDoc } from "../db/games";
import { validateGame, type GameFlag } from "../ops/validate";

const MODEL = "claude-sonnet-4-6";

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface AggregateResult { flags: GameFlag[]; F0: number; usage: Usage; calls: number; clarification: string | null }

/** ノートを集計して下書きへ反映。戻り値は残flag(=ユーザー修正が要る箇所)。source:ai, draft:true で積む。 */
export async function aggregateNotes(gameId: string, notes: string, opts?: { model?: string; date?: string }): Promise<AggregateResult> {
  const model = opts?.model ?? MODEL;

  // 再集計の冪等化: 既存の下書き内容をクリア(メタは残す)。新規試合は何もしない。
  const w0 = await loadWorking(gameId);
  if (w0 && (w0.doc.plate_appearances.length || (w0.doc.lineup_snapshots?.length ?? 0))) {
    await commitGameDoc({ ...w0.doc, plate_appearances: [], lineup_snapshots: [], additional_players: [], attendance: [] }, { source: "ai", draft: true });
  }

  const r = await ingestWholeGame(gameId, notes, model, opts?.date);
  const usage: Usage = r.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const doc = (await loadWorking(gameId))?.doc;
  if (!doc) return { flags: [], F0: 0, usage, calls: 1, clarification: r.clarification };
  const flags = validateGame(doc);
  return { flags, F0: flags.length, usage, calls: 1, clarification: r.clarification };
}
