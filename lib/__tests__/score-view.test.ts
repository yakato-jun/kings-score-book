/** [§10.3 Phase D] スコア入力エディタの表示モデル導出(純関数)の検証。 */
import { describe, it, expect } from "vitest";
import { buildPARows, buildCurrentLineup, buildPitcherRows, resultLabel, RESULT_CHOICES, pitchingRowsToRecords, seedPitcherRows, pitcherSetKey } from "../ops/score-view";
import type { PitcherRowView } from "../ops/score-view";
import { doc, pa, snap, LINEUP } from "./fixtures";

const id = (x: string) => x; // 名前解決はIDそのまま(構造だけ見る)

describe("結果ラベル/選択肢", () => {
  it("AUTO_OUT を含み 汎用 H は選択肢から除外する", () => {
    const codes = RESULT_CHOICES.map(([c]) => c);
    expect(codes).toContain("AUTO_OUT");
    expect(codes).not.toContain("H");
  });
  it("resultLabel は各コードを日本語化(未知はそのまま)", () => {
    expect(resultLabel("HR")).toBe("本塁打");
    expect(resultLabel("AUTO_OUT")).toBe("自動アウト");
    expect(resultLabel(null)).toBe("?");
  });
});

describe("buildPARows: 全事実＋導出プレビュー", () => {
  it("開始時盤面(アウト/走者)と得点を導出し、時系列で並ぶ", () => {
    const d = doc({
      home_away: "away", // kings=top
      plate_appearances: [
        pa({ inning: 1, half: "top", order: 1, batting_slot: 1, batter_id: "P1", result: "H1" }),
        pa({ inning: 1, half: "top", order: 2, batting_slot: 2, batter_id: "P2", result: "HR",
          runs: [{ runner_id: "P1", rbi: true, earned: true, cause: "hr" }, { runner_id: "P2", rbi: true, earned: true, cause: "hr" }] }),
      ],
    });
    const rows = buildPARows(d, id);
    expect(rows.length).toBe(2);
    // 2打席目(HR)開始時: 一塁にP1が居る(derivePAStatesで導出)
    expect(rows[1].startRunners.map((r) => r.runner_id)).toEqual(["P1"]);
    // 保存済みruns[](エンジンが書いた得点者)を表示モデルへ写す
    expect(rows[1].runs.map((r) => r.runner_id).sort()).toEqual(["P1", "P2"]);
    expect(rows[1].isKingsHalf).toBe(true);
    expect(rows[1].resultLabel).toBe("本塁打");
  });

  it("相手打席は opponent_slot を保持し isOpp=true", () => {
    const d = doc({
      home_away: "away",
      plate_appearances: [pa({ inning: 1, half: "bottom", order: 1, batter_id: "o3", opponent_slot: 3, result: "OUT" })],
    });
    const rows = buildPARows(d, id);
    expect(rows[0].isOpp).toBe(true);
    expect(rows[0].opponent_slot).toBe(3);
    expect(rows[0].isKingsHalf).toBe(false);
  });

  it("未解決の要確認(unclear)を列挙し、承認済みは除外する", () => {
    const d = doc({
      home_away: "away",
      plate_appearances: [
        pa({ inning: 1, half: "top", order: 1, batter_id: "P1", result: "OUT",
          annotations: [{ type: "unclear", detail: "要確認A", source: "manual" }, { type: "manual", detail: "メモX", source: "manual" }] }),
      ],
    });
    const rows = buildPARows(d, id);
    expect(rows[0].unresolved.map((a) => a.detail)).toEqual(["要確認A"]);
    expect(rows[0].manualNotes.map((a) => a.detail)).toEqual(["メモX"]);
    expect(rows[0].annotationsRaw.length).toBe(2); // 全置換防止用に生注記を保持
  });
});

describe("buildCurrentLineup: 最新スナップショットの打順守備", () => {
  it("最大seqのスナップショットを打順順で返す", () => {
    const swapped: [number | null, string, string][] = LINEUP.map(([o, pos, pid]) => (pid === "PP" ? [o, "1", pid] : [o, pos, pid]));
    const d = doc({
      home_away: "away",
      lineup_snapshots: [snap(LINEUP), snap(swapped, { seq: 1, snapshot_id: "GTEST-NK-01", effective_from: { inning: 3, half: "top", before_order: null }, reason: "x" })],
    });
    const lu = buildCurrentLineup(d, id);
    expect(lu.length).toBe(LINEUP.length);
    expect(lu[0].order).toBe(1);
  });
});

