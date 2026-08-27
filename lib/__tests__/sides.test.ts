import { describe, it, expect } from "vitest";
import { kingsBattingHalf, battingTeam, fieldingTeam, ownSidePaIds } from "../sides";
import { doc, pa } from "./fixtures";

describe("二軸 side モデル: 攻撃half", () => {
  it("away=先攻→自軍は表 / home=後攻→自軍は裏 / 不明は表", () => {
    expect(kingsBattingHalf(doc({ home_away: "away" }))).toBe("top");
    expect(kingsBattingHalf(doc({ home_away: "home" }))).toBe("bottom");
    expect(kingsBattingHalf(doc({ home_away: null }))).toBe("top");
  });

  it("battingTeam/fieldingTeam は攻撃half基準で自軍/相手を反転", () => {
    const d = doc({ home_away: "away" }); // 自軍=top攻撃
    expect(battingTeam(d, "top")).toBe("kings");
    expect(battingTeam(d, "bottom")).toBe("opponent");
    expect(fieldingTeam(d, "top")).toBe("opponent");
    expect(fieldingTeam(d, "bottom")).toBe("kings"); // 自軍守備half
  });
});

describe("ownSidePaIds: 自軍攻撃half=攻撃側スロットが自軍", () => {
  const d = doc({ home_away: "away" }); // 自軍=top

  it("打者・全走者・守備アウト走者・代走を自軍として列挙し、責任投手(相手投手)は拾わない", () => {
    const p = pa({
      half: "top",
      batter_id: "P1",
      runs: [{ runner_id: "P2", rbi: true, earned: true, cause: "hit", responsible_pitcher_id: "OX" }],
      baserunning_during: [
        {
          event: "SB",
          runners: [{ runner_id: "P3", from: "1", to: "2" }],
          fielding: { outs: [{ at: "2", type: "tag", runner_id: "P4" }] },
        },
      ],
      baserunning_after: [{ runner_id: "P5", from: "1", to: "2" }],
      fielding: { hit_to: null, sequence: [], outs: [{ at: "1", type: "force", runner_id: "P6" }], errors: [] },
      pinch_runner: { type: "pinch", runner_id: "P7" },
    });
    const ids = ownSidePaIds(d, p).sort();
    expect(ids).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7"]);
    expect(ids).not.toContain("OX"); // 自軍攻撃halfの責任投手は相手投手→対象外
  });

  it("同一走者の重複は一意化する", () => {
    const p = pa({
      half: "top",
      batter_id: "P1",
      runs: [{ runner_id: "P1", rbi: false, earned: true, cause: "hr" }],
      baserunning_after: [{ runner_id: "P1", from: null, to: "home" }],
    });
    expect(ownSidePaIds(d, p)).toEqual(["P1"]);
  });
});

describe("ownSidePaIds: 自軍守備half=守備側スロット(責任投手)だけが自軍", () => {
  const d = doc({ home_away: "away" }); // 自軍守備=bottom

  it("相手攻撃halfの行でも自軍責任投手を自軍として拾い、相手打者/走者は拾わない", () => {
    const q = pa({
      half: "bottom",
      batter_id: "O003",
      runs: [{ runner_id: "O001", rbi: false, earned: true, cause: "hit", responsible_pitcher_id: "PP" }],
      fielding: { hit_to: null, sequence: [], outs: [{ at: "2", type: "tag", runner_id: "O002" }], errors: [] },
    });
    const ids = ownSidePaIds(d, q);
    expect(ids).toEqual(["PP"]); // 自軍投手のみ
    expect(ids).not.toContain("O003");
    expect(ids).not.toContain("O001");
    expect(ids).not.toContain("O002");
  });
});

describe("ownSidePaIds: home(後攻)でも攻撃half基準で正しく反転", () => {
  const d = doc({ home_away: "home" }); // 自軍=bottom攻撃 / top守備

  it("自軍攻撃=bottom の打者を拾い、自軍守備=top では責任投手だけ拾う", () => {
    const bat = pa({ half: "bottom", batter_id: "P8", runs: [] });
    expect(ownSidePaIds(d, bat)).toEqual(["P8"]);

    const field = pa({
      half: "top",
      batter_id: "O001",
      runs: [{ runner_id: "O001", rbi: false, earned: true, cause: "hit", responsible_pitcher_id: "PP" }],
    });
    expect(ownSidePaIds(d, field)).toEqual(["PP"]);
  });
});
