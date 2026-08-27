import { describe, it, expect } from "vitest";
import { migrateToParticipants, verifyMigration, MigrationError } from "../migrate/participants";
import { doc, pa } from "./fixtures";

const NAMES = new Map([["G001", "架空太郎"]]);

/** 実データの形を模した旧形式の試合（away=自軍top攻撃）: 助っ人・盗塁・守備アウト・責任投手・投手記録・控えのみ出欠 */
function oldGame() {
  return doc({
    home_away: "away",
    additional_players: [{ id: "G001", name: "架空太郎", type: "guest" }],
    attendance: [
      { player_id: "P1", status: "played", scope: "own" },
      { player_id: "P2", status: "played", scope: "own" },
      { player_id: "P11", status: "bench", scope: "own" }, // 控えのみ(試合データに出ない)
      { player_id: "G001", status: "played", scope: "guest" },
    ],
    pitching: [{ pitcher_id: "PP", earned_runs: 1 }],
    plate_appearances: [
      // 自軍攻撃(top): 安打→盗塁→助っ人HRで2得点
      pa({ inning: 1, half: "top", order: 1, batter_id: "P1", result: "H1", pitcher_id: "OX", catcher_id: "OY" }),
      pa({
        inning: 1, half: "top", order: 2, batter_id: "G001", result: "HR",
        baserunning_during: [{ event: "SB", runners: [{ runner_id: "P1", from: "1", to: "2" }] }],
        runs: [
          { runner_id: "P1", rbi: true, earned: true, cause: "hr" },
          { runner_id: "G001", rbi: true, earned: true, cause: "hr" },
        ],
      }),
      // 相手攻撃(bottom): 7番が出塁→3番のタイムリー(自軍投手PPが責任)。守備アウト・投捕保存値あり
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "O007", result: "H1", pitcher_id: "PP", catcher_id: "P2" }),
      pa({
        inning: 1, half: "bottom", order: 2, batter_id: "O003", result: "H2", pitcher_id: "PP", catcher_id: "P2",
        runners: { first: "O007", second: null, third: null },
        runs: [{ runner_id: "O007", rbi: true, earned: true, cause: "hit", responsible_pitcher_id: "PP" }],
        baserunning_after: [{ runner_id: "O007", from: "1", to: "home" }],
      }),
      pa({
        inning: 1, half: "bottom", order: 3, batter_id: "O004", result: "OUT", pitcher_id: "PP", catcher_id: "P2",
        fielding: { hit_to: "6", sequence: ["6", "3"], outs: [{ at: "1", type: "force", putout_position: "3", assist_positions: ["6"], runner_id: "O004" }], errors: [] },
      }),
    ],
  });
}

describe("migrateToParticipants: 変換と検証", () => {
  const { doc: newDoc, report } = migrateToParticipants(oldGame(), NAMES);

  it("verifyMigration が全チェック合格（数値0差分＋属性突合＋残存なし）", () => {
    const v = verifyMigration(oldGame(), newDoc, report, { masterIds: new Set(["P1", "P2", "P11", "PP", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]) });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("participants: roster(P)＋guest(実名)＋控えのみ が揃う(出欠のみの控えも participant になる)", () => {
    expect(report.participants.filter((p) => p.link.kind === "roster").length).toBe(11); // LINEUP10人 + 控えP11
    const guest = report.participants.find((p) => p.link.kind === "guest")!;
    expect(guest.link.kind === "guest" && guest.link.name).toBe("架空太郎");
    const bench = report.participants.find((p) => p.link.kind === "roster" && p.link.player_id === "P11");
    expect(bench).toBeDefined(); // 控えのみ(試合データに出ない)も participant として在籍
  });

  it("相手PA: opponent_slot に旧O数字を転記し、batter_id は side由来プレースホルダ", () => {
    const opp = newDoc.plate_appearances.filter((p) => p.half === "bottom");
    expect(opp.map((p) => p.opponent_slot)).toEqual([7, 3, 4]);
    expect(opp.map((p) => p.batter_id)).toEqual(["o7", "o3", "o4"]);
    // 相手走者参照(runs/baserunning)もプレースホルダへ。保存走者スナップは廃止
    expect(opp[1].runs[0].runner_id).toBe("o7");
    expect(opp[1].baserunning_after[0].runner_id).toBe("o7");
    expect(opp[1].runners).toBeUndefined();
  });

  it("責任投手(相手攻撃halfの自軍守備参照)は参加者IDへ写像される", () => {
    const tp = newDoc.plate_appearances.find((p) => p.half === "bottom" && p.opponent_slot === 3)!;
    const resp = tp.runs[0].responsible_pitcher_id!;
    const part = report.participants.find((p) => p.id === resp)!;
    expect(part.link.kind === "roster" && part.link.player_id).toBe("PP");
  });

  it("pitcher_id/catcher_id/attendance/additional_players/roster死フラグ は消える", () => {
    for (const p of newDoc.plate_appearances) {
      expect(p.pitcher_id).toBeUndefined();
      expect(p.catcher_id).toBeUndefined();
    }
    expect(newDoc.attendance).toBeUndefined();
    expect(newDoc.additional_players).toBeUndefined();
    for (const s of newDoc.lineup_snapshots) for (const r of s.roster) {
      expect(r.stat_scope).toBeUndefined();
      expect(r.include_in_season).toBeUndefined();
    }
  });

  it("決定論: 同じ入力から同じ idMap", () => {
    const again = migrateToParticipants(oldGame(), NAMES);
    expect([...again.report.idMap.entries()]).toEqual([...report.idMap.entries()]);
  });
});

describe("migrateToParticipants: ハード失敗（静かな損失を防ぐ）", () => {
  it("助っ人の実名が引けない → 失敗", () => {
    expect(() => migrateToParticipants(oldGame(), new Map())).toThrow(MigrationError);
  });

  it("自軍side参照に分類不能ID(X) → 失敗", () => {
    const d = oldGame();
    d.plate_appearances.push(pa({ inning: 2, half: "top", order: 1, batter_id: "X" }));
    expect(() => migrateToParticipants(d, NAMES)).toThrow(/分類不能/);
  });

  it("相手攻撃側に想定外ID(貸し借り等) → 失敗", () => {
    const d = oldGame();
    d.plate_appearances.push(pa({ inning: 2, half: "bottom", order: 1, batter_id: "G001" }));
    expect(() => migrateToParticipants(d, NAMES)).toThrow(/想定外のID/);
  });

  it("移行済みdoc → 失敗", () => {
    const { doc: newDoc } = migrateToParticipants(oldGame(), NAMES);
    expect(() => migrateToParticipants(newDoc, NAMES)).toThrow(/移行済み/);
  });
});

describe("migrateToParticipants: forfeit(不戦勝: PA無し・出欠のみ)", () => {
  it("home_away=null でも出欠だけの participants を作れる", () => {
    const d = doc({
      home_away: null,
      attendance: [
        { player_id: "P1", status: "bench", scope: "own" },
        { player_id: "P2", status: "bench", scope: "own" },
      ],
      lineup_snapshots: [],
      plate_appearances: [],
    });
    const { doc: nd, report } = migrateToParticipants(d, new Map());
    expect(report.participants.length).toBe(2);
    expect(report.participants.every((p) => p.link.kind === "roster")).toBe(true);
    const v = verifyMigration(d, nd, report, { masterIds: new Set(["P1", "P2"]) });
    expect(v.errors).toEqual([]);
  });
});
