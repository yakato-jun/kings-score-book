/**
 * [§0/§11 断片試合の第一級表現] のテスト。
 *  Phase1: runner_id=null(得点者不明)の帰属 ＋ agg防御4件(a/b/c/d)。
 *  Phase2: validator算術調停(R1/R3/R4 が null得点/直接記録で誤検知しない)。
 *  Phase3: direct_stats の畳み込み(純§0試合・混在)＋ V-E タグ ＋ season無改修追従。
 * 既存244テストが「direct_stats不在・全runner_id非null」でバイト不変＝現状維持の担保(別ファイル)。
 */
import { describe, it, expect } from "vitest";
import type { GameDoc, Participant, PlateAppearance, DirectStatLine } from "../types/v2";
import { aggregateGameP, aggregateSeasonP } from "../agg/participants";
import { era } from "../agg/types";
import { validateGame } from "../ops/validate";
import { doc, pa, snap, LINEUP } from "./fixtures";

// 参加者ID(不透明) p1..p9/pp → roster player_id P1..P9/PP に link
const NEW_LINEUP: [number | null, string, string][] = LINEUP.map(([o, pos, pid]) => [o, pos, pid === "PP" ? "pp" : "p" + pid.slice(1)]);
const rosterPlayerId = (pid: string) => (pid === "pp" ? "PP" : "P" + pid.slice(1));
const ROSTER_PARTS: Participant[] = NEW_LINEUP.map(([, , pid]) => ({
  id: pid,
  link: { kind: "roster", player_id: rosterPlayerId(pid) },
}));

const awayDoc = (pas: PlateAppearance[], over: Partial<GameDoc> = {}): GameDoc =>
  doc({ home_away: "away", lineup_snapshots: [snap(NEW_LINEUP)], participants: ROSTER_PARTS, plate_appearances: pas, ...over });

describe("Phase1 §0-C 得点者不明(runner_id=null)の帰属", () => {
  it("防御(a): null得点は投手R/ER(チーム失点)を計上し、選手別R・幽霊guest行は作らない", () => {
    const box = aggregateGameP(awayDoc([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "H1", runs: [{ runner_id: null, rbi: false, earned: true, cause: "other" }] }),
    ]));
    const pp = box.pitching.find((p) => p.player_id === "PP");
    expect(pp?.r).toBe(1);
    expect(pp?.er).toBe(1);
    // 幽霊guest行(`GTEST:null`)が湧かない・選手別Rは誰にも付かない
    expect(box.batting.some((b) => b.player_id.includes("null"))).toBe(false);
    expect(box.batting.reduce((s, b) => s + b.r, 0)).toBe(0);
  });

  it("混在: 既知走者のRは通常どおり動き、同PA内の別のnull得点は選手別Rを動かさない", () => {
    const box = aggregateGameP(awayDoc([
      // 自軍攻撃(top): p1 が本塁打で生還(既知走者R)
      pa({ inning: 1, half: "top", order: 1, batter_id: "p1", result: "HR", runs: [{ runner_id: "p1", rbi: true, earned: true, cause: "hr" }] }),
      // 自軍守備(bottom): 得点者不明の失点1
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "H1", runs: [{ runner_id: null, rbi: false, earned: true, cause: "other" }] }),
    ]));
    expect(box.batting.find((b) => b.player_id === "P1")?.r).toBe(1); // 既知走者Rは健在
    expect(box.batting.some((b) => b.player_id.includes("null"))).toBe(false);
    expect(box.pitching.find((p) => p.player_id === "PP")?.r).toBe(1); // 不明失点は投手へ
  });
});

