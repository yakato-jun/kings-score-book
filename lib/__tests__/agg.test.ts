import { describe, it, expect } from "vitest";
import { aggregateGame, aggregateSeason, gameLineScore, outsMade, deriveResult, displayResult } from "../agg";
import type { GameBox } from "../agg/types";
import { doc, defPA, pa, snap, LINEUP } from "./fixtures";

const bat = (b: GameBox, pid: string) => b.batting.find((x) => x.player_id === pid);
const pit = (b: GameBox, pid: string) => b.pitching.find((x) => x.player_id === pid);
const fld = (b: GameBox, pid: string) => b.fielding.find((x) => x.player_id === pid);

describe("打撃集計 (away=自軍攻撃top)", () => {
  const box = aggregateGame(
    doc({
      home_away: "away",
      plate_appearances: [
        pa({ order: 1, batter_id: "P1", result: "H2", baserunning_after: [{ runner_id: "P1", from: null, to: "2" }] }),
        pa({ order: 2, batter_id: "P2", result: "BB", baserunning_after: [{ runner_id: "P2", from: null, to: "1" }] }),
        pa({
          order: 3, batter_id: "P3", result: "HR",
          runs: [
            { runner_id: "P1", rbi: true, earned: true, cause: "hr" },
            { runner_id: "P2", rbi: true, earned: true, cause: "hr" },
            { runner_id: "P3", rbi: true, earned: true, cause: "hr" },
          ],
        }),
        pa({ order: 4, batter_id: "P4", result: "K" }),
        pa({ order: 5, batter_id: "P5", result: "OUT" }),
        pa({ order: 6, batter_id: "P6", result: "OUT" }),
      ],
    })
  );
  it("二塁打・得点", () => {
    const p1 = bat(box, "P1")!;
    expect([p1.pa, p1.ab, p1.h, p1.b2, p1.r, p1.rbi]).toEqual([1, 1, 1, 1, 1, 0]);
  });
  it("四球は打数に数えず得点はつく", () => {
    const p2 = bat(box, "P2")!;
    expect([p2.pa, p2.ab, p2.bb, p2.r]).toEqual([1, 0, 1, 1]);
  });
  it("本塁打と打点3", () => {
    const p3 = bat(box, "P3")!;
    expect([p3.h, p3.hr, p3.rbi, p3.r]).toEqual([1, 1, 3, 1]);
  });
  it("三振", () => {
    expect(bat(box, "P4")!.k).toBe(1);
  });
});

describe("[クラスタB3] result:null(結果不明)は打数/凡退/アウトを捏造しない", () => {
  const box = aggregateGame(
    doc({
      home_away: "away",
      plate_appearances: [
        pa({ order: 1, batter_id: "P1", result: null }),                   // 結果不明(打席は成立)
        pa({ order: 2, batter_id: "P2", result: "INC", complete: false }), // 未完了(打席継続中)
        pa({ order: 3, batter_id: "P3", result: "OUT" }),                  // 凡退(比較用)
      ],
    })
  );
  it("result:null は打席(PA)は数えるが 打数(ab)・安打(h)・三振(k) を作らない(捏造しない)", () => {
    const p1 = bat(box, "P1")!;
    expect([p1.pa, p1.ab, p1.h, p1.k]).toEqual([1, 0, 0, 0]);
  });
  it("result:null は out(凡退)/アウトカウントを作らない(OUTは1・nullは0)", () => {
    expect(outsMade(pa({ result: null }))).toBe(0);
    expect(outsMade(pa({ result: "OUT" }))).toBe(1);
  });
  it("INC(未完了=打席継続中)は PA に数えない=null(結果不明・打席成立)と意味差を保つ", () => {
    expect(bat(box, "P2")?.pa ?? 0).toBe(0); // INC は is_pa=false
    expect(bat(box, "P1")!.pa).toBe(1);      // null は打席1
  });
});

describe("盗塁は走者へ付与", () => {
  const box = aggregateGame(
    doc({
      home_away: "away",
      plate_appearances: [
        pa({ order: 1, batter_id: "P1", result: "H1", baserunning_after: [{ runner_id: "P1", from: null, to: "1" }] }),
        pa({
          order: 2, batter_id: "P5", result: "OUT", outs: 0,
          runners: { first: "P1", second: null, third: null },
          baserunning_during: [{ event: "SB", runners: [{ runner_id: "P1", from: "1", to: "2" }] }],
        }),
      ],
    })
  );
  it("打者でなく走者P1にSB", () => {
    expect(bat(box, "P1")!.sb).toBe(1);
    expect(bat(box, "P5")!.sb).toBe(0);
  });
});

