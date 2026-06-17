import { describe, it, expect } from "vitest";
import {
  outsLabel,
  runnersLabel,
  situationLabel,
  playLine,
  batterLabel,
  paAnchor,
  halfInnings,
  duringLines,
} from "../textlog";
import { pa, doc } from "./fixtures";

const id = (s: string) => s; // 名前未登録 → idそのまま

describe("状況ラベル", () => {
  it("アウト数", () => {
    expect(outsLabel(0)).toBe("無死");
    expect(outsLabel(1)).toBe("一死");
    expect(outsLabel(2)).toBe("二死");
  });
  it("走者", () => {
    expect(runnersLabel({ first: null, second: null, third: null })).toBe("走者なし");
    expect(runnersLabel({ first: "x", second: null, third: null })).toBe("一塁");
    expect(runnersLabel({ first: "x", second: null, third: "z" })).toBe("一三塁");
    expect(runnersLabel({ first: "x", second: "y", third: "z" })).toBe("満塁");
  });
  it("状況=アウト+走者(導出値を渡す)", () => {
    expect(situationLabel(1, { first: "x", second: "y", third: null })).toBe("一死一二塁");
  });
});

describe("打席結果の一文", () => {
  it("note優先・アウトを伴えば累計アウトを付す", () => {
    expect(playLine(pa({ result: "K", note: "空振り三振" }), 1)).toBe("空振り三振 2アウト");
  });
  it("出塁(アウトなし)はアウト表記なし", () => {
    expect(playLine(pa({ result: "H1", note: "ライト前ヒット", fielding: { hit_to: "9", sequence: ["9"], outs: [], errors: [] } }), 0)).toBe("ライト前ヒット");
  });
  it("note無しは構造化ラベルにフォールバック", () => {
    expect(playLine(pa({ result: "K" }), 0)).toBe("三振 1アウト");
  });
  it("noteは表示用に純化済み(annotationsは表示に出さない)", () => {
    const p = pa({ result: "H1", note: "センター前ヒットで2人生還", annotations: [{ type: "manual", detail: "エラーによる得点のため打点なし" }] });
    expect(playLine(p, 0)).toBe("センター前ヒットで2人生還");
  });
});

describe("打者表記", () => {
  it("自軍は打順+名前。1回はbatting_slot省略→orderで補完", () => {
    expect(batterLabel(pa({ batter_id: "P1", order: 1 }), () => "ダミーA")).toBe("1番 ダミーA");
    expect(batterLabel(pa({ batter_id: "P1", order: 1, batting_slot: 4 }), () => "ダミーB")).toBe("4番 ダミーB");
  });
  it("相手は実名があれば付す", () => {
    expect(batterLabel(pa({ batter_id: "O005" }), (x) => (x === "O005" ? "ダミーC" : x))).toBe("5番 ダミーC");
  });
  it("相手は名前未登録/打順番号そのものなら「N番」のみ", () => {
    expect(batterLabel(pa({ batter_id: "O001" }), id)).toBe("1番");
    expect(batterLabel(pa({ batter_id: "O001" }), () => "1番")).toBe("1番");
  });
});

describe("打席中の走塁イベント", () => {
  const nameOf = (id: string) => (id === "P010" ? "ダミーD" : id); // 自軍のみ実名
  it("盗塁: 自軍走者は実名+進塁", () => {
    const p = pa({ baserunning_during: [{ event: "SB", runners: [{ runner_id: "P010", from: "1", to: "2" }] }] });
    expect(duringLines(p, nameOf)).toEqual(["＜盗塁＞ ダミーDが二塁へ"]);
  });
  it("暴投: 相手走者は塁表記にフォールバック", () => {
    const p = pa({ baserunning_during: [{ event: "WP", runners: [{ runner_id: "O005", from: "1", to: "2" }] }] });
    expect(duringLines(p, nameOf)).toEqual(["＜暴投＞ 一塁走者が二塁へ"]);
  });
  it("牽制でアウトは牽制死", () => {
    const p = pa({ baserunning_during: [{ event: "PO", runners: [{ runner_id: "P010", from: "1", to: "out" }] }] });
    expect(duringLines(p, nameOf)).toEqual(["＜牽制死＞ ダミーDがアウト"]);
  });
  it("走塁イベントなしは空", () => {
    expect(duringLines(pa({}), nameOf)).toEqual([]);
  });
});

describe("アンカー", () => {
  it("inning/half/order からID", () => {
    expect(paAnchor(3, "bottom", 5)).toBe("pa-3-bottom-5");
  });
});

describe("半イニング集計", () => {
  const d = doc({
    home_away: "away",
    plate_appearances: [
      pa({ inning: 1, half: "top", order: 1, result: "H1" }),
      pa({ inning: 1, half: "top", order: 2, result: "BB" }),
      pa({ inning: 1, half: "top", order: 3, result: "HR", runs: [{ runner_id: "x", rbi: true, earned: true, cause: "hr" }, { runner_id: "y", rbi: true, earned: true, cause: "hr" }] }),
      pa({ inning: 1, half: "bottom", order: 1, result: "K" }),
    ],
  });
  it("時系列で表→裏、得点/安打/四死球を集計", () => {
    const hs = halfInnings(d);
    expect(hs.map((h) => `${h.inning}${h.half}`)).toEqual(["1top", "1bottom"]);
    const top = hs[0];
    expect([top.kingsOffense, top.hits, top.walks, top.runs]).toEqual([true, 2, 1, 2]);
    expect(hs[1].kingsOffense).toBe(false);
  });
});