describe("Phase1 agg防御(b/c/d) — direct_stats を落とさない/握り潰さない", () => {
  it("防御(b): tc単独主張(po=a=e=0)を 0 で握り潰さず保持する", () => {
    const box = aggregateGameP(awayDoc([], { direct_stats: [{ participant_id: "p4", fielding: { tc: 3 }, origin: "manual" }] }));
    const f = box.fielding.find((x) => x.player_id === "P4");
    expect(f?.tc).toBe(3);
    expect(f?.po).toBe(0);
  });

  it("防御(c): 三振だけ/二塁打だけ/三塁打だけの打撃断片が採用される", () => {
    const box = aggregateGameP(awayDoc([], {
      direct_stats: [
        { participant_id: "p5", batting: { k: 2 }, origin: "manual" },
        { participant_id: "p6", batting: { b2: 1 }, origin: "manual" },
        { participant_id: "p7", batting: { b3: 1 }, origin: "manual" },
      ],
    }));
    expect(box.batting.find((b) => b.player_id === "P5")?.k).toBe(2);
    expect(box.batting.find((b) => b.player_id === "P6")?.b2).toBe(1);
    expect(box.batting.find((b) => b.player_id === "P7")?.b3).toBe(1);
  });

  it("[BLOCKER] canonical断片 {h:2,rbi:1}(「自分は2安打1打点」)が h=2/rbi=1 で箱に出る", () => {
    const box = aggregateGameP(awayDoc([], {
      direct_stats: [{ participant_id: "p1", batting: { h: 2, rbi: 1 }, origin: "manual" }],
    }));
    const b = box.batting.find((x) => x.player_id === "P1");
    expect(b).toMatchObject({ h: 2, rbi: 1, g: 1 });
  });

  it("[BLOCKER] h/b1/hr/rbi だけの断片({rbi:1}/{hr:1}/{b1:1}/{h:2})も採用される(旧述語では全損していた)", () => {
    const box = aggregateGameP(awayDoc([], {
      direct_stats: [
        { participant_id: "p2", batting: { rbi: 1 }, origin: "manual" },
        { participant_id: "p3", batting: { hr: 1 }, origin: "manual" },
        { participant_id: "p4", batting: { b1: 1 }, origin: "manual" },
        { participant_id: "p8", batting: { h: 2 }, origin: "manual" },
      ],
    }));
    expect(box.batting.find((b) => b.player_id === "P2")?.rbi).toBe(1);
    expect(box.batting.find((b) => b.player_id === "P3")?.hr).toBe(1);
    expect(box.batting.find((b) => b.player_id === "P4")?.b1).toBe(1);
    expect(box.batting.find((b) => b.player_id === "P8")?.h).toBe(2);
  });

  it("防御(d): doc.pitchingが名指す投手のみer上書き・direct単独投手のerは保持", () => {
    const box = aggregateGameP(awayDoc(
      [pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "H1", runs: [{ runner_id: null, rbi: false, earned: true, cause: "other" }] })],
      {
        direct_stats: [{ participant_id: "p3", pitching: { outs: 3, er: 2 }, origin: "manual" }],
        pitching: [{ pitcher_id: "pp", earned_runs: 0 }], // PP(=pp)を名指し→erを0へ上書き
      }
    ));
    expect(box.pitching.find((p) => p.player_id === "PP")?.er).toBe(0); // 名指し→記録値0が正本
    expect(box.pitching.find((p) => p.player_id === "P3")?.er).toBe(2); // direct単独→merge値保持
  });
});

describe("Phase3 direct_stats の畳み込み", () => {
  it("純§0試合(PAゼロ・directのみ)が正しく箱に出る", () => {
    const box = aggregateGameP(awayDoc([], {
      direct_stats: [{ participant_id: "p1", batting: { pa: 4, ab: 3, h: 2, b2: 1, rbi: 2 }, origin: "manual" }],
    }));
    const b = box.batting.find((x) => x.player_id === "P1");
    expect(b).toMatchObject({ pa: 4, ab: 3, h: 2, b2: 1, rbi: 2, g: 1 });
  });

  it("PA由来と direct は同一 resolve キーへ additive 加算される", () => {
    const box = aggregateGameP(awayDoc(
      [pa({ inning: 1, half: "top", order: 1, batter_id: "p1", result: "H1" })], // PA由来: ab1 h1
      { direct_stats: [{ participant_id: "p1", batting: { ab: 2, h: 1 }, origin: "manual" }] } // direct: ab2 h1
    ));
    const b = box.batting.find((x) => x.player_id === "P1");
    expect(b?.ab).toBe(3);
    expect(b?.h).toBe(2);
  });

  it("season は GameBox 畳みで無改修追従(directを試合横断で合算・g=出場数)", () => {
    const mk = (id: string): GameDoc => {
      const d = awayDoc([], { direct_stats: [{ participant_id: "p1", batting: { ab: 1, h: 1 }, origin: "manual" }] });
      d.game.id = id;
      return d;
    };
    const s = aggregateSeasonP([mk("GA"), mk("GB")]);
    const p1 = s.batting.find((b) => b.player_id === "P1");
    expect(p1?.ab).toBe(2);
    expect(p1?.h).toBe(2);
    expect(p1?.g).toBe(2); // 出欠(status=played)×2
  });
});

