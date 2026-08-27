/** Phase B(§10.3) エンジン基盤: 有効スナップショット参照の次打者・代走の盤面置換・併殺/AUTO_OUTのアウト導出 */
import { describe, it, expect } from "vitest";
import { deriveNextPA, foldRunners, deriveScorers } from "../ops/gamestate";
import { outsMade } from "../agg";
import { validateGame } from "../ops/validate";
import { doc, pa, snap, LINEUP } from "./fixtures";

const kingsPA = (order: number, slot: number, result = "OUT", over: Record<string, unknown> = {}) =>
  pa({ inning: 1, half: "top", order, batting_slot: slot, batter_id: `P${slot}`, result: result as never, ...over });

describe("deriveNextPA: 有効スナップショット参照＋最終打席スロット基準(§10.3)", () => {
  it("5番6番を一時交換すると、次打者予告が交換後のスナップショットに追従する", () => {
    // seq0: 通常打順(P5=5番, P6=6番)。seq1: 5打席目の前から5番=P6/6番=P5に交換
    const swapped: [number | null, string, string][] = LINEUP.map(([o, pos, pid]) =>
      pid === "P5" ? [6, pos, pid] : pid === "P6" ? [5, pos, pid] : [o, pos, pid]
    );
    const d = doc({
      home_away: "away",
      lineup_snapshots: [
        snap(LINEUP),
        snap(swapped, { seq: 1, snapshot_id: "GTEST-NK-01", effective_from: { inning: 1, half: "top", before_order: 5 }, reason: "order_swap" }),
      ],
      plate_appearances: [1, 2, 3, 4].map((i) => kingsPA(i, i)),
    });
    const n5 = deriveNextPA(d, 1, "top");
    expect([n5.batting_slot, n5.batter_id]).toEqual([5, "P6"]); // 交換後: 5番=P6
    // 5番(P6)が打ったあとの次は6番=P5
    d.plate_appearances.push(kingsPA(5, 5, "H1", { batter_id: "P6" }));
    const n6 = deriveNextPA(d, 1, "top");
    expect([n6.batting_slot, n6.batter_id]).toEqual([6, "P5"]);
  });

  it("未完了(INC)の次は同スロットの再打席", () => {
    const d = doc({
      home_away: "away",
      plate_appearances: [kingsPA(1, 1, "H1"), kingsPA(2, 2, "INC", { complete: false })],
    });
    const n = deriveNextPA(d, 1, "top");
    expect([n.batting_slot, n.batter_id]).toEqual([2, "P2"]); // 盗塁死チェンジ等→次の回も同じ2番から
  });

  it("欠員スロット(退場で6番が消えた)はスキップして次の実在スロットへ", () => {
    const without6: [number | null, string, string][] = LINEUP.filter(([, , pid]) => pid !== "P6");
    const d = doc({
      home_away: "away",
      lineup_snapshots: [
        snap(LINEUP),
        snap(without6, { seq: 1, snapshot_id: "GTEST-NK-01", effective_from: { inning: 1, half: "top", before_order: 6 }, reason: "left" }),
      ],
      plate_appearances: [1, 2, 3, 4, 5].map((i) => kingsPA(i, i)),
    });
    const n = deriveNextPA(d, 1, "top");
    expect([n.batting_slot, n.batter_id]).toEqual([7, "P7"]); // 6番欠員→7番へ
  });

  it("相手: 最後の相手打席の opponent_slot に追従(修正すると次から直る)", () => {
    const d = doc({
      home_away: "away",
      plate_appearances: [pa({ inning: 1, half: "bottom", order: 1, batter_id: "o5", opponent_slot: 5, result: "OUT" })],
    });
    const n = deriveNextPA(d, 1, "bottom");
    expect([n.opponent_slot, n.batter_id]).toEqual([6, "o6"]);
  });
});

describe("代走(§10.3 本対応): 盤面の走者置換", () => {
  const base = { first: null, second: "P1", third: null };

  it("foldRunners: for_base の走者が代走者に置換され、以後の進塁は代走者IDで動く", () => {
    const p = pa({
      batter_id: "P2", result: "H1",
      pinch_runner: { type: "pinch_runner", runner_id: "P9", for_base: "2" },
      baserunning_after: [{ runner_id: "P9", from: "2", to: "3" }],
    });
    const r = foldRunners(base, p);
    expect(r.third).toBe("P9"); // 代走者が三塁へ
    expect(r.second).toBe(null);
  });

  it("deriveScorers: 本塁打の生還者は代走者(元走者ではない)", () => {
    const p = pa({ batter_id: "P2", result: "HR", pinch_runner: { type: "pinch_runner", runner_id: "P9", for_base: "2" } });
    expect(deriveScorers(base, p)).toEqual(["P9", "P2"]);
  });

  it("R3: 置換された元走者は『消えた走者』として誤検知しない", () => {
    const d = doc({
      home_away: "away",
      plate_appearances: [
        pa({ inning: 1, half: "top", order: 1, batter_id: "P1", result: "H2" }), // P1が二塁へ
        pa({
          inning: 1, half: "top", order: 2, batter_id: "P2", result: "OUT",
          pinch_runner: { type: "pinch_runner", runner_id: "P9", for_base: "2" },
        }),
      ],
    });
    expect(validateGame(d).filter((f) => f.rule === "R3")).toHaveLength(0);
  });
});

describe("outsMade: 併殺/三重殺/AUTO_OUT(§10.3)", () => {
  it("併殺フラグは守備out記録が1件でも最低2アウトを保証", () => {
    const p = pa({
      result: "OUT", double_play: true,
      fielding: { hit_to: "6", sequence: ["6", "4", "3"], outs: [{ at: "1", type: "force" }], errors: [] },
    });
    expect(outsMade(p)).toBe(2);
  });
  it("三重殺フラグは最低3アウト", () => {
    const p = pa({ result: "OUT", triple_play: true, fielding: { hit_to: "6", sequence: [], outs: [], errors: [] } });
    expect(outsMade(p)).toBe(3);
  });
  it("AUTO_OUT(自動アウト枠)は1アウト", () => {
    expect(outsMade(pa({ result: "AUTO_OUT" }))).toBe(1);
  });
});
