import { describe, it, expect } from "vitest";
import { battingGrid, displayLineup, roleLabel, paResultLabel } from "../lineup";
import { pa, snap } from "./fixtures";

describe("打席結果ラベル(構造化フィールドのみ)", () => {
  it("方向あり: hit_to/hit_type から短縮", () => {
    expect(paResultLabel({ result: "OUT", fielding: { hit_to: "8", hit_type: "F" } }).text).toBe("中飛");
    expect(paResultLabel({ result: "H2", fielding: { hit_to: "9" } }).text).toBe("右二");
    expect(paResultLabel({ result: "K", fielding: null }).text).toBe("三振");
  });
  it("方向なし: フル語へ救済(noteは見ない)", () => {
    expect(paResultLabel({ result: "HR", fielding: null }).text).toBe("本塁打");
    expect(paResultLabel({ result: "H2", fielding: null }).text).toBe("二塁打");
  });
  it("打点ありは rbi=true", () => {
    expect(paResultLabel({ result: "H1", fielding: { hit_to: "7" }, runs: [{ rbi: true }] }).rbi).toBe(true);
  });
});

describe("回別グリッドは打順入れ替えに非依存(batter×回でキー)", () => {
  it("4番↔5番を一時入れ替えても各打者の打席は正しい回に入る", () => {
    const pas = [
      pa({ inning: 1, half: "top", batter_id: "P9", batting_slot: 4, result: "H1", fielding: { hit_to: "7", hit_type: "L", sequence: ["7"], outs: [], errors: [] } }),
      pa({ inning: 1, half: "top", batter_id: "P12", batting_slot: 5, result: "K" }),
      // 3回は打順入れ替え: P12が4番, P9が5番
      pa({ inning: 3, half: "top", batter_id: "P12", batting_slot: 4, result: "H2", fielding: { hit_to: "8", hit_type: "L", sequence: ["8"], outs: [], errors: [] } }),
      pa({ inning: 3, half: "top", batter_id: "P9", batting_slot: 5, result: "OUT", fielding: { hit_to: "6", hit_type: "G", sequence: ["6", "3"], outs: [{ at: "1", type: "force" }], errors: [] } }),
    ];
    const grid = battingGrid(pas, "top");
    expect(grid.get("P9")?.get(1)?.[0].text).toBe("左安");
    expect(grid.get("P9")?.get(3)?.[0].text).toBe("遊ゴロ");
    expect(grid.get("P12")?.get(1)?.[0].text).toBe("三振");
    expect(grid.get("P12")?.get(3)?.[0].text).toBe("中二");
  });
});

describe("displayLineup: 投手/代打/代走 の役割", () => {
  it("DH非解除の投手は打順null=末尾、roleLabel=投", () => {
    const start = snap([[1, "6", "P1"], [2, "2", "P2"], [9, "DH", "P9"], [null, "1", "PP"]]);
    const rows = displayLineup([start], new Set(), new Set());
    const last = rows[rows.length - 1];
    expect([last.player_id, last.slot, roleLabel(last)]).toEqual(["PP", null, "投"]);
  });
  it("代打(先発外で打席あり)は roleLabel=打/位置", () => {
    const start = snap([[9, "DH", "P9"], [null, "1", "PP"]]);
    const sub = snap([[9, "9", "P3"], [null, "1", "PP"]], { seq: 1, snapshot_id: "GTEST-NK-01", effective_from: { inning: 5, half: "top", before_order: 9 }, reason: "substitution" });
    const rows = displayLineup([start, sub], new Set(), new Set(["P3"]));
    const ph = rows.find((r) => r.player_id === "P3")!;
    expect([ph.role, roleLabel(ph)]).toEqual(["pinch_hitter", "打/右"]);
  });
  it("代走は roleLabel=走", () => {
    const start = snap([[3, "5", "P5"], [null, "1", "PP"]]);
    const sub = snap([[3, "5", "P3"], [null, "1", "PP"]], { seq: 1, snapshot_id: "GTEST-NK-01", effective_from: { inning: 6, half: "top", before_order: 3 }, reason: "substitution" });
    const rows = displayLineup([start, sub], new Set(["P3"]), new Set());
    const pr = rows.find((r) => r.player_id === "P3")!;
    expect([pr.role, roleLabel(pr)]).toEqual(["pinch_runner", "走/三"]);
  });
});
