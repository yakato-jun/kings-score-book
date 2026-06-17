import { describe, it, expect } from "vitest";
import { foldRunners, deriveNextPA, gameState, kingsBatHalf, lineupSlots, resolvePATarget, derivePAStates, deriveScorers, resolveBaserunningIds, deriveRuns } from "../ops/gamestate";
import { doc, pa, snap, LINEUP } from "./fixtures";
import type { Runners, BaserunMove } from "../types/v2";

const EMPTY: Runners = { first: null, second: null, third: null };

describe("resolveBaserunningIds: runner_id 省略時は from塁の走者で確定(AIはfrom/toだけ渡せばよい)", () => {
  it("after の runner_id 省略 → from塁の在塁者で埋める(非強制の結果)", () => {
    // OUT(ゴロ)で走者が進む。強制進塁(applyForce)が走らないので from塁=元の走者。
    const start = { first: "P1", second: null, third: "P3" };
    const p = pa({ batter_id: "P2", result: "OUT", baserunning_after: [{ from: "1", to: "2" }, { from: "3", to: "home" }] as BaserunMove[] });
    const r = resolveBaserunningIds(start, p);
    expect(r.baserunning_after.map((m) => m.runner_id)).toEqual(["P1", "P3"]);
  });
  it("during(盗塁)の runner_id 省略 → from塁の在塁者で埋める", () => {
    const start = { first: "P1", second: null, third: null };
    const p = pa({ batter_id: "P2", result: "OUT", baserunning_during: [{ event: "SB", runners: [{ from: "1", to: "2" }] as BaserunMove[] }] });
    const r = resolveBaserunningIds(start, p);
    expect(r.baserunning_during?.[0].runners?.[0].runner_id).toBe("P1");
  });
});

describe("kingsBatHalf / lineupSlots", () => {
  it("away=先攻=top, home=後攻=bottom, 不明=top", () => {
    expect(kingsBatHalf(doc({ home_away: "away" }))).toBe("top");
    expect(kingsBatHalf(doc({ home_away: "home" }))).toBe("bottom");
    expect(kingsBatHalf(doc({ home_away: null }))).toBe("top");
  });
  it("打順スロットは order!=null を昇順で(投手DHは除外)", () => {
    const slots = lineupSlots(doc({ home_away: "away" }));
    expect(slots.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(slots.map((s) => s.player_id)).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]);
  });
});

describe("foldRunners は結果から走者を導出(四球で打者が出る・押し出し)", () => {
  const bb = (id: string) => pa({ batter_id: id, result: "BB" });
  it("四球で打者が一塁に出る(afterが空でも)", () => {
    expect(foldRunners(EMPTY, bb("B1"))).toEqual({ first: "B1", second: null, third: null });
  });
  it("連続四球で前の走者が押し出される", () => {
    let r = foldRunners(EMPTY, bb("B1"));
    r = foldRunners(r, bb("B2"));
    expect(r).toEqual({ first: "B2", second: "B1", third: null });
    r = foldRunners(r, bb("B3"));
    expect(r).toEqual({ first: "B3", second: "B2", third: "B1" }); // 満塁
  });
  it("満塁四球は三塁走者が押し出されて生還(塁から消える)", () => {
    const loaded = { first: "B3", second: "B2", third: "B1" };
    expect(foldRunners(loaded, pa({ batter_id: "B4", result: "BB" }))).toEqual({ first: "B4", second: "B3", third: "B2" });
  });
  it("死球も同様に強制進塁", () => {
    expect(foldRunners({ first: "X", second: null, third: null }, pa({ batter_id: "Y", result: "HBP" }))).toEqual({ first: "Y", second: "X", third: null });
  });
  it("本塁打は全員生還(塁が空く)", () => {
    expect(foldRunners({ first: "X", second: "Z", third: null }, pa({ batter_id: "B", result: "HR" }))).toEqual(EMPTY);
  });
  it("凡退/三振は走者そのまま", () => {
    const r = { first: "X", second: null, third: null };
    expect(foldRunners(r, pa({ batter_id: "B", result: "OUT" }))).toEqual(r);
  });
});