describe("buildPitcherRows: 登板投手＋投手記録の突合", () => {
  it("相手打席の守備位置1の投手を登場順で、自責/勝敗Sを突き合わせる", () => {
    const d = doc({
      home_away: "away", // kings守備=bottom
      plate_appearances: [pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", opponent_slot: 1, result: "OUT" })],
      pitching: [{ pitcher_id: "PP", earned_runs: 2, decision: "W" }],
    });
    const rows = buildPitcherRows(d, id);
    expect(rows.length).toBe(1);
    expect(rows[0].player_id).toBe("PP");
    expect(rows[0].earned_runs).toBe(2);
    expect(rows[0].decision).toBe("W");
  });
  it("[minor①] earned_runs:null(自責不明)でも decision(勝ち投手)は保持される＝行で W を落とさない", () => {
    const d = doc({
      home_away: "away",
      plate_appearances: [pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", opponent_slot: 1, result: "OUT" })],
      pitching: [{ pitcher_id: "PP", earned_runs: null, decision: "W" }],
    });
    const rows = buildPitcherRows(d, id);
    expect(rows[0].earned_runs).toBe(null); // 不明→フォームでは空欄/箱では「—」
    expect(rows[0].decision).toBe("W");     // 勝ち投手は保持
  });
});

describe("pitchingRowsToRecords (A3/minor①): 自責空欄は0埋めしない・判定だけは null で残す", () => {
  it("判定だけ付けた投手は earned_runs:null で残す(勝ち投手を落とさない)・er:0 は捏造しない", () => {
    const recs = pitchingRowsToRecords([
      { player_id: "PP", er: "2", decision: "W" }, // erあり→記録される
      { player_id: "P5", er: "", decision: "L" },  // er空欄・勝敗Lだけ→earned_runs:null で残す(不明のまま判定保持)
      { player_id: "P6", er: "", decision: "" },     // 全空→記録なし(意味が無い)
    ]);
    expect(recs).toEqual([
      { player: "PP", earned_runs: 2, decision: "W" },
      { player: "P5", earned_runs: null, decision: "L" }, // 勝敗Lが保持され er は不明(null)
    ]);
    // er:0 の捏造はしていない(空欄→0ではなく null)。全空の P6 だけ除外。
    expect(recs.some((r) => r.earned_runs === 0)).toBe(false);
    expect(recs.some((r) => r.player === "P6")).toBe(false);
  });
  it("er='0'(明示ゼロ)は 0 保持・decision無しは null", () => {
    expect(pitchingRowsToRecords([{ player_id: "PP", er: "0" }])).toEqual([{ player: "PP", earned_runs: 0, decision: null }]);
  });
  it("er空欄 & decisionなしは除外(記録すべき内容が無い)", () => {
    expect(pitchingRowsToRecords([{ player_id: "PP", er: "", decision: "" }])).toEqual([]);
  });
});

// PitchingRecords(投手フォーム)の再シード判定を支える純関数。React行の初期化と「集合が変われば再シード/同一なら
// 編集保持」の判定はこの2関数に集約し、コンポーネント(editor-parts)は薄く保つ(このリポは純関数のみ vitest 対象)。
describe("投手フォーム: seedPitcherRows / pitcherSetKey(再シード判定=編集保持の担保)", () => {
  const P = (player_id: string, name: string, earned_runs: number | null, decision: "W" | "L" | "S" | null = null): PitcherRowView =>
    ({ player_id, name, earned_runs, decision });

  it("seedPitcherRows: 数値→文字列 / null→空欄(不明) / decision null→''", () => {
    expect(seedPitcherRows([P("m1", "一山", 2, "W"), P("m2", "投森", null)])).toEqual([
      { player_id: "m1", name: "一山", er: "2", decision: "W" },
      { player_id: "m2", name: "投森", er: "", decision: "" },
    ]);
  });
  it("seedPitcherRows: er=0(明示ゼロ)は '0' を保つ(不明''と区別)", () => {
    expect(seedPitcherRows([P("m1", "一山", 0)])[0].er).toBe("0");
  });
  it("pitcherSetKey: 集合(player_id)が同一なら等しい＝再シードしない(値が違っても編集を保持)", () => {
    expect(pitcherSetKey([P("m1", "一山", 2), P("m2", "投森", null)]))
      .toBe(pitcherSetKey([P("m1", "x", 9), P("m2", "y", 1)]));
  });
  it("pitcherSetKey: 投手が後から検出/減ると異なる＝再シードされる(0人→1人検出も)", () => {
    expect(pitcherSetKey([P("m1", "一山", 2)])).not.toBe(pitcherSetKey([P("m1", "一山", 2), P("m2", "投森", null)]));
    expect(pitcherSetKey([])).not.toBe(pitcherSetKey([P("m1", "一山", 2)]));
  });
});
