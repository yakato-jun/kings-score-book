import { describe, it, expect } from "vitest";
import { validateGame, applyValidation, unresolvedUnclear } from "../ops/validate";
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

describe("[クラスタB1] 四死球で盤面不在の走者の明示生還は保持され R1 が食い違いをflag", () => {
  it("BB + after で盤面に居ない走者の生還を主張 → runs保持しR1が発火(黙って消さない)", () => {
    // 先頭打席=開始時走者なし。四球なのに after で P3 の生還を明示(盤面に P3 は不在=矛盾)。
    // deriveRuns は fill で保持 → pa.runs に P3。deriveScorers は onBoard 維持で 0 → 食い違いを R1 が surface。
    const d = game([
      pa({
        inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "BB",
        baserunning_after: [{ runner_id: "P3", from: "3", to: "home" }],
        runs: [{ runner_id: "P3", rbi: false, earned: null, cause: "other", origin: "auto" }],
      }),
    ]);
    expect(validateGame(d).some((f) => f.rule === "R1")).toBe(true);
  });
});

describe("R3 走者保存則: 塁上の走者はアウト・得点以外で消えない", () => {
  it("FCで押し出された一塁走者のアウト記録漏れ→消えた走者として検出", () => {
    // P1が一塁→P2がFC。記録上アウトも得点もないのに盤面でP1が上書きされて消える。
    const d = details([
      onFirst("P1", 1),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "FC" }),
    ]);
    expect(d).toContain("一塁走者が消えました（塁上・得点・アウト・代走置換のいずれにも記録がありません）");
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

describe("[内部コード非露出] validateGame/applyValidation は nameOf 注入で detail を名前に(未注入=IDへフォールバック)", () => {
  // R6: 同一マスタ選手を2参加者が指す → detail に選手ID(P1)が出るケースで名前解決を検証する。
  const dupDoc = () =>
    doc({
      home_away: "away",
      lineup_snapshots: [],
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m2", link: { kind: "roster", player_id: "P1" } },
      ],
      plate_appearances: [pa({ inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" })],
    });
  const nameOf = (id: string) => (id === "P1" ? "一山" : id);

  it("未注入なら従来どおりID(P1)を出す＝純ロジックテストの挙動不変", () => {
    const f = validateGame(dupDoc()).find((x) => x.rule === "R6");
    expect(f?.detail).toContain("P1");
    expect(f?.detail).not.toContain("一山");
  });
  it("nameOf注入で名前(一山)を出し、内部コード(P1)を出さない", () => {
    const f = validateGame(dupDoc(), nameOf).find((x) => x.rule === "R6");
    expect(f?.detail).toContain("一山");
    expect(f?.detail).not.toContain("P1");
  });
  it("applyValidation も nameOf を validateGame へ渡す(保存注記が名前入り)", () => {
    const out = applyValidation(dupDoc(), nameOf);
    const r6 = out.plate_appearances.flatMap((p) => p.annotations ?? []).find((a) => a.rule === "R6");
    expect(r6?.source).toBe("validator");
    expect(r6?.detail).toContain("一山");
    expect(r6?.detail).not.toContain("P1");
  });
  it("R2(未登録参照)は名前解決できない前提＝nameOf注入でも生の参照トークン(ZZZ)を出す", () => {
    const d = game([pa({ inning: 1, half: "bottom", order: 1, batter_id: "ZZZ", result: "OUT" })]);
    const f = validateGame(d, (id) => `名前:${id}`).find((x) => x.rule === "R2");
    expect(f?.detail).toContain("ZZZ"); // R2はIDのまま(解決の術が無い)
  });
});

describe("R4 グローバル得点アンカー: 導出総得点と申告スコアの突合", () => {
  // away=自軍top。1回表に自軍1点。
  const withScore = (our: number, their: number) =>
    doc({
      home_away: "away",
      game: { id: "GTEST", date: "2026-01-01", opponent: "T", league: null, home_away: "away", result: { our_score: our, their_score: their, outcome: "win", decided_by: "regulation" } },
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

describe("R5 打順連続性: 同一打者の連続打席を検出(承認でスキップ)", () => {
  it("同じ打者が連続して打席に立つ→打順ズレの疑いで検出", () => {
    const flags = validateGame(game([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "K" }),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "K" }),
      pa({ inning: 2, half: "bottom", order: 1, batter_id: "P2", result: "K" }), // 1裏#2 P2 の直後に 2裏#1 P2 = 連続
    ]));
    const r5 = flags.filter((f) => f.rule === "R5");
    expect(r5).toHaveLength(1);
    expect(r5[0]).toMatchObject({ inning: 2, half: "bottom", order: 1 });
  });

  it("承認(rule:R5)すれば検出しない", () => {
    const flags = validateGame(game([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "K" }),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "K" }),
      pa({ inning: 2, half: "bottom", order: 1, batter_id: "P2", result: "K",
        annotations: [{ type: "resolved", source: "manual", detail: "特別ルールで2回打席", rule: "R5" }] }),
    ]));
    expect(flags.filter((f) => f.rule === "R5")).toHaveLength(0);
  });
});

