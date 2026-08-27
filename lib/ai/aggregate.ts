/**
 * 集計キックの心臓部: ノート(自由文・1試合分) → 1コールで全打席を取り込む → validate。
 * 最小スキーマでモデルは事実だけ転記し、得点(runs[])・投捕・runner_id・押し出しはエンジンが導出する。
 * モデルは状態を追わない(走者同定はfrom塁→エンジン)ので、1コールでも『辻褄の合った誤り』が出ない。
 * 不明瞭点は2系統: バリデータ(R1-R4, source:validator)＋ AIが打席単位で付ける不明点(source:ai)。両方が要確認→ユーザー修正へ。
 * 再集計を冪等にするため、既存の下書き内容(打席/スナップショット)は取込前に一旦クリアする。
 */
import { ingestWholeGame, ingestDelta, ingestRevert, AI_MODEL } from "./agent";
import { loadWorking, publicGen } from "../db/games";
import { unresolvedUnclear, type GameFlag } from "../ops/validate";

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
// applied=この集計/取り消しで実際に反映したop数(0=変化点なし)。F0=反映後に残る要確認(unclear)数。両者は別物。
export interface AggregateResult { flags: GameFlag[]; F0: number; applied: number; usage: Usage; calls: number; clarification: string | null }

/** ノートを集計して下書きへ反映。戻り値は残flag(=ユーザー修正が要る箇所)。source:ai, draft:true で積む。 */
export async function aggregateNotes(gameId: string, notes: string, opts?: { model?: string; date?: string }): Promise<AggregateResult> {
  const model = opts?.model ?? AI_MODEL;

  // 公開前=全置換(ingestWholeGame)／公開後=現公開版への差分反映(ingestDelta)。公開版の有無で分岐＝別機能。
  const published = (await publicGen(gameId)) > 0;
  const r = published
    ? await ingestDelta(gameId, notes, model)
    : await ingestWholeGame(gameId, notes, model, opts?.date);
  const usage: Usage = r.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const doc = (await loadWorking(gameId))?.doc;
  if (!doc) return { flags: [], F0: 0, applied: r.count, usage, calls: 1, clarification: r.clarification };
  // 不明瞭点＝保存済みの「未解決」unclear注記(バリデータ由来＋AI由来)。承認済み(rule単位/AI打席単位)は除外。
  const flags: GameFlag[] = doc.plate_appearances.flatMap((p) =>
    unresolvedUnclear(p).map((a) => ({ inning: p.inning, half: p.half, order: p.order, detail: a.detail, rule: a.rule ?? "" })),
  );
  return { flags, F0: flags.length, applied: r.count, usage, calls: 1, clarification: r.clarification };
}

/**
 * 版の取り消し(revert)。gen が加えた変更だけを取り消して下書き化し、残flag(=要確認)を返す。
 * AI集計と同じく下書き→プレビュー確認→公開。取り消しで新たな矛盾が出れば validator が要確認に浮上させる。
 */
export async function revertVersion(gameId: string, gen: number, opts?: { model?: string }): Promise<AggregateResult> {
  const model = opts?.model ?? AI_MODEL;
  const r = await ingestRevert(gameId, gen, model);
  const usage: Usage = r.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const doc = (await loadWorking(gameId))?.doc;
  if (!doc) return { flags: [], F0: 0, applied: r.count, usage, calls: 1, clarification: r.clarification };
  const flags: GameFlag[] = doc.plate_appearances.flatMap((p) =>
    unresolvedUnclear(p).map((a) => ({ inning: p.inning, half: p.half, order: p.order, detail: a.detail, rule: a.rule ?? "" })),
  );
  return { flags, F0: flags.length, applied: r.count, usage, calls: 1, clarification: r.clarification };
}
