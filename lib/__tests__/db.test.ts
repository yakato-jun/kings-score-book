import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GameDoc } from "../types/v2";
import { doc } from "./fixtures";

// DBモック: getDb を差し替え、Atlas に接続せずデータアクセス層(loadGames/loadGame)を検証
vi.mock("../db/mongo", () => ({ getDb: vi.fn() }));
import { getDb } from "../db/mongo";
import { loadGames, loadGame } from "../db/games";

const games: GameDoc[] = [
  { ...doc({ home_away: "away" }), game: { id: "G1", date: "2026-01-01", opponent: "A", league: null, home_away: "away", dh: false } },
  { ...doc({ home_away: "home" }), game: { id: "G2", date: "2026-02-01", opponent: "B", league: null, home_away: "home", dh: false } },
];

beforeEach(() => {
  // find().sort().toArray() / findOne() を返すフェイクcollectionを持つフェイクdb
  (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    collection: () => ({
      find: () => ({ sort: () => ({ toArray: async () => games }) }),
      findOne: async (q: Record<string, string>) =>
        games.find((g) => g.game.id === q["game.id"]) ?? null,
    }),
  });
});

describe("データアクセス層 (getDbモック)", () => {
  it("loadGames は全試合を返す", async () => {
    const r = await loadGames();
    expect(r.map((g) => g.game.id)).toEqual(["G1", "G2"]);
  });
  it("loadGame は id 一致を返す", async () => {
    expect((await loadGame("G2"))?.game.opponent).toBe("B");
  });
  it("loadGame は不一致で null", async () => {
    expect(await loadGame("NOPE")).toBeNull();
  });
});
