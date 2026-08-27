/**
 * [§10.6 非破壊リワークの移行] 既に participants 化済みの試合(post-flip)を、非破壊リワークの新表現へ移す。
 * 使い捨てでなく検証可能な純関数(移行スクリプト scripts/migrate_rework.ts が呼ぶ)。dry-run で own集計一致を確認する。
 *
 *  (13) 責任投手: 既存 runs[].responsible_pitcher_id(非null=元記録) → doc.run_overrides に manual として保全し、
 *       runs[] 側は auto 導出専用に空ける(responsible_pitcher_id を除去)。
 *  (14) 保存 outs(全部導出値): 導出開始アウト(outsMade累積=read時 derivePAStates と同一)と一致する打席は null 戻し(read導出)。
 *       食い違う打席(DP等で保存が正)は保存維持＋flag(黙って書き換えない)。read の cumulative も outsMade基準なので自己整合。
 *  (15) 機械回転された打順スロットは前向き撤去では回復不能・出自マーカーも無いため自動判別できない。黙って正規化しない
 *       (=触らない)ことでコンセプト順守。必要なら人手/ノートから個別に直す。
 *
 * 不変: aggregateGameP は pa.outs を読まず、責任投手は runs[].responsible_pitcher_id ?? reach ?? facing と
 *   同値の doc.run_overrides(manual) を最優先で読むため、移行前後で own集計(打撃/投手/守備)はバイト一致する。
 */
import type { GameDoc, PlateAppearance, RunOverride, RunEvent, Annotation } from "@/lib/types/v2";
import { outsMade } from "@/lib/agg";

export interface ReworkReport {
  game_id: string;
  responsible_moved: number; // runs[].responsible_pitcher_id → run_overrides(manual) 件数
  outs_nulled: number;       // 導出一致で null 戻し
  outs_kept_flagged: number; // 導出と食い違い→保存維持+flag
}

export function migrateRunOverridesOuts(doc: GameDoc): { doc: GameDoc; report: ReworkReport } {
  // 1) 不変ID確保(run_overrides は pa_id キー。未採番の旧データはここで採番)。
  let mx = 0;
  for (const p of doc.plate_appearances) { const m = /^b(\d+)$/.exec(p.id ?? ""); if (m) mx = Math.max(mx, Number(m[1])); }
  const withIds = doc.plate_appearances.map((p) => (p.id ? p : { ...p, id: `b${++mx}` }));

  // 2) 半イニングごとの導出開始アウト(outsMade累積=read時 derivePAStates と同一規則)。
  const byHalf = new Map<string, PlateAppearance[]>();
  for (const p of withIds) { const k = `${p.inning}-${p.half}`; (byHalf.get(k) ?? byHalf.set(k, []).get(k)!).push(p); }
  const derivedStartOuts = new Map<PlateAppearance, number>();
  for (const list of byHalf.values()) {
    const ordered = [...list].sort((a, b) => a.order - b.order);
    let cum = 0;
    for (const p of ordered) { derivedStartOuts.set(p, cum); cum += outsMade(p); }
  }

  const overrides: RunOverride[] = [...(doc.run_overrides ?? [])];
  let responsible_moved = 0, outs_nulled = 0, outs_kept_flagged = 0;

  const pas = withIds.map((p) => {
    let next: PlateAppearance = p;
    // (13) responsible_pitcher_id → run_overrides(manual)、runs[] から除去。
    let runsChanged = false;
    const runs: RunEvent[] = (p.runs ?? []).map((r) => {
      if (r.responsible_pitcher_id != null) {
        if (!overrides.some((o) => o.pa_id === p.id && o.runner_id === r.runner_id)) {
          overrides.push({ pa_id: p.id!, runner_id: r.runner_id ?? "", responsible_pitcher_id: r.responsible_pitcher_id, origin: "manual" });
          responsible_moved++;
        }
        runsChanged = true;
        const { responsible_pitcher_id: _drop, ...rest } = r; void _drop;
        return rest as RunEvent;
      }
      return r;
    });
    if (runsChanged) next = { ...next, runs };

    // (14) outs: 導出開始アウトと一致→null戻し / 食い違い→保存維持+flag。
    const derived = derivedStartOuts.get(p) ?? 0;
    if (typeof p.outs === "number") {
      if (p.outs === derived) { next = { ...next, outs: null }; outs_nulled++; }
      else {
        outs_kept_flagged++;
        const detail = `保存アウト(${p.outs})が導出開始アウト(${derived})と一致しません。特別ルール/併殺の主張値として保持します(確認してください)`;
        if (!(next.annotations ?? []).some((a) => a.detail === detail)) {
          const note: Annotation = { type: "unclear", source: "manual", rule: null, detail };
          next = { ...next, annotations: [...(next.annotations ?? []), note] };
        }
      }
    }
    return next;
  });

  return {
    doc: { ...doc, plate_appearances: pas, ...(overrides.length ? { run_overrides: overrides } : {}) },
    report: { game_id: doc.game.id, responsible_moved, outs_nulled, outs_kept_flagged },
  };
}
