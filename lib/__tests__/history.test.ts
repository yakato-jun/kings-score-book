import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GameDoc, GameVersion } from "../types/v2";
import { doc } from "./fixtures";

// getDb をモックし、game_history(append) と games(最新) の2コレクションをメモリで再現
vi.mock("../db/mongo", () => ({ getDb: vi.fn() }));
import { getDb } from "../db/mongo";
import { commitGameDoc, currentGen, loadWorking, GenConflictError } from "../db/games";

const G = (id: string): GameDoc => ({
  ...doc({ home_away: "away" }),
  game: { id, date: "2026-01-01", opponent: "X", league: null, home_away: "away", dh: false },
});

let history: GameVersion[];
let gamesCol: Map<string, GameDoc>;

beforeEach(() => {
  history = [];
  gamesCol = new Map();
  (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    collection: (name: string) => {
      if (name === "game_history") {
        return {
          findOne: async (q: { game_id: string }, opts?: { sort?: { gen: number } }) => {
            const rows = history.filter((h) => h.game_id === q.game_id);
            if (opts?.sort?.gen === -1) rows.sort((a, b) => b.gen - a.gen);
            return rows[0] ?? null;
          },
          insertOne: async (v: GameVersion) => { history.push(v); return { insertedId: "x" }; },
        };
      }
      return {
        findOne: async (q: Record<string, string>) => gamesCol.get(q["game.id"]) ?? null,
        replaceOne: async (q: Record<string, string>, d: GameDoc) => { gamesCol.set(q["game.id"], d); return {}; },
      };
    },
  });
});

describe("commitGameDoc(世代・線形append)", () => {
  it("初回は gen1、history1版(draft:false)、games(最新)に反映", async () => {
    const r = await commitGameDoc(G("G1"), { source: "ui" });
    expect(r.gen).toBe(1);
    expect(history).toHaveLength(1);
    expect(history[0].draft).toBe(false);
    expect(gamesCol.get("G1")).toBeTruthy();
  });

  it("gen は連番で増える", async () => {
    await commitGameDoc(G("G1"), { source: "ui" });
    expect((await commitGameDoc(G("G1"), { source: "ui" })).gen).toBe(2);
    expect(history).toHaveLength(2);
  });

  it("draft は history に積むが games(最新)を更新しない", async () => {
    await commitGameDoc(G("G1"), { source: "ui" }); // gen1 publish
    const published = gamesCol.get("G1");
    await commitGameDoc(
      { ...G("G1"), attendance: [{ player_id: "P1", status: "played", scope: "own" }] },
      { source: "ai", draft: true } // gen2 draft
    );
    expect(history).toHaveLength(2);
    expect(history[1].draft).toBe(true);
    expect(gamesCol.get("G1")).toBe(published); // games は gen1 のまま
    const w = await loadWorking("G1");
    expect([w?.gen, w?.draft]).toEqual([2, true]); // 作業状態は draft 最新版
  });

  it("base_gen が先端と違えば GenConflictError(楽観ロック)、一致なら通る", async () => {
    await commitGameDoc(G("G1"), { source: "ui" }); // tip=1
    await expect(commitGameDoc(G("G1"), { source: "ui", base_gen: 0 })).rejects.toBeInstanceOf(GenConflictError);
    expect((await commitGameDoc(G("G1"), { source: "ui", base_gen: 1 })).gen).toBe(2);
  });

  it("履歴なしの試合は currentGen=0 / loadWorking は games を gen0 で返す", async () => {
    gamesCol.set("G9", G("G9"));
    expect(await currentGen("G9")).toBe(0);
    expect((await loadWorking("G9"))?.gen).toBe(0);
  });
});