describe("rule-keyed 解決: 承認はルール単位で効く / AIは打席単位", () => {
  it("R3だけ承認すると R3 は消えるが同打席の R2 は残る", () => {
    const flags = validateGame(game([
      onFirst("P1", 1),
      // FCでP1が消える(R3) かつ 未登録打者ZZZ(R2)。R3だけ承認。
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "ZZZ", result: "FC",
        annotations: [{ type: "resolved", source: "manual", detail: "特別ルール", rule: "R3" }] }),
    ]));
    const rules = flags.filter((f) => f.order === 2).map((f) => f.rule);
    expect(rules).toContain("R2"); // 承認していないR2は残る
    expect(rules).not.toContain("R3"); // 承認したR3は消える
  });

  it("AI由来(rule無し)の承認は打席単位で要確認から外れる", () => {
    const p = pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "H1",
      annotations: [
        { type: "unclear", source: "ai", detail: "ヒットかエラーか不明" },
        { type: "resolved", source: "manual", detail: "確認済み" }, // rule無し=AI承認
      ] });
    expect(unresolvedUnclear(p)).toEqual([]);
  });

  it("rule無し(AI)承認は validator のフラグは消さない", () => {
    const flags = validateGame(game([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "ZZZ", result: "H1",
        baserunning_after: [{ runner_id: "ZZZ", from: null, to: "1" }],
        annotations: [{ type: "resolved", source: "manual", detail: "AI承認(rule無し)" }] }),
    ]));
    expect(flags.map((f) => f.rule)).toContain("R2");
  });
});