describe("deriveScorers: 誰が還ったかをエンジンが導出(得点者の取り違え排除)", () => {
  const loaded = { first: "A", second: "B", third: "C" };
  it("満塁四球は三塁走者(C)が押し出されて生還", () => {
    expect(deriveScorers(loaded, pa({ batter_id: "D", result: "BB" }))).toEqual(["C"]);
  });
  it("満塁死球も三塁走者が生還", () => {
    expect(deriveScorers(loaded, pa({ batter_id: "D", result: "HBP" }))).toEqual(["C"]);
  });
  it("満塁でない四球は得点者なし(押し出されない)", () => {
    expect(deriveScorers({ first: "A", second: "B", third: null }, pa({ batter_id: "D", result: "BB" }))).toEqual([]);
  });
  it("本塁打は塁上＋打者が全員生還", () => {
    expect(deriveScorers({ first: "A", second: null, third: "C" }, pa({ batter_id: "D", result: "HR" }))).toEqual(["C", "A", "D"]);
  });
  it("パスボール(during)で本塁到達した走者", () => {
    const p = pa({ batter_id: "D", result: "BB", baserunning_during: [{ event: "PB", runners: [{ runner_id: "C", from: "3", to: "home" }] }] });
    expect(deriveScorers({ first: null, second: "B", third: "C" }, p)).toEqual(["C"]);
  });
  it("安打での明示生還(after)も拾う", () => {
    const p = pa({ batter_id: "D", result: "H1", baserunning_after: [{ runner_id: "C", from: "3", to: "home" }] });
    expect(deriveScorers({ first: null, second: null, third: "C" }, p)).toEqual(["C"]);
  });
});

describe("deriveRuns: runs[](得点・打点・自責)をエンジンが導出する(AIは出さない)", () => {
  it("安打での生還は rbi=true・cause=hit", () => {
    const r = deriveRuns({ first: null, second: null, third: "C" }, pa({ batter_id: "D", result: "H1", baserunning_after: [{ runner_id: "C", from: "3", to: "home" }] }));
    expect(r).toEqual([{ runner_id: "C", rbi: true, earned: true, cause: "hit" }]);
  });
  it("本塁打は塁上＋打者が全員 rbi=true・cause=hr", () => {
    const r = deriveRuns({ first: "A", second: null, third: "C" }, pa({ batter_id: "D", result: "HR" }));
    expect(r.map((x) => x.runner_id)).toEqual(["C", "A", "D"]);
    expect(r.every((x) => x.rbi && x.cause === "hr")).toBe(true);
  });
  it("満塁四球の押し出しは rbi=true・cause=walk", () => {
    const r = deriveRuns({ first: "A", second: "B", third: "C" }, pa({ batter_id: "D", result: "BB" }));
    expect(r).toEqual([{ runner_id: "C", rbi: true, earned: true, cause: "walk" }]);
  });
  it("エラーでの生還は rbi=false・earned=false・cause=error", () => {
    const r = deriveRuns({ first: null, second: null, third: "C" }, pa({ batter_id: "D", result: "E", baserunning_after: [{ runner_id: "C", from: "3", to: "home" }] }));
    expect(r).toEqual([{ runner_id: "C", rbi: false, earned: false, cause: "error" }]);
  });
  it("暴投(during)での生還は rbi=false・cause=wp", () => {
    const r = deriveRuns({ first: null, second: null, third: "C" }, pa({ batter_id: "D", result: "K", baserunning_during: [{ event: "WP", runners: [{ runner_id: "C", from: "3", to: "home" }] }] }));
    expect(r).toEqual([{ runner_id: "C", rbi: false, earned: true, cause: "wp" }]);
  });
  it("0点なら空", () => {
    expect(deriveRuns({ first: "A", second: null, third: null }, pa({ batter_id: "D", result: "OUT" }))).toEqual([]);
  });
});

describe("derivePAStates: 四球ラリーの開始時走者が正しい(保存値を使わない)", () => {
  it("四球→四球→凡退→四球 の各開始時走者", () => {
    const d = doc({
      home_away: "home",
      lineup_snapshots: [snap(LINEUP, { effective_from: { inning: 1, half: "bottom", before_order: null } })],
      plate_appearances: [
        // 保存値(outs/runners)はわざと壊しておく＝導出が無視することを確認
        pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "BB", runners: { first: "ZZ", second: null, third: null } }),
        pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "BB", runners: EMPTY }),
        pa({ inning: 1, half: "bottom", order: 3, batter_id: "P3", result: "OUT", runners: EMPTY }),
        pa({ inning: 1, half: "bottom", order: 4, batter_id: "P4", result: "BB", outs: 1, runners: EMPTY }),
      ],
    });
    const st = derivePAStates(d);
    const at = (o: number) => [...st.entries()].find(([p]) => p.order === o)![1];
    expect(at(1).runners).toEqual(EMPTY); // 先頭は走者なし
    expect(at(2).runners).toEqual({ first: "P1", second: null, third: null }); // P1が一塁(導出＝保存の壊れ値ZZを無視)
    expect(at(3).runners).toEqual({ first: "P2", second: "P1", third: null }); // 一二塁
    expect([at(3).outs, at(4).outs]).toEqual([0, 1]); // アウトは保存値(正)を表示
    expect(at(4).runners).toEqual({ first: "P2", second: "P1", third: null }); // 凡退では走者不変
  });
});

