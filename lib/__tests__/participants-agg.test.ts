import { describe, it, expect } from "vitest";
import type { GameDoc, Participant } from "../types/v2";
import { aggregateGame } from "../agg";
import { aggregateGameP, aggregateSeasonP } from "../agg/participants";
import { doc, pa, snap, LINEUP } from "./fixtures";

// 新形式lineup: 旧P1..P9/PP を不透明参加者ID p1..p9/pp に置換（守備位置は同一）
const NEW_LINEUP: [number | null, string, string][] = LINEUP.map(([o, pos, pid]) => [
  o,
  pos,
  pid === "PP" ? "pp" : "p" + pid.slice(1),
]);
const rosterPlayerId = (pid: string) => (pid === "pp" ? "PP" : "P" + pid.slice(1));
const ROSTER_PARTS: Participant[] = NEW_LINEUP.map(([, , pid]) => ({
  id: pid,
  link: { kind: "roster", player_id: rosterPlayerId(pid) },
}));

const byId = (a: { player_id: string }, b: { player_id: string }) => a.player_id.localeCompare(b.player_id);
const stripId = <T extends { player_id: string }>(x: T) => {
  const { player_id, ...rest } = x;
  return rest;
};

describe("Phase2 参加者集計: 旧集計とのパリティ（同じ試合の旧形式/新形式で自軍成績が一致）", () => {
  // 同一の試合を「旧形式(接頭辞ID)」と「新形式(参加者ID)」で二重に組む
  const oldPAs = [
    pa({ inning: 1, half: "top", order: 1, batter_id: "P1", result: "H1" }),
    pa({ inning: 1, half: "top", order: 2, batter_id: "G001", result: "HR", runs: [{ runner_id: "G001", rbi: true, earned: true, cause: "hr" }] }),
    pa({
      inning: 1, half: "bottom", order: 1, batter_id: "O001", result: "OUT",
      fielding: { hit_to: "6", sequence: ["6", "3"], outs: [{ at: "1", type: "force", putout_position: "3", assist_positions: ["6"], runner_id: "O001" }], errors: [] },
    }),
    pa({ inning: 1, half: "bottom", order: 2, batter_id: "O002", result: "HR", runs: [{ runner_id: "O002", rbi: true, earned: true, cause: "hr", responsible_pitcher_id: "PP" }] }),
  ];
  const newPAs = [
    pa({ inning: 1, half: "top", order: 1, batter_id: "p1", result: "H1" }),
    pa({ inning: 1, half: "top", order: 2, batter_id: "g1", result: "HR", runs: [{ runner_id: "g1", rbi: true, earned: true, cause: "hr" }] }),
    pa({
      inning: 1, half: "bottom", order: 1, batter_id: "o1", result: "OUT",
      fielding: { hit_to: "6", sequence: ["6", "3"], outs: [{ at: "1", type: "force", putout_position: "3", assist_positions: ["6"], runner_id: "o1" }], errors: [] },
    }),
    pa({ inning: 1, half: "bottom", order: 2, batter_id: "o2", result: "HR", runs: [{ runner_id: "o2", rbi: true, earned: true, cause: "hr", responsible_pitcher_id: "pp" }] }),
  ];

  const oldDoc = doc({ home_away: "away", plate_appearances: oldPAs, additional_players: [{ id: "G001", name: "助っ人", type: "guest" }] });
  const newDoc = doc({
    home_away: "away",
    lineup_snapshots: [snap(NEW_LINEUP)],
    participants: [...ROSTER_PARTS, { id: "g1", link: { kind: "guest", name: "助っ人" } }],
    plate_appearances: newPAs,
  });
  const bOld = aggregateGame(oldDoc);
  const bNew = aggregateGameP(newDoc);

  it("自軍(own)の打撃/投手/守備の各行が完全一致", () => {
    expect(bNew.batting.filter((b) => b.scope === "own").sort(byId)).toEqual(bOld.batting.filter((b) => b.scope === "own").sort(byId));
    expect(bNew.pitching.filter((p) => p.scope === "own").sort(byId)).toEqual(bOld.pitching.filter((p) => p.scope === "own").sort(byId));
    expect(bNew.fielding.filter((f) => f.scope === "own").sort(byId)).toEqual(bOld.fielding.filter((f) => f.scope === "own").sort(byId));
  });

  it("助っ人(guest)の成績値は一致し、キーは game:pid（試合ローカル）になる", () => {
    const gOld = bOld.batting.filter((b) => b.scope === "guest");
    const gNew = bNew.batting.filter((b) => b.scope === "guest");
    expect(gOld.length).toBe(1);
    expect(gNew.length).toBe(1);
    expect(stripId(gNew[0])).toEqual(stripId(gOld[0])); // 数値は一致
    expect(gNew[0].player_id).toBe("GTEST:g1"); // 新キーは試合ローカル
  });

  it("相手の不透明ID(o1/o2)は participants に無く、集計行を一切作らない", () => {
    for (const arr of [bNew.batting, bNew.pitching, bNew.fielding]) {
      for (const line of arr) {
        expect(line.player_id).not.toContain("o1");
        expect(line.player_id).not.toContain("o2");
      }
    }
  });
});

describe("Phase2 シーズン集計: rosterは横断合算 / guestは試合ローカルで非合算 / 出欠はstatus", () => {
  const mkDoc = (id: string, guestResult: "HR" | "H1"): GameDoc => {
    const d = doc({
      home_away: "away",
      lineup_snapshots: [snap(NEW_LINEUP)],
      participants: [
        { id: "p1", link: { kind: "roster", player_id: "P1" } },
        { id: "g1", link: { kind: "guest", name: `助${id}` } },
      ],
      plate_appearances: [
        pa({ inning: 1, half: "top", order: 1, batter_id: "p1", result: "H1" }),
        pa({ inning: 1, half: "top", order: 2, batter_id: "g1", result: guestResult, runs: guestResult === "HR" ? [{ runner_id: "g1", rbi: true, earned: true, cause: "hr" }] : [] }),
      ],
    });
    d.game.id = id; // guestキーは game.id 依存
    return d;
  };

  const season = aggregateSeasonP([mkDoc("GA", "HR"), mkDoc("GB", "H1")]);

  it("roster P1 は2試合を合算し g=出場数=2", () => {
    const p1 = season.batting.find((b) => b.player_id === "P1");
    expect(p1).toBeDefined();
    expect(p1!.pa).toBe(2);
    expect(p1!.ab).toBe(2);
    expect(p1!.h).toBe(2);
    expect(p1!.g).toBe(2);
  });

  it("guest は GA:g1 と GB:g1 の別行に分かれ、合算されない", () => {
    const gs = season.batting.filter((b) => b.scope === "guest").map((b) => b.player_id).sort();
    expect(gs).toEqual(["GA:g1", "GB:g1"]);
  });

  it("出欠は participants 在籍から: P1 は2試合参加、guest は各1試合", () => {
    const p1 = season.attendance.find((a) => a.player_id === "P1");
    expect(p1!.games).toBe(2);
    expect(season.attendance.filter((a) => a.scope === "guest").map((a) => a.games)).toEqual([1, 1]);
  });
});