describe("R9 守備完全性: 投手不在・同守備位置重複を検出(自軍守備halfのみ・承認でスキップ)", () => {
  // away=自軍top(打)/bottom(守)。守備half=bottomの相手打席時点の有効スナップショットを検査する。
  const defGame = (lineup: [number | null, string, string][], pas: PlateAppearance[]) =>
    doc({
      home_away: "away",
      lineup_snapshots: [snap(lineup, { effective_from: { inning: 1, half: "bottom", before_order: null } })],
      plate_appearances: pas,
    });
  const oppPA = (order = 1) => pa({ inning: 1, half: "bottom", order, batter_id: `o${order}`, opponent_slot: order, result: "OUT" });
  const noPitcher = LINEUP.filter(([, pos]) => pos !== "1"); // 投手(pos1)を外した中間状態

  it("投手(守備位置1)が不在ならR9", () => {
    const r9 = validateGame(defGame(noPitcher, [oppPA(1)])).filter((f) => f.rule === "R9");
    expect(r9).toHaveLength(1);
    expect(r9[0].detail).toContain("投手");
    expect(r9[0]).toMatchObject({ inning: 1, half: "bottom", order: 1 });
  });

  it("同一守備位置に2人配置ならR9(位置を明示)", () => {
    // P3を左(7)→三塁(5)へ動かしP5(5)と重複させる(交代を途中でやめた中間状態)
    const dup = LINEUP.map(([o, pos, pid]) => (pid === "P3" ? [o, "5", pid] : [o, pos, pid]) as [number | null, string, string]);
    const r9 = validateGame(defGame(dup, [oppPA(1)])).filter((f) => f.rule === "R9");
    expect(r9).toHaveLength(1);
    expect(r9[0].detail).toContain("守備位置5");
  });

  it("正常な守備配置(1..9+DH)ではR9は付かない", () => {
    expect(validateGame(defGame(LINEUP, [oppPA(1)])).some((f) => f.rule === "R9")).toBe(false);
  });

  it("承認(rule:R9)すればスキップ", () => {
    const paR = pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", opponent_slot: 1, result: "OUT",
      annotations: [{ type: "resolved", source: "manual", detail: "特別ルール", rule: "R9" }] });
    expect(validateGame(defGame(noPitcher, [paR])).some((f) => f.rule === "R9")).toBe(false);
  });

  it("相手守備(自軍攻撃half=top)の配置は対象外(自軍守備halfに打席が無ければ検査しない)", () => {
    const topPA = pa({ inning: 1, half: "top", order: 1, batter_id: "P2", result: "OUT" });
    expect(validateGame(defGame(noPitcher, [topPA])).some((f) => f.rule === "R9")).toBe(false);
  });
});

describe("R10 半イニングのアウト数>3: 打席結果の誤読(エラー出塁→OUT転記)の網(承認でスキップ)", () => {
  // 数えは outsMade(結果コード由来の打者アウト+DP/TP+走塁アウト)の累積=エンジンと同一。3未満は入力途中=正常。
  const out = (order: number, batter: string, over: Partial<PlateAppearance> = {}) =>
    pa({ inning: 1, half: "bottom", order, batter_id: batter, result: "OUT", ...over });

  it("5アウト(K,K,OUT,OUT,OUT)→R10が1件だけ、4個目のアウトの打席(order4)に付く", () => {
    const flags = validateGame(game([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "K" }),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "K" }),
      out(3, "P3"), out(4, "P4"), out(5, "P5"),
    ]));
    const r10 = flags.filter((f) => f.rule === "R10");
    expect(r10).toHaveLength(1);
    expect(r10[0]).toMatchObject({ inning: 1, half: "bottom", order: 4 });
    expect(r10[0].detail).toContain("アウト数(5)");
  });

  it("3アウトちょうどは検出しない", () => {
    const flags = validateGame(game([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "K" }),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "K" }),
      out(3, "P3"),
    ]));
    expect(flags.filter((f) => f.rule === "R10")).toHaveLength(0);
  });

  it("1アウトで途切れた入力途中は検出しない(部分入力は第一級)", () => {
    expect(validateGame(game([out(1, "P1")])).filter((f) => f.rule === "R10")).toHaveLength(0);
  });

  it("承認(resolved rule:R10)すればスキップ", () => {
    const flags = validateGame(game([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "K" }),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "K" }),
      out(3, "P3"),
      out(4, "P4", { annotations: [{ type: "resolved", source: "manual", detail: "特別ルールで4アウト", rule: "R10" }] }),
      out(5, "P5"),
    ]));
    expect(flags.filter((f) => f.rule === "R10")).toHaveLength(0);
  });

  it("double_playを含む数え: OUT+DP=3アウトはOK、もう1アウト足すとR10(アンカー=4個目の打席)", () => {
    const ok = validateGame(game([
      out(1, "P1"),
      out(2, "P2", { double_play: true }), // DP=2アウト→計3=正常
    ]));
    expect(ok.filter((f) => f.rule === "R10")).toHaveLength(0);

    const ng = validateGame(game([
      out(1, "P1"),
      out(2, "P2", { double_play: true }), // ここまで累積3
      out(3, "P3"), // 4個目のアウト
    ]));
    const r10 = ng.filter((f) => f.rule === "R10");
    expect(r10).toHaveLength(1);
    expect(r10[0]).toMatchObject({ inning: 1, half: "bottom", order: 3 });
    expect(r10[0].detail).toContain("アウト数(4)");
  });
});