describe("Phase2 validator算術調停(null得点/direct で誤検知しない)", () => {
  it("R1: runner_id=null の得点3件は非null比較で不一致にならない", () => {
    const flags = validateGame(awayDoc([
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "H1", runs: [
        { runner_id: null, rbi: false, earned: true, cause: "other" },
        { runner_id: null, rbi: false, earned: true, cause: "other" },
        { runner_id: null, rbi: false, earned: true, cause: "other" },
      ] }),
    ]));
    expect(flags.some((f) => f.rule === "R1")).toBe(false);
  });

  it("R4: direct でチーム得点を積んだ断片試合が申告スコアと一致し誤検知しない", () => {
    const withResult = (direct?: DirectStatLine[]): GameDoc =>
      awayDoc([pa({ inning: 1, half: "top", order: 1, batter_id: "p1", result: "OUT" })], {
        game: { id: "GTEST", date: "2026-01-01", opponent: "T", league: null, home_away: "away",
          result: { our_score: 3, their_score: 0, outcome: "win", decided_by: "regulation" } },
        direct_stats: direct,
      });
    // directでown3点を主張→導出own(PA0+direct3)=申告3→R4なし
    expect(validateGame(withResult([{ participant_id: "p1", batting: { r: 3 }, origin: "manual" }])).some((f) => f.rule === "R4")).toBe(false);
    // 対照: direct無し→own0≠3→R4発火
    expect(validateGame(withResult(undefined)).some((f) => f.rule === "R4")).toBe(true);
  });

  it("R3: null得点の件数ぶんの生還を許容し「走者が消えた」誤検知を抑える", () => {
    const home = (runs: PlateAppearance["runs"]): GameDoc =>
      doc({
        home_away: "home",
        lineup_snapshots: [snap(LINEUP, { effective_from: { inning: 1, half: "bottom", before_order: null } })],
        plate_appearances: [
          pa({ inning: 1, half: "bottom", order: 1, batter_id: "P1", result: "H1", baserunning_after: [{ runner_id: "P1", from: null, to: "1" }] }),
          pa({ inning: 1, half: "bottom", order: 2, batter_id: "P2", result: "FC", runs }),
        ],
      });
    // FCで一塁走者P1が盤面から消える。null得点1件があれば「還った」とみなしR3を出さない。
    expect(validateGame(home([{ runner_id: null, rbi: false, earned: false, cause: "fc" }])).some((f) => f.rule === "R3")).toBe(false);
    // 対照: null得点無し→従来どおりR3発火
    expect(validateGame(home([])).some((f) => f.rule === "R3")).toBe(true);
  });
});