describe("foldRunners", () => {
  it("打球での走者移動(after)を反映", () => {
    const r = foldRunners(EMPTY, pa({ batter_id: "P1", result: "H1", baserunning_after: [{ runner_id: "P1", from: null, to: "1" }] }));
    expect(r).toEqual({ first: "P1", second: null, third: null });
  });
  it("一塁走者が二塁へ進む(from空ける)", () => {
    const r = foldRunners({ first: "P1", second: null, third: null }, pa({
      batter_id: "P2", result: "H1",
      baserunning_after: [{ runner_id: "P1", from: "1", to: "2" }, { runner_id: "P2", from: null, to: "1" }],
    }));
    expect(r).toEqual({ first: "P2", second: "P1", third: null });
  });
  it("生還(to:home)は塁に残さない", () => {
    const r = foldRunners({ first: null, second: null, third: "P1" }, pa({
      batter_id: "P2", result: "H1",
      runs: [{ runner_id: "P1", rbi: true, earned: true, cause: "hit" }],
      baserunning_after: [{ runner_id: "P1", from: "3", to: "home" }, { runner_id: "P2", from: null, to: "1" }],
    }));
    expect(r).toEqual({ first: "P2", second: null, third: null });
  });
  it("打席中の盗塁(during)も反映", () => {
    const r = foldRunners({ first: "P1", second: null, third: null }, pa({
      batter_id: "P2", result: "OUT",
      baserunning_during: [{ event: "SB", runners: [{ runner_id: "P1", from: "1", to: "2" }] }],
    }));
    expect(r).toEqual({ first: null, second: "P1", third: null });
  });
});

describe("deriveNextPA (away=自軍top)", () => {
  it("空のイニング先頭: order1・0アウト・走者なし・1番打者", () => {
    const d = deriveNextPA(doc({ home_away: "away" }), 1, "top");
    expect([d.order, d.outs]).toEqual([1, 0]);
    expect(d.runners).toEqual(EMPTY);
    expect([d.batting_slot, d.batter_id]).toEqual([1, "P1"]);
  });
  it("1人凡退後: order2・1アウト・2番打者", () => {
    const d = deriveNextPA(doc({
      home_away: "away",
      plate_appearances: [pa({ order: 1, batter_id: "P1", result: "OUT" })],
    }), 1, "top");
    expect([d.order, d.outs, d.batting_slot, d.batter_id]).toEqual([2, 1, 2, "P2"]);
  });
  it("先頭安打後: 走者一塁・order2・0アウト", () => {
    const d = deriveNextPA(doc({
      home_away: "away",
      plate_appearances: [pa({ order: 1, batter_id: "P1", result: "H1", baserunning_after: [{ runner_id: "P1", from: null, to: "1" }] })],
    }), 1, "top");
    expect([d.order, d.outs]).toEqual([2, 0]);
    expect(d.runners).toEqual({ first: "P1", second: null, third: null });
  });
  it("打順は一巡して先頭へ戻る(9打者後は1番)", () => {
    const pas = LINEUP.filter(([o]) => o != null).map(([o, , pid], i) =>
      pa({ order: i + 1, batter_id: pid, result: "H1", baserunning_after: [] })
    );
    const d = deriveNextPA(doc({ home_away: "away", plate_appearances: pas }), 1, "top");
    expect(d.batting_slot).toBe(1);
    expect(d.batter_id).toBe("P1");
  });
  it("相手の攻撃(bottom)は O001.. を打順順に自動採番", () => {
    const d0 = deriveNextPA(doc({ home_away: "away" }), 1, "bottom");
    expect([d0.batter_id, d0.batting_slot]).toEqual(["O001", null]);
    const d1 = deriveNextPA(doc({
      home_away: "away",
      plate_appearances: [pa({ inning: 1, half: "bottom", order: 1, batter_id: "O001", result: "OUT" })],
    }), 1, "bottom");
    expect(d1.batter_id).toBe("O002");
  });
});

describe("deriveNextPA (home=自軍bottom)", () => {
  it("home: 自軍はbottomで打順、topは相手O番号", () => {
    const s = snap(LINEUP, { effective_from: { inning: 1, half: "bottom", before_order: null } });
    const d = deriveNextPA(doc({ home_away: "home", lineup_snapshots: [s] }), 1, "bottom");
    expect([d.batting_slot, d.batter_id]).toEqual([1, "P1"]);
    const dt = deriveNextPA(doc({ home_away: "home", lineup_snapshots: [s] }), 1, "top");
    expect(dt.batter_id).toBe("O001");
  });
});