describe("R11 状態記載(stated_*)と導出盤面の突合: 記載が転記された時だけ動く(§14.1 研究A)", () => {
  // 数えはエンジン再利用(outsMadeの累積・foldRunnersの盤面)。記載の無い打席では完全無発火。
  const r11 = (pas: PlateAppearance[]) => validateGame(game(pas)).filter((f) => f.rule === "R11");

  it("実誤読の再現: エラー出塁をOUTと誤転記(K,K,OUT)+記載(二死・走者二塁)→アウト・走者の両不一致が1フラグ", () => {
    const flags = r11([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "K" }),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "K" }),
      // 実際はE(出塁して二塁へ)だが OUT と誤転記。記載(stated)はノートのまま=2アウト・走者二塁。
      pa({ inning: 1, half: "bottom", order: 3, batter_id: "P3", result: "OUT", stated_outs: 2, stated_runners: ["2"] }),
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ inning: 1, half: "bottom", order: 3 });
    expect(flags[0].detail).toBe("記載の状態(二死・走者二塁)と導出した盤面(三死・走者なし)が一致しません（転記の誤読または走者移動の記録漏れの疑い）");
  });

  it("正しい転記(E+二塁到達+記載一致)→発火しない", () => {
    const flags = r11([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "K" }),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "K" }),
      pa({ inning: 1, half: "bottom", order: 3, batter_id: "P3", result: "E",
        baserunning_after: [{ runner_id: "P3", from: "1", to: "2" }], stated_outs: 2, stated_runners: ["2"] }),
    ]);
    expect(flags).toEqual([]);
  });

  it("stated無しの打席のみ→一切発火しない(既存ノートで完全無変化)", () => {
    const flags = r11([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "K" }),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "K" }),
      pa({ inning: 1, half: "bottom", order: 3, batter_id: "P3", result: "OUT" }),
    ]);
    expect(flags).toEqual([]);
  });

  it("stated_runners:[](走者なしと記載) vs 盤面に走者あり→発火。省略(記載なし)なら発火しない=区別", () => {
    // 単打でP1が一塁に居るのに「走者なし」と記載=不一致。
    const stated = r11([pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "H1", stated_runners: [] })]);
    expect(stated).toHaveLength(1);
    expect(stated[0].detail).toContain("記載の状態(走者なし)");
    expect(stated[0].detail).toContain("導出した盤面(走者一塁)");
    // 同じ盤面でも省略(記載なし)なら発火しない。
    expect(r11([pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "H1" })])).toEqual([]);
  });

  it("片方のみ記載(stated_outsのみ不一致)→detailはアウトのみ言及", () => {
    const flags = r11([pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "K", stated_outs: 2 })]);
    expect(flags).toHaveLength(1);
    // 完全一致=状態表記に走者が入らない(固定の但し書き「走者移動の記録漏れ」は文言の一部)。
    expect(flags[0].detail).toBe("記載の状態(二死)と導出した盤面(一死)が一致しません（転記の誤読または走者移動の記録漏れの疑い）");
  });

  it("承認(resolved rule:R11)すればスキップ", () => {
    const flags = r11([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "K", stated_outs: 2,
        annotations: [{ type: "resolved", source: "manual", detail: "記載側の誤記と確認", rule: "R11" }] }),
    ]);
    expect(flags).toEqual([]);
  });

  it("満塁表記([\"1\",\"2\",\"3\"])が導出盤面(満塁)と一致→発火しない", () => {
    const flags = r11([
      onFirst("P1", 1),
      pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "BB" }),
      // 連続四球の強制進塁はエンジンが自動で畳む=この打席後は満塁。記載も満塁で一致。
      pa({ inning: 1, half: "bottom", order: 3, batter_id: "P3", result: "BB", stated_runners: ["1", "2", "3"] }),
    ]);
    expect(flags).toEqual([]);
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