describe("Phase3 V-E: PA由来打撃と direct batting の両持ちをタグ(弾かない)", () => {
  it("同一participantが両持ち→V-E(anchor=最終打席)、純directのみ/PA由来のみは出さない", () => {
    // p1: PA(top H1)＋direct batting の両持ち / p2: PAのみ / p3: directのみ
    const flags = validateGame(awayDoc(
      [
        pa({ inning: 1, half: "top", order: 1, batter_id: "p1", result: "H1" }),
        pa({ inning: 1, half: "top", order: 2, batter_id: "p2", result: "OUT" }),
      ],
      {
        direct_stats: [
          { participant_id: "p1", batting: { ab: 1 }, origin: "manual" },
          { participant_id: "p3", batting: { ab: 1 }, origin: "manual" },
        ],
      }
    ));
    const ve = flags.filter((f) => f.rule === "V-E");
    expect(ve).toHaveLength(1);
    expect(ve[0].detail).toContain("p1");
    expect(ve[0].detail).not.toContain("p2");
    expect(ve[0].detail).not.toContain("p3");
  });

  it("純§0試合(PAゼロ)は二重計上の余地なし→V-Eを出さない", () => {
    const flags = validateGame(awayDoc([], { direct_stats: [{ participant_id: "p1", batting: { ab: 1 }, origin: "manual" }] }));
    expect(flags.some((f) => f.rule === "V-E")).toBe(false);
  });

  it("[拡張] PA由来投手(自軍守備halfでfacing) と direct pitching の両持ち→V-E flag", () => {
    // pp は NEW_LINEUP で守備位置1(投手)。自軍守備half(bottom)に相手打席があれば pp は PA由来投手。
    const flags = validateGame(awayDoc(
      [pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "OUT" })],
      { direct_stats: [{ participant_id: "pp", pitching: { outs: 3 }, origin: "manual" }] }
    ));
    const ve = flags.filter((f) => f.rule === "V-E");
    expect(ve).toHaveLength(1);
    expect(ve[0].detail).toContain("pp");
  });
});

