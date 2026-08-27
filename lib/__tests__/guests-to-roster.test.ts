/**
 * [§12.3 助っ人一本化 移行] migrateGuestsToRoster(純関数コア)/verifyGuestsToRoster のユニットテスト(DB非依存)。
 *   was復元／純guest新規(allocate呼ばれる)／冪等(origin既存→再利用・allocate呼ばれない)／
 *   name無し=unresolved・link不変／guest0=doc完全不変(参照等価/バイト一致)／roster混在で roster不変／検証0差分。
 */
import { describe, it, expect, vi } from "vitest";
import { migrateGuestsToRoster, verifyGuestsToRoster } from "../migrate/guests_to_roster";
import type { GameDoc, Player, Participant, PlateAppearance } from "../types/v2";

/** 種別guestの新マスタを返す allocate スタブ(既定 P100)。 */
function allocStub(id = "P100") {
  return vi.fn((seed: { game_id: string; participant_id: string; name: string }): Player => ({
    id,
    name: seed.name,
    type: "guest",
    origin: { kind: "guest_migration", game_id: seed.game_id, participant_id: seed.participant_id },
  }));
}

function pa(over: Partial<PlateAppearance>): PlateAppearance {
  return { inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1", complete: true, runs: [], baserunning_after: [], ...over };
}

function gdoc(participants: Participant[], over: Partial<GameDoc> = {}): GameDoc {
  return {
    schema_version: "2.0",
    game: { id: "GX", date: "2026-01-01", opponent: "T", league: null, home_away: "away", result: null },
    participants,
    lineup_snapshots: [],
    plate_appearances: [],
    ...over,
  };
}

describe("migrateGuestsToRoster: 変換規則", () => {
  it("was有り(旧detach跡)＝元マスタが実在すれば roster へ復元(allocate呼ばれない)", () => {
    const players = new Map<string, Player>([["P005", { id: "P005", name: "元太郎", type: "member" }]]);
    const alloc = allocStub();
    const input = gdoc([{ id: "m1", link: { kind: "guest", name: "元太郎", was: "P005" } }]);

    const res = migrateGuestsToRoster(input, players, alloc);
    expect(res.doc.participants![0].link).toEqual({ kind: "roster", player_id: "P005" });
    expect(res.report.wasRestored).toBe(1);
    expect(alloc).not.toHaveBeenCalled();
    expect(res.newMasters).toEqual([]);
  });

  it("was がマスタ実在しない → unresolved・link不変・doc参照等価", () => {
    const alloc = allocStub();
    const input = gdoc([{ id: "m1", link: { kind: "guest", was: "P999" } }]);

    const res = migrateGuestsToRoster(input, new Map(), alloc);
    expect(res.report.unresolved).toEqual([{ game_id: "GX", participant_id: "m1" }]);
    expect(res.report.wasRestored).toBe(0);
    expect(res.doc).toBe(input); // 実質無変更＝参照等価
    expect(alloc).not.toHaveBeenCalled();
  });

  it("純guest(name有り) → allocate で種別guestの新マスタを採番し roster へ", () => {
    const alloc = allocStub("P100");
    const input = gdoc([{ id: "m1", link: { kind: "guest", name: "助っ人太郎" } }]);

    const res = migrateGuestsToRoster(input, new Map(), alloc);
    expect(alloc).toHaveBeenCalledTimes(1);
    expect(alloc).toHaveBeenCalledWith({ game_id: "GX", participant_id: "m1", name: "助っ人太郎" });
    expect(res.doc.participants![0].link).toEqual({ kind: "roster", player_id: "P100" });
    expect(res.report.newMasters).toBe(1);
    expect(res.newMasters).toEqual([
      { id: "P100", name: "助っ人太郎", type: "guest", origin: { kind: "guest_migration", game_id: "GX", participant_id: "m1" } },
    ]);
  });

  it("冪等: 同一origin({game_id,participant_id})の既存マスタがあれば再利用(allocate呼ばれない)", () => {
    const existing: Player = { id: "P100", name: "助っ人太郎", type: "guest", origin: { kind: "guest_migration", game_id: "GX", participant_id: "m1" } };
    const players = new Map<string, Player>([["P100", existing]]);
    const alloc = allocStub("P200"); // 呼ばれたら別IDになる＝呼ばれないことを担保
    const input = gdoc([{ id: "m1", link: { kind: "guest", name: "助っ人太郎(別表記)" } }]);

    const res = migrateGuestsToRoster(input, players, alloc);
    expect(alloc).not.toHaveBeenCalled();
    expect(res.doc.participants![0].link).toEqual({ kind: "roster", player_id: "P100" });
    expect(res.report.idempotentReused).toBe(1);
    expect(res.newMasters).toEqual([]);
  });

  it("name も was も無い純guest → unresolved に積む(連番マスタを黙って作らない)・link不変", () => {
    const alloc = allocStub();
    const input = gdoc([{ id: "m1", link: { kind: "guest" } }]);

    const res = migrateGuestsToRoster(input, new Map(), alloc);
    expect(alloc).not.toHaveBeenCalled();
    expect(res.report.unresolved).toEqual([{ game_id: "GX", participant_id: "m1" }]);
    expect(res.doc.participants![0].link).toEqual({ kind: "guest" });
    expect(res.doc).toBe(input); // 参照等価
  });

  it("guest0 の試合＝doc 完全不変(参照等価＋バイト一致)", () => {
    const input = gdoc([
      { id: "m1", link: { kind: "roster", player_id: "P1" } },
      { id: "m2", link: { kind: "roster", player_id: "P2" } },
    ]);
    const before = JSON.stringify(input);
    const alloc = allocStub();

    const res = migrateGuestsToRoster(input, new Map(), alloc);
    expect(res.doc).toBe(input); // 参照等価
    expect(JSON.stringify(res.doc)).toBe(before); // バイト一致
    expect(res.report.guestLinks).toBe(0);
    expect(res.newMasters).toEqual([]);
    expect(alloc).not.toHaveBeenCalled();
  });

  it("roster 混在: roster 参加者は同一参照のまま(不変)・guest だけ付け替え", () => {
    const rosterPart: Participant = { id: "m1", link: { kind: "roster", player_id: "P1" } };
    const input = gdoc([rosterPart, { id: "m2", link: { kind: "guest", name: "助っ人" } }]);
    const alloc = allocStub("P100");

    const res = migrateGuestsToRoster(input, new Map(), alloc);
    expect(res.doc.participants![0]).toBe(rosterPart); // roster 参加者オブジェクトは同一参照
    expect(res.doc.participants![1].link).toEqual({ kind: "roster", player_id: "P100" });
    expect(alloc).toHaveBeenCalledTimes(1);
  });
});

describe("verifyGuestsToRoster: 旧guestキー→新player_id 翻訳の0差分突合", () => {
  it("純助っ人系: 集計0差分・翻訳キー数を系統別に数える", () => {
    const oldDoc = gdoc([{ id: "m1", link: { kind: "guest", name: "助っ人" } }], {
      plate_appearances: [pa({ batter_id: "m1", result: "H1" })],
    });
    const { doc: newDoc, newMasters } = migrateGuestsToRoster(oldDoc, new Map(), allocStub("P100"));
    const masters = new Map(newMasters.map((m) => [m.id, m]));

    const v = verifyGuestsToRoster(oldDoc, newDoc, masters);
    expect(v.ok).toBe(true);
    expect(v.fail).toBe(0);
    expect(v.pureGuestKeys).toBe(1);
    expect(v.wasRestoredKeys).toBe(0);
  });

  it("was復元系: 元マスタへ翻訳して0差分・was系統として数える", () => {
    const players = new Map<string, Player>([["P005", { id: "P005", name: "元太郎", type: "member" }]]);
    const oldDoc = gdoc([{ id: "m1", link: { kind: "guest", was: "P005" } }], {
      plate_appearances: [pa({ batter_id: "m1", result: "H2" })],
    });
    const { doc: newDoc } = migrateGuestsToRoster(oldDoc, players, allocStub());

    const v = verifyGuestsToRoster(oldDoc, newDoc, players);
    expect(v.ok).toBe(true);
    expect(v.wasRestoredKeys).toBe(1);
    expect(v.pureGuestKeys).toBe(0);
  });

  it("翻訳先マスタが不在なら fail>0(存在しないIDへ繋いでいないか検査)", () => {
    const oldDoc = gdoc([{ id: "m1", link: { kind: "guest", name: "助っ人" } }], {
      plate_appearances: [pa({ batter_id: "m1", result: "H1" })],
    });
    const { doc: newDoc } = migrateGuestsToRoster(oldDoc, new Map(), allocStub("P100"));

    const v = verifyGuestsToRoster(oldDoc, newDoc, new Map()); // masters 空＝翻訳先不在
    expect(v.ok).toBe(false);
    expect(v.fail).toBeGreaterThan(0);
    expect(v.diffs.some((d) => d.includes("翻訳先マスタ不在"))).toBe(true);
  });

  it("集計が食い違えば fail>0(値を壊していないかの0差分ゲート)", () => {
    const oldDoc = gdoc([{ id: "m1", link: { kind: "guest", name: "助っ人" } }], {
      plate_appearances: [pa({ batter_id: "m1", result: "H1" })],
    });
    const { doc: newDoc, newMasters } = migrateGuestsToRoster(oldDoc, new Map(), allocStub("P100"));
    const masters = new Map(newMasters.map((m) => [m.id, m]));
    // newDoc 側にだけ余分な打席を足して集計を意図的にズラす。
    const tampered: GameDoc = { ...newDoc, plate_appearances: [...newDoc.plate_appearances, pa({ batter_id: "m1", result: "HR" })] };

    const v = verifyGuestsToRoster(oldDoc, tampered, masters);
    expect(v.ok).toBe(false);
    expect(v.diffs.some((d) => d.includes("batting"))).toBe(true);
  });
});
