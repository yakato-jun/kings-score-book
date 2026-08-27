/**
 * [§10.6 非破壊リワーク移行] migrateRunOverridesOuts の検証。
 *  - own集計(aggregateGameP)が移行前後でバイト一致(値を壊さない=非破壊移行のゲート)。
 *  - responsible_pitcher_id が runs[] から doc.run_overrides(manual)へ移る。
 *  - 導出一致 outs は null 戻し / 食い違い outs は保存維持+flag。
 */
import { describe, it, expect } from "vitest";
import { doc, snap, pa } from "./fixtures";
import { migrateRunOverridesOuts } from "../migrate/rework";
import { aggregateGameP } from "../agg/participants";
import { deriveResponsiblePitchers } from "../ops/gamestate";
import type { GameDoc } from "../types/v2";

/** away=自軍先攻→守備=bottom。PPが投手(pos1)。相手attack(bottom)で失点。 */
function seedDoc(): GameDoc {
  const d = doc({ home_away: "away" });
  delete d.attendance;
  delete d.additional_players;
  d.participants = [
    { id: "m1", link: { kind: "roster", player_id: "P1" } },
    { id: "m9", link: { kind: "roster", player_id: "PP" } },
  ];
  d.lineup_snapshots = [snap([[1, "6", "m1"], [null, "1", "m9"]], { effective_from: { inning: 1, half: "bottom", before_order: null } })];
  d.plate_appearances = [
    pa({ id: "b1", inning: 1, half: "bottom", order: 1, batter_id: "o1", opponent_slot: 1, result: "H1", outs: 0 }),
    pa({
      id: "b2", inning: 1, half: "bottom", order: 2, batter_id: "o2", opponent_slot: 2, result: "HR", outs: 0,
      runs: [
        { runner_id: "o1", rbi: true, earned: true, cause: "hr", responsible_pitcher_id: "m9" },
        { runner_id: "o2", rbi: true, earned: true, cause: "hr", responsible_pitcher_id: "m9" },
      ],
    }),
    // 特別ルール: 3人目の開始時アウト=4(H1/HRで導出は0)＝食い違い(保存が正)
    pa({ id: "b3", inning: 1, half: "bottom", order: 3, batter_id: "o3", opponent_slot: 3, result: "OUT", outs: 4 }),
  ];
  return d;
}

describe("migrateRunOverridesOuts (§10.6 非破壊移行)", () => {
  it("own集計(aggregateGameP)が移行前後でバイト一致する(値を壊さない)", () => {
    const before = seedDoc();
    const beforeBox = aggregateGameP(before);
    const { doc: after } = migrateRunOverridesOuts(before);
    expect(aggregateGameP(after)).toEqual(beforeBox);
  });

  it("responsible_pitcher_id が runs[] から doc.run_overrides(manual)へ移り、read時導出は同値", () => {
    const before = seedDoc();
    const { doc: after, report } = migrateRunOverridesOuts(before);
    expect(report.responsible_moved).toBe(2);
    // runs[] からは除去(auto専用に空ける)
    const b2 = after.plate_appearances.find((p) => p.id === "b2")!;
    expect(b2.runs.every((r) => r.responsible_pitcher_id === undefined)).toBe(true);
    // doc.run_overrides に manual として保全
    expect(after.run_overrides).toEqual(expect.arrayContaining([
      { pa_id: "b2", runner_id: "o1", responsible_pitcher_id: "m9", origin: "manual" },
      { pa_id: "b2", runner_id: "o2", responsible_pitcher_id: "m9", origin: "manual" },
    ]));
    // read時導出でも m9 へ帰属(移行前と同じ)
    const resp = deriveResponsiblePitchers(after).get(b2)!;
    expect(resp.get("o1")).toBe("m9");
    expect(resp.get("o2")).toBe("m9");
  });

  it("導出一致 outs は null 戻し / 食い違い outs は保存維持+flag", () => {
    const before = seedDoc();
    const { doc: after, report } = migrateRunOverridesOuts(before);
    const b1 = after.plate_appearances.find((p) => p.id === "b1")!; // outs0=導出0一致
    const b3 = after.plate_appearances.find((p) => p.id === "b3")!; // outs4≠導出2
    expect(b1.outs).toBeNull();
    expect(report.outs_nulled).toBeGreaterThanOrEqual(1);
    expect(b3.outs).toBe(4); // 主張値を保持
    expect(report.outs_kept_flagged).toBe(1);
    expect((b3.annotations ?? []).some((a) => a.type === "unclear" && a.detail.includes("保存アウト"))).toBe(true);
  });
});