describe("クラスタA 自責点(er)の4分岐＝不明はnull(0/防御率0.00に潰さない)", () => {
  // away → 自軍守備=bottom。PP(pp)が守備位置1＝失点はPPへ帰属。
  const oppRun = (runs: PlateAppearance["runs"]) =>
    pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "H1", runs });
  const erOf = (box: ReturnType<typeof aggregateGameP>) => box.pitching.find((p) => p.player_id === "PP")?.er;

  it("分岐2: 失点0(r=0)→er=0(自明clear)", () => {
    const box = aggregateGameP(awayDoc([pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "OUT" })]));
    expect(box.pitching.find((p) => p.player_id === "PP")?.r).toBe(0);
    expect(erOf(box)).toBe(0);
  });

  it("分岐3: r>0 かつ 全runがdeterminate(earned=true)→er=確定合算", () => {
    const box = aggregateGameP(awayDoc([oppRun([{ runner_id: "o1", rbi: false, earned: true, cause: "hit" }])]));
    expect(box.pitching.find((p) => p.player_id === "PP")?.r).toBe(1);
    expect(erOf(box)).toBe(1);
  });

  it("分岐3(error): earned=false(自明clear)は自責でない→er=0(不明ではない)", () => {
    const box = aggregateGameP(awayDoc([oppRun([{ runner_id: "o1", rbi: false, earned: false, cause: "error" }])]));
    expect(box.pitching.find((p) => p.player_id === "PP")?.r).toBe(1);
    expect(erOf(box)).toBe(0); // false=非自責。null(不明)ではない
  });

  it("分岐4: r>0 かつ 走者不明得点(earned=null)を含む→er=null(不明)。防御率も—", () => {
    const box = aggregateGameP(awayDoc([oppRun([{ runner_id: null, rbi: false, earned: null, cause: "other" }])]));
    const pp = box.pitching.find((p) => p.player_id === "PP")!;
    expect(pp.r).toBe(1);
    expect(pp.er).toBe(null);
    expect(era(pp)).toBe(null); // 防御率0.00を捏造しない
  });

  it("earned=null は er 合算で false(0) 扱いされない: 確定1+不明1→er=null(1ではない)", () => {
    const box = aggregateGameP(awayDoc([oppRun([
      { runner_id: "o1", rbi: false, earned: true, cause: "hit" },
      { runner_id: null, rbi: false, earned: null, cause: "other" },
    ])]));
    const pp = box.pitching.find((p) => p.player_id === "PP")!;
    expect(pp.r).toBe(2);
    expect(pp.er).toBe(null); // 不明が混じれば合算不能＝null(nullをfalse扱いしてer=1にしない)
  });

  it("分岐1: 人明示(doc.pitching.earned_runs)は不明でも正本＝上書きしない", () => {
    const box = aggregateGameP(awayDoc(
      [oppRun([{ runner_id: null, rbi: false, earned: null, cause: "other" }])],
      { pitching: [{ pitcher_id: "pp", earned_runs: 1 }] }
    ));
    expect(box.pitching.find((p) => p.player_id === "PP")?.er).toBe(1);
  });

  it("[minor①] doc.pitching earned_runs:null(判定だけ・自責不明)は箱で er=null(防御率「—」)。近似(known)を上書きし人の明示「不明」が勝つ", () => {
    // 失点は earned=true で自責1を導出可(近似known=1)だが、人が earned_runs:null で「不明」と明示→er=null が勝つ。
    const box = aggregateGameP(awayDoc(
      [oppRun([{ runner_id: "o1", rbi: false, earned: true, cause: "hit" }])],
      { pitching: [{ pitcher_id: "pp", earned_runs: null, decision: "W" }] }
    ));
    const pp = box.pitching.find((p) => p.player_id === "PP")!;
    expect(pp.r).toBe(1);     // 失点は計上
    expect(pp.er).toBe(null); // 人の明示「不明」→er=null(表示「—」・近似1を上書き)
    expect(era(pp)).toBe(null);
  });

  it("分岐1(direct er明示)/分岐4b(断片r>0でer未記録)/分岐2b(断片r=0)", () => {
    // direct er明示→er=その値(clear)
    const knownEr = aggregateGameP(awayDoc([], { direct_stats: [{ participant_id: "p3", pitching: { outs: 3, r: 2, er: 2 }, origin: "manual" }] })).pitching.find((p) => p.player_id === "P3")?.er;
    expect(knownEr).toBe(2);
    // 断片で r>0 だが er未記録→不明(null)
    const unkEr = aggregateGameP(awayDoc([], { direct_stats: [{ participant_id: "p3", pitching: { outs: 3, r: 2 }, origin: "manual" }] })).pitching.find((p) => p.player_id === "P3")?.er;
    expect(unkEr).toBe(null);
    // 断片で r=0(er未記録)→自責0(自明)
    const zeroEr = aggregateGameP(awayDoc([], { direct_stats: [{ participant_id: "p3", pitching: { outs: 3 }, origin: "manual" }] })).pitching.find((p) => p.player_id === "P3")?.er;
    expect(zeroEr).toBe(0);
  });

  it("A5: doc.pitching が名指すが箱に line 無い投手も生成(明示erの箱落ち防止)", () => {
    // p3 はPA/directに登場しないが doc.pitching で earned_runs=1 を明示→箱に P3 行が出る
    const box = aggregateGameP(awayDoc([pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "OUT" })], {
      pitching: [{ pitcher_id: "p3", earned_runs: 1 }],
    }));
    expect(box.pitching.find((p) => p.player_id === "P3")?.er).toBe(1);
  });

  it("season: 不明(er=null)を1試合でも含めばシーズン防御率も不明(null)＝0合算しない", () => {
    const mkKnown = (id: string) => { const d = awayDoc([oppRun([{ runner_id: "o1", rbi: false, earned: true, cause: "hit" }])]); d.game.id = id; return d; };
    const mkNull = (id: string) => { const d = awayDoc([oppRun([{ runner_id: null, rbi: false, earned: null, cause: "other" }])]); d.game.id = id; return d; };
    const s = aggregateSeasonP([mkKnown("GA"), mkNull("GB")]);
    const pp = s.pitching.find((p) => p.player_id === "PP")!;
    expect(pp.r).toBe(2);
    expect(pp.er).toBe(null);
    expect(era(pp)).toBe(null);
  });
});