describe("守備集計 (away=自軍守備bottom)", () => {
  function fldBox(p: ReturnType<typeof defPA>) {
    return aggregateGame(doc({ home_away: "away", plate_appearances: [p] }));
  }
  it("ゴロ5-3: 一塁(P6)刺殺・三塁(P5)補殺", () => {
    const b = fldBox(defPA({ result: "OUT", fielding: { hit_to: "5", hit_type: "G", sequence: ["5", "3"], outs: [{ at: "1", type: "force", putout_position: "3", assist_positions: ["5"] }], errors: [] } }));
    expect(fld(b, "P6")!.po).toBe(1);
    expect(fld(b, "P5")!.a).toBe(1);
  });
  it("フライ(outs空・旧データ)はsequenceから刺殺導出: 中堅P7", () => {
    const b = fldBox(defPA({ result: "OUT", fielding: { hit_to: "8", sequence: ["8"], outs: [], errors: [] } }));
    expect(fld(b, "P7")!.po).toBe(1);
  });
  it("三振は捕手P2刺殺・投手に奪三振", () => {
    const b = fldBox(defPA({ result: "K", fielding: null }));
    expect(fld(b, "P2")!.po).toBe(1);
    expect(pit(b, "PP")!.k).toBe(1);
  });
  it("振り逃げ送球アウト(K+fielding.outs): 捕手は補殺・刺殺は一塁/二重計上なし", () => {
    const b = fldBox(defPA({ result: "K", fielding: { hit_to: "2", sequence: ["2", "3"], outs: [{ at: "1", type: "force" }], errors: [] } }));
    expect(fld(b, "P6")!.po).toBe(1); // 一塁刺殺
    expect(fld(b, "P2")!.a).toBe(1);  // 捕手補殺
    expect(fld(b, "P2")!.po).toBe(0); // 捕手の自動刺殺はしない
    expect(pit(b, "PP")!.k).toBe(1);  // 奪三振は計上
  });
  it("失策: 野手にE、刺殺なし", () => {
    const b = fldBox(defPA({ result: "E", fielding: { hit_to: "6", sequence: ["6"], outs: [], errors: [{ pos: "6", type: "fielding" }] } }));
    expect(fld(b, "P1")!.e).toBe(1);
    expect(fld(b, "P1")!.po).toBe(0);
  });
});

describe("盗塁死(baserunning_during)の守備記録 + INCは対打者に数えない", () => {
  const box = aggregateGame(
    doc({
      home_away: "away",
      plate_appearances: [
        defPA({ order: 1, batter_id: "O1", result: "K", fielding: null }),
        defPA({ order: 2, batter_id: "O2", result: "OUT", fielding: { hit_to: "9", sequence: ["9"], outs: [], errors: [] } }),
        defPA({ order: 3, batter_id: "O3", result: "BB", baserunning_after: [{ runner_id: "O3", from: null, to: "1" }] }),
        defPA({
          order: 4, batter_id: "O4", result: "INC", complete: false,
          baserunning_during: [{ event: "CS", runners: [{ runner_id: "O3", from: "1", to: "out" }], fielding: { sequence: ["2", "6"], outs: [{ at: "2", type: "tag" }] } }],
        }),
      ],
    })
  );
  it("盗塁死: 遊撃P1刺殺・捕手P2補殺", () => {
    expect(fld(box, "P1")!.po).toBe(1);
    expect(fld(box, "P2")!.a).toBe(1);
  });
  it("INC打席は対打者に数えない(BF=3)", () => {
    expect(pit(box, "PP")!.bf).toBe(3);
  });
});

describe("後攻(home)の1回表守備が欠落しない (snapshot seq0フォールバック)", () => {
  it("home: 1回表のゴロ5-3が一塁P6に計上", () => {
    const s = snap(LINEUP, { effective_from: { inning: 1, half: "bottom", before_order: null } }); // 自軍初打席=1回裏
    const box = aggregateGame(
      doc({
        home_away: "home",
        lineup_snapshots: [s],
        plate_appearances: [pa({ inning: 1, half: "top", batter_id: "O1", pitcher_id: "PP", result: "OUT", fielding: { hit_to: "5", sequence: ["5", "3"], outs: [{ at: "1", type: "force" }], errors: [] } })],
      })
    );
    expect(fld(box, "P6")!.po).toBe(1);
    expect(fld(box, "P5")!.a).toBe(1);
  });
});

