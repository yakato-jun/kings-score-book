import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GameDoc } from "../types/v2";

// [助っ人ライフサイクル・失敗経路] applyOps の途中で op が throw した場合、そのコールで新規作成した助っ人マスタを
// 「どこからも参照されていなければ」掃除する。背景(2026-08-22 実障害): 版は残らないのに助っ人だけ残り、
// 失敗集計7回分の孤児がAI辞書を汚染してID取り違えの温床になった。

const deletePlayer = vi.fn(async () => {});
const loadGames = vi.fn(async (): Promise<GameDoc[]> => []);
vi.mock("../db/players", () => ({
  loadPlayers: vi.fn(async () => new Map([["P1", "一山"], ["P2", "二川"]])),
  deletePlayer: (...a: unknown[]) => deletePlayer(...(a as [])),
}));
vi.mock("../ops/players", () => ({
  createGuestPlayer: vi.fn(async (name: string) => ({ id: "P999", name: String(name).trim(), type: "guest" })),
}));
const baseDoc = (): GameDoc => ({
  schema_version: "2.0",
  game: { id: "G1", date: "2026-01-01", opponent: "T", league: null, home_away: "away", result: null },
  participants: [], lineup_snapshots: [], plate_appearances: [],
});
vi.mock("../db/games", () => ({
  loadWorking: vi.fn(async () => ({ doc: baseDoc(), gen: 1, draft: false })),
  loadGames: (...a: unknown[]) => loadGames(...(a as [])),
  draftGameIds: vi.fn(async () => []),
  loadGame: vi.fn(), commitGameDoc: vi.fn(), discardDrafts: vi.fn(), loadVersion: vi.fn(),
  publicGen: vi.fn(), currentGen: vi.fn(), deleteGameCompletely: vi.fn(),
  GenConflictError: class GenConflictError extends Error {},
}));
import { applyOps } from "../ops/games";

const failingOps = [
  { type: "setStartingLineup", rows: [{ order: 1, position: "6", player_id: "P1" }, { order: 2, position: "4", guest_name: "新助っ人" }] },
  { type: "changeDefense", inning: 2, half: "top", changes: [{ player_id: "P_UNKNOWN", to_position: "5" }] }, // マスタ未登録→throw
] as Parameters<typeof applyOps>[1];

beforeEach(() => { deletePlayer.mockClear(); loadGames.mockResolvedValue([]); });

describe("applyOps: 失敗時にこのコールで作った未参照の助っ人を掃除する", () => {
  it("後続opが throw → 元のエラーで reject し、作成した助っ人(P999)は削除される", async () => {
    await expect(applyOps("G1", failingOps)).rejects.toThrow(/マスタ未登録/);
    expect(deletePlayer).toHaveBeenCalledWith("P999");
  });
  it("作成した助っ人が他の試合から参照されていれば消さない(参照走査は全試合+全下書き)", async () => {
    loadGames.mockResolvedValue([{ ...baseDoc(), game: { ...baseDoc().game, id: "G_OTHER" }, participants: [{ id: "m1", link: { kind: "roster", player_id: "P999" } }] }]);
    await expect(applyOps("G1", failingOps)).rejects.toThrow(/マスタ未登録/);
    expect(deletePlayer).not.toHaveBeenCalled();
  });
});