describe("V-G: 失点あるが自責点が genuine unknown な投手を要確認(過剰タグ回避)", () => {
  const oppRun = (runs: PlateAppearance["runs"]) =>
    pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "H1", runs });
  it("走者不明得点(earned=null)の失点→V-G(anchor=最終打席)", () => {
    const flags = validateGame(awayDoc([oppRun([{ runner_id: null, rbi: false, earned: null, cause: "other" }])]));
    expect(flags.some((f) => f.rule === "V-G" && f.detail.includes("pp"))).toBe(true);
  });
  it("確定(earned=true/false)だけ→V-G出さない(自明clearに過剰タグしない)", () => {
    expect(validateGame(awayDoc([oppRun([{ runner_id: "o1", rbi: false, earned: true, cause: "hit" }])])).some((f) => f.rule === "V-G")).toBe(false);
    expect(validateGame(awayDoc([oppRun([{ runner_id: "o1", rbi: false, earned: false, cause: "error" }])])).some((f) => f.rule === "V-G")).toBe(false);
  });
  it("失点0(r=0)→V-G出さない", () => {
    expect(validateGame(awayDoc([pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "OUT" })])).some((f) => f.rule === "V-G")).toBe(false);
  });
  it("人明示(doc.pitching earned_runs=number)があれば不明でもV-G出さない(過剰タグ回避)", () => {
    const flags = validateGame(awayDoc([oppRun([{ runner_id: null, rbi: false, earned: null, cause: "other" }])], { pitching: [{ pitcher_id: "pp", earned_runs: 0 }] }));
    expect(flags.some((f) => f.rule === "V-G")).toBe(false);
  });
  it("[minor①] doc.pitching earned_runs:null(判定だけ・自責不明)の投手は r>0 なら V-G に surface(decision付きでも不明は隠さない)", () => {
    const flags = validateGame(awayDoc([oppRun([{ runner_id: null, rbi: false, earned: null, cause: "other" }])], { pitching: [{ pitcher_id: "pp", earned_runs: null, decision: "L" }] }));
    expect(flags.some((f) => f.rule === "V-G" && f.detail.includes("pp"))).toBe(true);
  });
  it("断片(direct)で r>0 だが er未記録→V-G / er明示なら出さない", () => {
    const withR = validateGame(awayDoc([pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "OUT" })], { direct_stats: [{ participant_id: "p3", pitching: { outs: 3, r: 2 }, origin: "manual" }] }));
    expect(withR.some((f) => f.rule === "V-G" && f.detail.includes("p3"))).toBe(true);
    const withEr = validateGame(awayDoc([pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "OUT" })], { direct_stats: [{ participant_id: "p3", pitching: { outs: 3, r: 2, er: 2 }, origin: "manual" }] }));
    expect(withEr.some((f) => f.rule === "V-G")).toBe(false);
  });
  it("承認(resolved rule:V-G)はスキップ", () => {
    const d = awayDoc([oppRun([{ runner_id: null, rbi: false, earned: null, cause: "other" }])]);
    const last = d.plate_appearances[d.plate_appearances.length - 1];
    last.annotations = [{ type: "resolved", source: "manual", detail: "自責不明のまま確定", rule: "V-G" }];
    expect(validateGame(d).some((f) => f.rule === "V-G")).toBe(false);
  });
});

describe("V-F: direct fielding の tc 自己矛盾を弾かずタグ", () => {
  it("明示tcが po+a+e と食い違う({po:2,a:1,tc:1})→V-F flag / tc単独主張({tc:3})は出さない", () => {
    // anchorできるよう最低1打席(自軍攻撃top)を置く。
    const base = (fielding: NonNullable<GameDoc["direct_stats"]>[number]["fielding"]) =>
      validateGame(awayDoc(
        [pa({ inning: 1, half: "top", order: 1, batter_id: "p1", result: "OUT" })],
        { direct_stats: [{ participant_id: "p4", fielding, origin: "manual" }] }
      ));
    const conflict = base({ po: 2, a: 1, tc: 1 }).filter((f) => f.rule === "V-F");
    expect(conflict).toHaveLength(1);
    expect(conflict[0].detail).toContain("p4");
    // tc単独主張(po/a/e=None)は正当＝矛盾でない
    expect(base({ tc: 3 }).some((f) => f.rule === "V-F")).toBe(false);
    // 整合({po:2,a:1,e:0,tc:3})も出さない
    expect(base({ po: 2, a: 1, e: 0, tc: 3 }).some((f) => f.rule === "V-F")).toBe(false);
  });
});
