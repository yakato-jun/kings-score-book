import { describe, it, expect } from "vitest";
import { validateGame, repairGame, applyValidation } from "../ops/validate";
import { reduceChangeDefense } from "../ops/games";
import { doc, pa, snap, LINEUP } from "./fixtures";
import type { PlateAppearance } from "../types/v2";

// home=自軍bottom の half に打席を並べた doc を作る薄いラッパ
const game = (pas: PlateAppearance[]) =>
  doc({
    home_away: "home",
    lineup_snapshots: [snap(LINEUP, { effective_from: { inning: 1, half: "bottom", before_order: null } })],
    plate_appearances: pas,
  });
const onFirst = (id: string, order = 1) =>
  pa({ inning: 1, half: "bottom", order, batter_id: id, result: "H1", baserunning_after: [{ runner_id: id, from: null, to: "1" }] });
const details = (pas: PlateAppearance[]) => validateGame(game(pas)).map((f) => f.detail);

describe("R3 走者保存則: 塁上の走者はアウト・得点以外で消えない", () => {
  it("FCで押し出された一塁走者のアウト記録漏れ→消えた走者として検出", () => {
    // P1が一塁→P2がFC。記録上アウトも得点もないのに盤面でP1が上書きされて消える。
    const d = details([
      onFirst("P1", 1),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "FC" }),
    ]);
    expect(d).toContain("一塁走者が消えました（塁上・得点・アウトのいずれにも記録がありません）");
  });

  it("FCで押し出された走者をアウトとして記録すれば検出しない", () => {
    const d = details([
      onFirst("P1", 1),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "FC", baserunning_after: [{ runner_id: "P1", from: "1", to: "out" }] }),
    ]);
    expect(d).toEqual([]);
  });

  it("守備のアウト記録(fielding.outs)でも検出しない", () => {
    const d = details([
      onFirst("P1", 1),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "FC", fielding: { hit_to: "6", sequence: [], outs: [{ at: "2", type: "force", runner_id: "P1" }], errors: [] } }),
    ]);
    expect(d).toEqual([]);
  });

  it("通常の進塁(走者が二塁へ)は誤検知しない", () => {
    const d = details([
      onFirst("P1", 1),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "H1", baserunning_after: [{ runner_id: "P1", from: "1", to: "2" }, { runner_id: "P2", from: null, to: "1" }] }),
    ]);
    expect(d).toEqual([]);
  });

  it("生還(本塁打)は消えた扱いにしない", () => {
    const d = details([
      onFirst("P1", 1),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "HR", runs: [
        { runner_id: "P1", rbi: true, earned: true, cause: "hr" },
        { runner_id: "P2", rbi: true, earned: true, cause: "hr" },
      ] }),
    ]);
    expect(d).toEqual([]);
  });

  it("半イニング終了時に塁に残った走者(残塁)は消えた扱いにしない", () => {
    const d = details([onFirst("P1", 1)]); // 1人だけ出塁してそのまま終了=残塁
    expect(d).toEqual([]);
  });

  it("代走置換(pinch_runner)のある打席は対象外(誤検知回避)", () => {
    const d = details([
      onFirst("P1", 1),
      // P1をP2へ代走。盤面に代走は未モデルなのでP1が消えるが、pinch_runner があれば検査しない。
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P3", result: "OUT", pinch_runner: { type: "pinch", runner_id: "P2" } }),
    ]);
    expect(d).toEqual([]);
  });
});

describe("R1/R2 既存ルールは維持", () => {
  it("R1: 満塁押し出しを得点に記録しないと不一致を検出", () => {
    const loaded = [
      onFirst("P1", 1),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "BB", baserunning_after: [{ runner_id: "P1", from: "1", to: "2" }] }),
      pa({ inning: 1, half: "bottom", order: 3, batter_id: "P3", result: "BB", baserunning_after: [{ runner_id: "P1", from: "2", to: "3" }, { runner_id: "P2", from: "1", to: "2" }] }),
      // 満塁で四球→三塁走者P1が押し出されて生還するはずだが runs を空にしておく
      pa({ inning: 1, half: "bottom", order: 4, batter_id: "P4", result: "BB", runs: [] }),
    ];
    const d = details(loaded);
    expect(d.some((x) => x.startsWith("得点数"))).toBe(true);
  });

  it("R2: 未登録IDを検出", () => {
    const d = details([pa({ inning: 1, half: "bottom", order: 1, batter_id: "ZZZ", result: "OUT" })]);
    expect(d.some((x) => x.includes("未登録の選手ID"))).toBe(true);
  });
});

describe("R4 グローバル得点アンカー: 導出総得点と申告スコアの突合", () => {
  // away=自軍top。1回表に自軍1点。
  const withScore = (our: number, their: number) =>
    doc({
      home_away: "away",
      game: { id: "GTEST", date: "2026-01-01", opponent: "T", league: null, home_away: "away", dh: false, result: { our_score: our, their_score: their, outcome: "win", decided_by: "regulation" } },
      plate_appearances: [
        pa({ inning: 1, half: "top", order: 1, batter_id: "P1", result: "HR", runs: [{ runner_id: "P1", rbi: true, earned: true, cause: "hr" }] }),
      ],
    });

  it("導出1点=申告1点なら検出しない", () => {
    expect(validateGame(withScore(1, 0)).some((f) => f.detail.includes("総得点"))).toBe(false);
  });
  it("申告が導出より多い(取りこぼし)を検出", () => {
    const f = validateGame(withScore(2, 0)).find((x) => x.detail.includes("自軍の総得点"));
    expect(f?.detail).toContain("導出1");
    expect(f?.detail).toContain("申告スコア(2)");
  });
  it("相手スコア不一致も検出", () => {
    expect(validateGame(withScore(1, 3)).some((f) => f.detail.includes("相手の総得点"))).toBe(true);
  });
  it("result未設定なら照合しない", () => {
    const d = doc({ home_away: "away", plate_appearances: [pa({ inning: 1, half: "top", order: 1, batter_id: "P1", result: "HR", runs: [{ runner_id: "P1", rbi: true, earned: true, cause: "hr" }] })] });
    expect(validateGame(d).some((f) => f.detail.includes("総得点"))).toBe(false);
  });
});

