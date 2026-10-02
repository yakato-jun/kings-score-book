/**
 * previewEditPA(採用ゲート用の純関数): 打席編集を doc に適用した結果を返すだけで、DBには一切触れず、元 doc も変えない。
 * 本番の reduceEditPA と同じ経路を通ることを、結果コードの差し替え(+スイープの再導出)で確認する。
 */
import { describe, it, expect, vi } from "vitest";
import { doc, pa } from "./fixtures";

vi.mock("../db/mongo", () => ({ getDb: vi.fn() }));
vi.mock("../db/players", () => ({ loadPlayers: vi.fn(), loadPlayerMap: vi.fn(), deletePlayer: vi.fn() }));
import { getDb } from "../db/mongo";
import { previewEditPA } from "../ops/games";

describe("previewEditPA", () => {
  it("編集を適用した新 doc を返し、元 doc は不変・DBアクセス無し", () => {
    const d = doc({
      home_away: "away",
      plate_appearances: [
        pa({ id: "b1", inning: 1, half: "top", order: 1, batter_id: "P1", result: "OUT" }),
        pa({ id: "b2", inning: 1, half: "top", order: 2, batter_id: "P2", result: "K" }),
      ],
    });
    const before = JSON.stringify(d);
    const masters = new Map([["P1", "一山"], ["P2", "二川"]]);
    const next = previewEditPA(d, { pa_id: "b1", inning: 1, half: "top", order: 1, result: "H1" }, masters);
    expect(next.plate_appearances[0].result).toBe("H1");
    expect(next.plate_appearances[1].result).toBe("K"); // 他打席は不変
    expect(JSON.stringify(d)).toBe(before); // 純関数: 入力を破壊しない
    expect(getDb).not.toHaveBeenCalled(); // DB非依存
  });

  it("存在しない打席は reduceEditPA と同じく throw する", () => {
    const d = doc({ home_away: "away", plate_appearances: [pa({ id: "b1", batter_id: "P1" })] });
    expect(() => previewEditPA(d, { inning: 9, half: "top", order: 1, result: "H1" }, new Map())).toThrow();
  });
});
