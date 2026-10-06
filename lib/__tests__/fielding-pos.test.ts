import { describe, it, expect } from "vitest";
import { normPos, normPosSeq } from "../fielding-pos";
import { aggregateGame } from "../agg";
import { aggregateGameP } from "../agg/participants";
import { toGameOp } from "../ai/agent";
import { doc, defPA } from "./fixtures";

// 守備位置表記(漢字/語/連結)の正規化。漢字のまま保存された errors/sequence が集計で選手に結び付かず、
// 失策・刺殺・捕殺を取りこぼしていた(実データ 2026-08-09/16/23)。

describe("normPos / normPosSeq", () => {
  it("番号・漢字・語・全角・英略号を番号へ。解釈不能は null", () => {
    expect(["5", "三", "三塁", "サード", "５", "3B"].map(normPos)).toEqual(["5", "5", "5", "5", "5", "5"]);
    expect(normPos("遊")).toBe("6");
    expect(normPos("三塁手が三塁ベースを踏む")).toBeNull();
    expect(normPos(null)).toBeNull();
  });
  it("連結表記は分割し、解釈不能な要素は捨てる", () => {
    expect(normPosSeq(["三-一"])).toEqual(["5", "3"]);
    expect(normPosSeq(["遊", "二", "一"])).toEqual(["6", "4", "3"]);
    expect(normPosSeq(["6-4-3"])).toEqual(["6", "4", "3"]);
    expect(normPosSeq(["三塁手が三塁ベースを踏む"])).toEqual([]);
  });
});

describe("集計: 漢字の守備位置でも選手に付与する(away=自軍守備bottom・P5=三 P6=一 P1=遊)", () => {
  const box = (p: ReturnType<typeof defPA>) => aggregateGame(doc({ home_away: "away", plate_appearances: [p] }));
  const boxP = (p: ReturnType<typeof defPA>) => aggregateGameP(doc({ home_away: "away", plate_appearances: [p] }));
  // participants 無しの fixture では participants 集計のキーが "GTEST:P5" 形式になる(選手の同定は末尾で見る)
  const of = (b: { fielding: { player_id: string }[] }, pid: string) => b.fielding.find((x) => x.player_id === pid || x.player_id.endsWith(`:${pid}`)) as { po: number; a: number; e: number } | undefined;
  it("三失(errors.pos=三)は三塁手のE", () => {
    const p = defPA({ result: "E", fielding: { hit_to: "5", sequence: [], outs: [], errors: [{ pos: "三", type: "捕球" }] } });
    expect(of(box(p), "P5")?.e).toBe(1);
    expect(of(boxP(p), "P5")?.e).toBe(1);
  });
  it("連結表記の送球順(三-一)で一塁刺殺・三塁捕殺", () => {
    const p = defPA({ result: "OUT", fielding: { hit_to: "5", sequence: ["三-一"], outs: [{ at: "1", type: "force" }], errors: [] } });
    const b = boxP(p);
    expect(of(b, "P6")?.po).toBe(1);
    expect(of(b, "P5")?.a).toBe(1);
  });
  it("送球順が文章だけ(解釈不能)のフライは hit_to から刺殺を補う", () => {
    const p = defPA({ result: "OUT", fielding: { hit_to: "遊", sequence: ["ショートが捕球"], outs: [], errors: [] } });
    expect(of(boxP(p), "P1")?.po).toBe(1);
  });
});

describe("集計: 送球順も守備アウトも無いゴロアウトは標準の送球順を補う", () => {
  const boxP = (p: ReturnType<typeof defPA>) => aggregateGameP(doc({ home_away: "away", plate_appearances: [p] }));
  const of = (b: { fielding: { player_id: string }[] }, pid: string) => b.fielding.find((x) => x.player_id === pid || x.player_id.endsWith(`:${pid}`)) as { po: number; a: number } | undefined;
  it("遊ゴロ(hit_to=6・G・seq/outs無し)は遊撃に捕殺・一塁に刺殺", () => {
    const b = boxP(defPA({ result: "OUT", fielding: { hit_to: "6", hit_type: "G", sequence: [], outs: [], errors: [] } }));
    expect(of(b, "P1")?.a).toBe(1);
    expect(of(b, "P1")?.po ?? 0).toBe(0);
    expect(of(b, "P6")?.po).toBe(1);
  });
  it("一ゴロは一塁手の刺殺のみ(捕殺なし)", () => {
    const b = boxP(defPA({ result: "OUT", fielding: { hit_to: "3", hit_type: "G", sequence: [], outs: [], errors: [] } }));
    expect(of(b, "P6")?.po).toBe(1);
    expect(of(b, "P6")?.a ?? 0).toBe(0);
  });
  it("フライは従来どおり捕球野手の刺殺のみ(補わない)", () => {
    const b = boxP(defPA({ result: "OUT", fielding: { hit_to: "6", hit_type: "F", sequence: [], outs: [], errors: [] } }));
    expect(of(b, "P1")?.po).toBe(1);
    expect(of(b, "P6")).toBeUndefined();
  });
});

describe("取り込み(toGameOp): fielding の守備位置を番号へ正規化", () => {
  it("hit_to / errors.pos / sequence(連結は分割)を番号に。解釈不能な要素は消さずに残す", () => {
    const g = toGameOp({ op: "addPlateAppearance", result_code: "E", fielding: { hit_to: "三", sequence: ["三-一", "メモ"], outs: [], errors: [{ pos: "三", type: "捕球" }] } }) as unknown as { fielding: Record<string, unknown> };
    expect(g.fielding.hit_to).toBe("5");
    expect(g.fielding.sequence).toEqual(["5", "3", "メモ"]);
    expect(g.fielding.errors).toEqual([{ pos: "5", type: "捕球" }]);
  });
});

describe("集計: 刺殺・捕殺の付け先(outCredits)", () => {
  const boxP = (p: ReturnType<typeof defPA>) => aggregateGameP(doc({ home_away: "away", plate_appearances: [p] }));
  const of = (b: { fielding: { player_id: string }[] }, pid: string) => b.fielding.find((x) => x.player_id === pid || x.player_id.endsWith(`:${pid}`)) as { po: number; a: number } | undefined;
  it("送球順の無い捕球アウト(catch@8)は中堅手の刺殺", () => {
    const b = boxP(defPA({ result: "OUT", fielding: { hit_to: "8", hit_type: "F", sequence: [], outs: [{ at: "8", type: "catch" }], errors: [] } }));
    expect(of(b, "P7")?.po).toBe(1);
  });
  it("6-4-3 併殺(明示なし)は 遊=捕殺1・二=刺殺1捕殺1・一=刺殺1", () => {
    const b = boxP(defPA({ result: "OUT", double_play: true, fielding: { hit_to: "6", hit_type: "G", sequence: ["6", "4", "3"], outs: [{ at: "2", type: "force" }, { at: "1", type: "force" }], errors: [] } }));
    expect(of(b, "P1")).toMatchObject({ po: 0, a: 1 });
    expect(of(b, "P4")).toMatchObject({ po: 1, a: 1 });
    expect(of(b, "P6")).toMatchObject({ po: 1, a: 0 });
  });
  it("明示の putout_position は従来どおり優先", () => {
    const b = boxP(defPA({ result: "OUT", fielding: { hit_to: "5", hit_type: "G", sequence: ["5", "3"], outs: [{ at: "1", type: "force", putout_position: "3", assist_positions: ["5"] }], errors: [] } }));
    expect(of(b, "P6")?.po).toBe(1);
    expect(of(b, "P5")?.a).toBe(1);
  });
});