describe("repairGame: 決定的に直せる取りこぼしだけ自動修復", () => {
  const game = (our: number, pas: PlateAppearance[]) =>
    doc({
      home_away: "home",
      game: { id: "GTEST", date: "2026-01-01", opponent: "T", league: null, home_away: "home", dh: false, result: { our_score: our, their_score: 0, outcome: "win", decided_by: "regulation" } },
      lineup_snapshots: [snap(LINEUP, { effective_from: { inning: 1, half: "bottom", before_order: null } })],
      plate_appearances: pas,
    });
  // 3四球で満塁(三塁=P1)→ 単打。得点記録漏れ(runs空)で押し出しP1が消える。申告1点。
  const loaded = (last: Partial<PlateAppearance>) => [
    pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "BB" }),
    pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "BB" }),
    pa({ inning: 1, half: "bottom", order: 3, batter_id: "P3", result: "BB" }),
    pa({ inning: 1, half: "bottom", order: 4, batter_id: "P4", result: "H1", runs: [], ...last }),
  ];

  it("満塁単打で押し出し走者が消え・申告が1点不足→その走者の生還を補完", () => {
    const d = repairGame(game(1, loaded({})));
    const h1 = d.plate_appearances.find((p) => p.order === 4)!;
    expect(h1.runs.map((r) => r.runner_id)).toEqual(["P1"]); // 三塁走者P1が押し出されて生還
    expect(h1.runs[0].rbi).toBe(true);
    expect((h1.annotations ?? []).some((a) => a.detail.includes("自動補完"))).toBe(true);
  });

  it("修復後にバリデータが再フラグしない・修復注記がapplyValidationで残る", () => {
    const repaired = repairGame(game(1, loaded({})));
    // R1(得点数 vs 生還者)もR3(走者消失)もR4(総得点)も解消されている
    expect(validateGame(repaired)).toEqual([]);
    // 自動補完の注記(source:repair)は applyValidation で消えない
    const after = applyValidation(repaired);
    const h1 = after.plate_appearances.find((p) => p.order === 4)!;
    expect((h1.annotations ?? []).some((a) => a.source === "repair" && a.detail.includes("自動補完"))).toBe(true);
  });

  it("申告と一致しているなら修復しない(過剰修復しない)", () => {
    // 申告0点なら不足が無いので補完しない
    const d = repairGame(game(0, loaded({})));
    expect(d.plate_appearances.find((p) => p.order === 4)!.runs).toEqual([]);
  });

  it("満塁でない/FORCE結果でないなら対象外", () => {
    const d = repairGame(game(1, [
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "H1", baserunning_after: [{ runner_id: "P1", from: null, to: "1" }] }),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "OUT" }),
    ]));
    expect(d.plate_appearances.every((p) => (p.runs?.length ?? 0) === 0)).toBe(true);
  });
});

describe("reduceChangeDefense: 守備位置変更はスタメンを消さず位置だけ差し替える", () => {
  // away=自軍top。守備=bottom(相手の攻撃)。
  const base = () => doc({ home_away: "away" }); // seq0 LINEUP: PP=投1, P2=捕2, ...

  it("該当選手の位置だけ替え、他の9人は残る(全置換しない)", () => {
    const d = reduceChangeDefense(base(), "GTEST", [
      { player_id: "PP", to_position: "5" }, // 投手→三塁
      { player_id: "P5", to_position: "1" }, // 三塁→投手
    ], { inning: 5, half: "bottom" });
    expect(d.lineup_snapshots).toHaveLength(2);
    const s1 = d.lineup_snapshots[1];
    expect(s1.seq).toBe(1);
    expect(s1.lineup).toHaveLength(LINEUP.length); // 全員残っている
    const pos = new Map(s1.lineup.map((l) => [l.player_id, l.position_id]));
    expect(pos.get("PP")).toBe("5");
    expect(pos.get("P5")).toBe("1");
    expect(pos.get("P2")).toBe("2"); // 無関係の選手は不変
    expect(s1.effective_from).toEqual({ inning: 5, half: "bottom", before_order: null });
  });

  it("from_position(『2->5』表記)で対象を解決できる", () => {
    const d = reduceChangeDefense(base(), "GTEST", [{ from_position: "2", to_position: "5" }], { inning: 3, half: "bottom" });
    const pos = new Map(d.lineup_snapshots[1].lineup.map((l) => [l.player_id, l.position_id]));
    expect(pos.get("P2")).toBe("5"); // 捕手(pos2=P2)が三塁へ
  });

  it("3者スワップでも崩れない(base に対して先に解決)", () => {
    const d = reduceChangeDefense(base(), "GTEST", [
      { from_position: "1", to_position: "5" }, // 投→三
      { from_position: "5", to_position: "3" }, // 三→一
      { from_position: "3", to_position: "1" }, // 一→投
    ], { inning: 7, half: "bottom" });
    const pos = new Map(d.lineup_snapshots[1].lineup.map((l) => [l.player_id, l.position_id]));
    expect(pos.get("PP")).toBe("5"); // 旧投手
    expect(pos.get("P5")).toBe("3"); // 旧三塁
    expect(pos.get("P6")).toBe("1"); // 旧一塁(LINEUP: P6=一3)
  });
});
