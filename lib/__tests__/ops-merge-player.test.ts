/**
 * [§12 P3/P5] mergePlayer(名寄せ＝出場を別選手IDへ付け替え)のユニットテスト。
 * 付け替え成功・to既在でskip・非破壊(版が積まれる)・from不在skip・検証(from≠to/マスタ実在)を固定する。
 * [§12 P5] 仕上げ＝skip 0件で全付け替え成功なら統合元マスタを削除(deletedFrom:true)／
 *   skip有り・付け替え範囲外に from が残る場合は削除しない(deletedFrom:false)ことも固定する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GameDoc, GameVersion } from "../types/v2";
import { doc, pa } from "./fixtures";

vi.mock("../db/mongo", () => ({ getDb: vi.fn() }));
vi.mock("../db/players", () => ({
  loadPlayers: vi.fn(async () => new Map([
    ["P1", "一山"], ["P2", "二川"], ["P3", "三田"],
  ])),
  deletePlayer: vi.fn(async () => {}),
}));
import { getDb } from "../db/mongo";
import { deletePlayer } from "../db/players";
import { mergePlayer } from "../ops/games";

let history: GameVersion[];
let gamesCol: Map<string, GameDoc>;

beforeEach(() => {
  history = [];
  gamesCol = new Map();
  vi.mocked(deletePlayer).mockClear();
  (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    collection: (name: string) => {
      if (name === "game_history") {
        return {
          findOne: async (q: Record<string, unknown>, opts?: { sort?: { gen: number } }) => {
            const rows = history.filter((h) => h.game_id === q.game_id && (q.draft === undefined || h.draft === q.draft));
            if (opts?.sort?.gen === -1) rows.sort((a, b) => b.gen - a.gen);
            return rows[0] ?? null;
          },
          insertOne: async (v: GameVersion) => { history.push(v); return { insertedId: "x" }; },
        };
      }
      // "games" コレクション: loadGames=find().sort().toArray() / loadGame=findOne / commit=replaceOne
      return {
        find: () => ({ sort: () => ({ toArray: async () => [...gamesCol.values()] }) }),
        findOne: async (q: Record<string, string>) => gamesCol.get(q["game.id"]) ?? null,
        replaceOne: async (q: Record<string, string>, d: GameDoc) => { gamesCol.set(q["game.id"], d); return {}; },
      };
    },
  });
});

const tipOf = (gameId: string) => history.filter((h) => h.game_id === gameId).at(-1)!.snapshot;

/** 新形式のシード試合(participants持ち)を games に置く */
function seed(id: string, over: Partial<GameDoc> = {}): GameDoc {
  const base = doc({ home_away: "away", ...over });
  delete base.attendance;
  delete base.additional_players;
  base.game = { ...base.game, id };
  gamesCol.set(id, base);
  return base;
}