describe("イニング途中の守備交代を before_order で切替", () => {
  it("order3は旧守備(P6一塁)、order6は新守備(P9一塁)", () => {
    const LINEUP2: [number | null, string, string][] = [
      [1, "6", "P1"], [2, "2", "P2"], [3, "7", "P3"], [4, "4", "P4"], [5, "5", "P5"],
      [6, "3", "P9"], [7, "8", "P7"], [8, "9", "P8"], [9, "DH", "P6"], [null, "1", "PP"],
    ];
    const s1 = snap(LINEUP2, { seq: 1, snapshot_id: "GTEST-NK-01", effective_from: { inning: 1, half: "bottom", before_order: 5 }, reason: "position_change" });
    const box = aggregateGame(
      doc({
        home_away: "away",
        lineup_snapshots: [snap(LINEUP), s1],
        plate_appearances: [
          defPA({ inning: 1, order: 3, batter_id: "O3", result: "OUT", fielding: { hit_to: "5", sequence: ["5", "3"], outs: [{ at: "1", type: "force" }], errors: [] } }),
          defPA({ inning: 1, order: 6, batter_id: "O6", result: "OUT", fielding: { hit_to: "4", sequence: ["4", "3"], outs: [{ at: "1", type: "force" }], errors: [] } }),
        ],
      })
    );
    expect(fld(box, "P6")!.po).toBe(1); // order3: 旧一塁
    expect(fld(box, "P9")!.po).toBe(1); // order6: 新一塁
  });
});

describe("自責点は記録値(doc.pitching)を正本", () => {
  it("per-run earned=0でも明示ER=5を採用", () => {
    const box = aggregateGame(
      doc({
        home_away: "away",
        pitching: [{ pitcher_id: "PP", earned_runs: 5 }],
        plate_appearances: [
          defPA({ order: 1, batter_id: "O1", result: "H1", runs: [{ runner_id: "O0", rbi: false, earned: false, cause: "error" }] }),
        ],
      })
    );
    expect(pit(box, "PP")!.er).toBe(5);
    expect(pit(box, "PP")!.r).toBe(1);
  });
});

describe("不戦勝・出欠・シーズン集計", () => {
  it("forfeit: PAなし・attendanceのみ", () => {
    const d = doc({
      home_away: null,
      lineup_snapshots: [],
      plate_appearances: [],
      attendance: [
        { player_id: "P1", status: "played", scope: "own" },
        { player_id: "P9", status: "bench", scope: "own" },
      ],
      game: { id: "GF", date: "2026-04-19", opponent: "X", league: null, home_away: null, result: { our_score: 0, their_score: 0, outcome: "win", decided_by: "forfeit" } },
    });
    const box = aggregateGame(d);
    expect(box.batting.length).toBe(0);
    const season = aggregateSeason([d]);
    const a1 = season.attendance.find((a) => a.player_id === "P1")!;
    const a9 = season.attendance.find((a) => a.player_id === "P9")!;
    expect(a1.games).toBe(1); // 在籍=出席
    expect(a9.games).toBe(1);
  });
  it("ラインスコア: 回別得点・安打・失策", () => {
    const d = doc({
      home_away: "away",
      plate_appearances: [
        pa({ inning: 1, half: "top", batter_id: "P1", result: "H1" }),
        pa({
          inning: 1, half: "top", batter_id: "P2", result: "HR",
          runs: [
            { runner_id: "P1", rbi: true, earned: true, cause: "hr" },
            { runner_id: "P2", rbi: true, earned: true, cause: "hr" },
          ],
        }),
        pa({ inning: 1, half: "bottom", batter_id: "O1", result: "E", fielding: { hit_to: "6", sequence: ["6"], outs: [], errors: [{ pos: "6", type: "fielding" }] } }),
      ],
    });
    const ls = gameLineScore(d);
    expect(ls.topRuns[0]).toBe(2);
    expect(ls.bottomRuns[0]).toBe(0);
    expect(ls.topHits).toBe(2);
    expect(ls.bottomErrors).toBe(1);
  });
  it("2試合のシーズン合算(安打が積算)", () => {
    const mk = () =>
      doc({ home_away: "away", plate_appearances: [pa({ order: 1, batter_id: "P1", result: "H1" })] });
    const season = aggregateSeason([mk(), mk()]);
    expect(season.batting.find((b) => b.player_id === "P1")!.h).toBe(2);
  });
  it("試合数は出席(attendance.games)ベース: 打席が無い試合も数える", () => {
    const g1 = doc({
      home_away: "away",
      plate_appearances: [pa({ order: 1, batter_id: "P1", result: "H1" })],
      attendance: [{ player_id: "P1", status: "played", scope: "own" }],
    });
    const g2 = doc({
      home_away: "away",
      plate_appearances: [], // P1は出場したが打席なし
      attendance: [{ player_id: "P1", status: "played", scope: "own" }],
    });
    const season = aggregateSeason([g1, g2]);
    const p1 = season.batting.find((b) => b.player_id === "P1")!;
    expect(p1.g).toBe(2); // 打席は1試合でも出場2試合
    expect(p1.h).toBe(1);
  });
});