describe("resolvePATarget (側で半イニングを決める・アウトでは切らない)", () => {
  // home=自軍bottom, 相手はtopで攻撃。
  const home = (pas: ReturnType<typeof pa>[]) => {
    const s = snap(LINEUP, { effective_from: { inning: 1, half: "bottom", before_order: null } });
    return doc({ home_away: "home", lineup_snapshots: [s], plate_appearances: pas });
  };
  const oppOut = (inning: number, order: number, n: number) =>
    pa({ inning, half: "top", order, batter_id: `O${String(n).padStart(3, "0")}`, result: "OUT" });

  it("打者がO…なら half未指定でも相手側(top)に解決", () => {
    expect(resolvePATarget(home([]), { batter_id: "O001" })).toEqual({ inning: 1, half: "top" });
  });
  it("自軍打者は自軍side(bottom)に解決", () => {
    expect(resolvePATarget(home([]), { batter_id: "P1" })).toEqual({ inning: 1, half: "bottom" });
  });
  it("同じ側を続けるなら同じ回に積む(3アウトでも自動で切らない＝4アウト目も1回表)", () => {
    const d = home([oppOut(1, 1, 1), oppOut(1, 2, 2), oppOut(1, 3, 3)]);
    expect(resolvePATarget(d, { half: "top", batter_id: "O004" })).toEqual({ inning: 1, half: "top" });
    expect(deriveNextPA(d, 1, "top").outs).toBe(3); // 開始時すでに3アウトでも受け入れる
  });
  it("側が替わったら新しい半イニング: 表→裏→表 で 2回表になる", () => {
    const d = home([oppOut(1, 1, 1), pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "OUT" })]);
    expect(resolvePATarget(d, { batter_id: "O002" })).toEqual({ inning: 2, half: "top" }); // 相手が再び＝2回表
    expect(resolvePATarget(d, { batter_id: "P2" })).toEqual({ inning: 1, half: "bottom" }); // 自軍継続＝1回裏
  });
  it("明示 inning/half は最優先", () => {
    expect(resolvePATarget(home([]), { inning: 5, half: "bottom", batter_id: "O001" })).toEqual({ inning: 5, half: "bottom" });
  });
});

describe("gameState", () => {
  it("空の試合: 1回表・0アウト・0-0", () => {
    const st = gameState(doc({ home_away: "away" }));
    expect([st.inning, st.half, st.outs, st.kings_score, st.opp_score, st.pa_count]).toEqual([1, "top", 0, 0, 0, 0]);
  });
  it("3アウトでも自動で先送りしない(最後の半イニングをそのまま報告)", () => {
    const st = gameState(doc({
      home_away: "away",
      plate_appearances: [
        pa({ order: 1, batter_id: "P1", result: "OUT" }),
        pa({ order: 2, batter_id: "P2", result: "OUT" }),
        pa({ order: 3, batter_id: "P3", result: "OUT" }),
      ],
    }));
    expect([st.inning, st.half, st.outs]).toEqual([1, "top", 3]);
  });
  it("半イニング途中: アウト数と走者を保持", () => {
    const st = gameState(doc({
      home_away: "away",
      plate_appearances: [
        pa({ order: 1, batter_id: "P1", result: "OUT" }),
        pa({ order: 2, batter_id: "P2", result: "H1", baserunning_after: [{ runner_id: "P2", from: null, to: "1" }] }),
      ],
    }));
    expect([st.inning, st.half, st.outs]).toEqual([1, "top", 1]);
    expect(st.runners).toEqual({ first: "P2", second: null, third: null });
  });
  it("得点はruns[]の長さで自軍/相手に振り分け", () => {
    const st = gameState(doc({
      home_away: "away",
      plate_appearances: [
        pa({ inning: 1, half: "top", order: 1, batter_id: "P1", result: "HR", runs: [{ runner_id: "P1", rbi: true, earned: true, cause: "hr" }] }),
        pa({ inning: 1, half: "bottom", order: 1, batter_id: "O001", result: "HR", runs: [{ runner_id: "O001", rbi: true, earned: true, cause: "hr" }] }),
        pa({ inning: 1, half: "bottom", order: 2, batter_id: "O002", result: "HR", runs: [{ runner_id: "O002", rbi: true, earned: true, cause: "hr" }] }),
      ],
    }));
    expect([st.kings_score, st.opp_score]).toEqual([1, 2]);
  });
});