describe("mergePlayer: 名寄せ(出場を別選手IDへ付け替え)", () => {
  it("付け替え成功: from の roster link.player_id が to に変わり、版が非破壊で積まれる", async () => {
    seed("GM1", {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m2", link: { kind: "roster", player_id: "P2" } },
      ],
      plate_appearances: [pa({ inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" })],
    });
    const before = history.length;
    const r = await mergePlayer("P1", "P3");

    expect(r.updatedGames).toEqual(["GM1"]);
    expect(r.skipped).toEqual([]);
    const parts = tipOf("GM1").participants!;
    // m1(=P1) の link が P3 へ付け替え。打席参照(m1)はそのまま追従。m2 は不変。
    expect(parts.find((p) => p.id === "m1")!.link).toEqual({ kind: "roster", player_id: "P3" });
    expect(parts.find((p) => p.id === "m2")!.link).toEqual({ kind: "roster", player_id: "P2" });
    expect(tipOf("GM1").plate_appearances[0].batter_id).toBe("m1");
    // 非破壊: 版が1つ積まれ、公開版(draft:false)として反映
    expect(history.length).toBe(before + 1);
    expect(history.at(-1)!.draft).toBe(false);
    expect(history.at(-1)!.edit_source).toBe("manual");
    // [§12 P5] skip 0件＝from は現公開版のどこからも参照されなくなった＝統合元マスタを削除
    expect(r.deletedFrom).toBe(true);
    expect(deletePlayer).toHaveBeenCalledWith("P1");
  });

  it("to既在でskip: 同一試合に付け替え先が既に参加していれば二重計上防止でskip(版は積まれない)", async () => {
    seed("GM2", {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m2", link: { kind: "roster", player_id: "P3" } }, // to=P3 が既在
      ],
    });
    const before = history.length;
    const r = await mergePlayer("P1", "P3");

    expect(r.updatedGames).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].gameId).toBe("GM2");
    expect(r.skipped[0].reason).toMatch(/二重計上/);
    expect(history.length).toBe(before); // コミットされない(元のlinkのまま)
    expect(gamesCol.get("GM2")!.participants!.find((p) => p.id === "m1")!.link).toEqual({ kind: "roster", player_id: "P1" });
    // [§12 P5] skip有り＝from はまだ参照が残る＝統合元マスタは削除しない
    expect(r.deletedFrom).toBe(false);
    expect(deletePlayer).not.toHaveBeenCalled();
  });

  it("from不在skip: gameIds 指定で from が居ない試合は skip(付け替えなし)", async () => {
    seed("GM3", { participants: [{ id: "m1", link: { kind: "roster", player_id: "P2" } }] });
    const before = history.length;
    const r = await mergePlayer("P1", "P3", { gameIds: ["GM3"] });

    expect(r.updatedGames).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].gameId).toBe("GM3");
    expect(history.length).toBe(before);
  });

  it("gameIds 未指定は from が出場する全試合を対象(from不在は候補にせずskipノイズを出さない)", async () => {
    seed("GM4", { participants: [{ id: "m1", link: { kind: "roster", player_id: "P1" } }] });
    seed("GM5", { participants: [{ id: "m1", link: { kind: "roster", player_id: "P1" } }] });
    seed("GM6", { participants: [{ id: "m1", link: { kind: "roster", player_id: "P2" } }] }); // from不在
    const r = await mergePlayer("P1", "P3");

    expect(new Set(r.updatedGames)).toEqual(new Set(["GM4", "GM5"]));
    expect(r.skipped).toEqual([]);
    expect(tipOf("GM4").participants!.find((p) => p.id === "m1")!.link).toEqual({ kind: "roster", player_id: "P3" });
    expect(tipOf("GM5").participants!.find((p) => p.id === "m1")!.link).toEqual({ kind: "roster", player_id: "P3" });
    // [§12 P5] 全出場を付け替え切った＝統合元マスタを削除
    expect(r.deletedFrom).toBe(true);
    expect(deletePlayer).toHaveBeenCalledWith("P1");
  });

  it("[§12 P5] gameIds限定で範囲外の試合に from が残るなら削除しない(skip 0でも参照が残る)", async () => {
    seed("GM7", { participants: [{ id: "m1", link: { kind: "roster", player_id: "P1" } }] });
    seed("GM8", { participants: [{ id: "m1", link: { kind: "roster", player_id: "P1" } }] }); // 範囲外に from が残る
    const r = await mergePlayer("P1", "P3", { gameIds: ["GM7"] });

    // GM7 だけ付け替え・skip 0件だが、GM8 に from(P1) がまだ出ているため統合元マスタは消さない
    expect(r.updatedGames).toEqual(["GM7"]);
    expect(r.skipped).toEqual([]);
    expect(r.deletedFrom).toBe(false);
    expect(deletePlayer).not.toHaveBeenCalled();
    expect(gamesCol.get("GM8")!.participants!.find((p) => p.id === "m1")!.link).toEqual({ kind: "roster", player_id: "P1" });
  });

  it("検証: from≠to・両者マスタ実在を強制(無ければthrow・コミットしない)", async () => {
    await expect(mergePlayer("P1", "P1")).rejects.toThrow(/同一/);
    await expect(mergePlayer("P1", "P99")).rejects.toThrow(/選手マスタにありません/);
    await expect(mergePlayer("P99", "P1")).rejects.toThrow(/選手マスタにありません/);
    expect(history.length).toBe(0);
  });
});