describe("outsMade: baserunning_after の走者アウトも数える(FCの封殺は二重計上しない)", () => {
  it("打球で進塁中アウト(after to:out・守備out無し)を1アウトとして数える", () => {
    // 単打で一塁走者が次塁を狙ってアウト。fielding.outs は無し＝従来は数え漏れていたケース。
    expect(outsMade(pa({ result: "H1", baserunning_after: [{ runner_id: "P1", from: "1", to: "out" }] }))).toBe(1);
  });
  it("併殺を result=OUT + after の走者アウトで2アウトと数える", () => {
    expect(outsMade(pa({ result: "OUT", baserunning_after: [{ runner_id: "P1", from: "1", to: "out" }] }))).toBe(2);
  });
  it("FCの封殺(fielding.outs と after の両方に同走者)は二重計上せず1アウト", () => {
    const p = pa({ result: "FC", fielding: { hit_to: "6", sequence: ["6", "4"], outs: [{ at: "2", type: "force", runner_id: "P1" }], errors: [] }, baserunning_after: [{ runner_id: "P1", from: "1", to: "out" }] });
    expect(outsMade(p)).toBe(1);
  });
  it("通常の三振は1アウト(回帰)", () => {
    expect(outsMade(pa({ result: "K" }))).toBe(1);
  });
});

describe("deriveResult / displayResult: 導出優先・手入力は上書き", () => {
  // away(先攻)=自軍は表。表2点/裏0点 → 2-0で勝ち。
  const winDoc = () => doc({
    home_away: "away",
    plate_appearances: [
      pa({ inning: 1, half: "top", batter_id: "P1", result: "H1" }),
      pa({ inning: 1, half: "top", batter_id: "P2", result: "HR", runs: [
        { runner_id: "P1", rbi: true, earned: true, cause: "hr" },
        { runner_id: "P2", rbi: true, earned: true, cause: "hr" },
      ] }),
    ],
  });

  it("deriveResult: 記録スコアから自/相手/勝敗を導出(away)", () => {
    const d = deriveResult(winDoc());
    expect(d).toEqual({ our: 2, their: 0, outcome: "win" });
  });
  it("deriveResult: home(後攻)は自軍=裏。負け/引分/勝ちを判定", () => {
    // home: 表(相手)1点・裏(自軍)0点 → 0-1で負け
    const loss = doc({ home_away: "home", plate_appearances: [
      pa({ inning: 1, half: "top", batter_id: "O1", result: "HR", runs: [{ runner_id: "O1", rbi: true, earned: true, cause: "hr" }] }),
    ] });
    expect(deriveResult(loss)).toEqual({ our: 0, their: 1, outcome: "loss" });
    // 得点なし同士 → 引分
    const tie = doc({ home_away: "away", plate_appearances: [pa({ batter_id: "P1", result: "OUT" })] });
    expect(deriveResult(tie)).toEqual({ our: 0, their: 0, outcome: "tie" });
  });
  it("deriveResult: 打席が無ければ null(記録から導けない)", () => {
    expect(deriveResult(doc({ home_away: "away", plate_appearances: [] }))).toBeNull();
  });

  it("displayResult: 手入力(g.result)があればそれを正・manual:true・決着込み", () => {
    const d = winDoc();
    d.game.result = { our_score: 9, their_score: 1, outcome: "win", decided_by: "called" };
    expect(displayResult(d)).toEqual({ our: 9, their: 1, outcome: "win", decided_by: "called", manual: true });
  });
  it("displayResult: 手入力が無ければ導出・manual:false・decided_by:null", () => {
    expect(displayResult(winDoc())).toEqual({ our: 2, their: 0, outcome: "win", decided_by: null, manual: false });
  });
  it("displayResult: 手入力も打席も無ければ null", () => {
    expect(displayResult(doc({ home_away: null, plate_appearances: [] }))).toBeNull();
  });
});
