/**
 * [2026-08-18 実障害の確定版テスト] 12人打ち(DH3枠)のスタメンで3回表の守備変更が
 * 「守備位置変更: 対象選手が現在のラインアップに居ません(ベンチからの途中出場は…)」で全損した件。
 *
 * 根因(フェーズ1で確定): AIスキーマ(lib/ai/agent.ts)の rows.order description が「打順1-9」で
 * 12人打ち(order 1..12)が表現されず 10-12番の行が落ちた(仮説A)。reducer は12行/DH3枠を正しく通す(仮説B棄却)。
 *
 * 修正(フェーズ2)後の固定内容:
 *  - 12行(DH3枠)スタメン全員が lineup に入り、2回表・3回表の守備変更列がそのまま通る。
 *  - 旧ゲート撤去: ラインアップ外の選手を changeDefense すると order:null でその場で加わり
 *    participants にも自動追加(「ベンチ」という機構は無い=母集団は participants のみ)。
 *    =仮に行が落ちても全損しない(9行スタメン+3回表の実障害シナリオが成功する)。
 *  - masters に無いIDは従来どおりエラー(誰か分からないものは黙って作らない)。
 * ハーネスは ops-editor.test.ts と同流儀(mongo/players をモックし applyOps を畳む)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GameDoc, GameVersion } from "../types/v2";

vi.mock("../db/mongo", () => ({ getDb: vi.fn() }));
// 実障害の登場人物(森田/井上/渡辺/田村/上田)を含む12人のマスタ
vi.mock("../db/players", () => ({
  loadPlayers: vi.fn(async () => new Map([
    ["P1", "一山"], ["P2", "二川"], ["P3", "三田"], ["P4", "四谷"], ["P5", "五味"],
    ["P6", "井上"], ["P7", "七尾"], ["P8", "森田"], ["P9", "上田"], ["P10", "渡辺"],
    ["P11", "十一鳥"], ["P12", "田村"],
  ])),
}));
vi.mock("../ops/players", () => ({
  createGuestPlayer: vi.fn(async (name: string) => ({ id: "P999", name: String(name).trim(), type: "guest" })),
}));
import { getDb } from "../db/mongo";
import { applyOps } from "../ops/games";

let history: GameVersion[];
let gamesCol: Map<string, GameDoc>;

beforeEach(() => {
  history = [];
  gamesCol = new Map();
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
          deleteMany: async (q: { game_id: string }) => {
            const n = history.filter((h) => h.game_id === q.game_id).length;
            history = history.filter((h) => h.game_id !== q.game_id);
            return { deletedCount: n };
          },
        };
      }
      if (name === "game_notes") {
        return { deleteOne: async () => ({ deletedCount: 0 }) };
      }
      return {
        findOne: async (q: Record<string, string>) => gamesCol.get(q["game.id"]) ?? null,
        replaceOne: async (q: Record<string, string>, d: GameDoc) => { gamesCol.set(q["game.id"], d); return {}; },
        deleteOne: async (q: Record<string, string>) => ({ deletedCount: gamesCol.delete(q["game.id"]) ? 1 : 0 }),
      };
    },
  });
});

const tip = () => history[history.length - 1].snapshot;

// 実障害相当のスタメン12行: 遊二左一右三中DH投DH捕DH(DH3枠)。
// 6番三=井上 / 8番DH=森田 / 9番投=上田 / 10番DH=渡辺 / 12番DH=田村(守備変更列の登場人物)。
const rows12 = [
  { order: 1, position: "6", player_id: "P1" },
  { order: 2, position: "4", player_id: "P2" },
  { order: 3, position: "7", player_id: "P3" },
  { order: 4, position: "3", player_id: "P4" },
  { order: 5, position: "9", player_id: "P5" },
  { order: 6, position: "5", player_id: "P6" }, // 井上(三)
  { order: 7, position: "8", player_id: "P7" },
  { order: 8, position: "DH", player_id: "P8" }, // 森田(DH)
  { order: 9, position: "1", player_id: "P9" }, // 上田(投)
  { order: 10, position: "DH", player_id: "P10" }, // 渡辺(DH)
  { order: 11, position: "2", player_id: "P11" },
  { order: 12, position: "DH", player_id: "P12" }, // 田村(DH)
];

const mkGame = async (id: string, rows: typeof rows12) => {
  await applyOps(id, [
    { type: "setGameMeta", date: "2026-08-18", opponent: "X", home_away: "away" },
    { type: "setStartingLineup", rows },
  ]);
};

/** マスタID→この試合の参加者ID */
const pid = (d: GameDoc, master: string) =>
  d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === master)!.id;
/** 最新スナップショットでの守備位置 */
const posOf = (d: GameDoc, master: string) =>
  d.lineup_snapshots.at(-1)!.lineup.find((l) => l.player_id === pid(d, master))!.position_id;

describe("[2026-08-18 実障害] 12人打ち(DH3枠)スタメンと守備変更列", () => {
  it("(1) setStartingLineup 12行 → 全12人が lineup に入る(orderもDH3枠も落ちない)", async () => {
    await mkGame("G20260818A", rows12);
    const d = tip();
    const snap = d.lineup_snapshots.find((s) => s.seq === 0)!;
    expect(snap.lineup).toHaveLength(12);
    expect(snap.lineup.map((l) => l.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(snap.lineup.filter((l) => l.position_id === "DH")).toHaveLength(3);
    expect(d.participants).toHaveLength(12);
    for (const r of rows12) expect(pid(d, r.player_id)).toBeDefined();
  });

  it("(2) 2回表: 森田→三・井上→DH は成功する", async () => {
    await mkGame("G20260818B", rows12);
    await applyOps("G20260818B", [
      { type: "changeDefense", inning: 2, half: "top", changes: [
        { player_id: "P8", to_position: "5" }, // 森田→三
        { player_id: "P6", to_position: "DH" }, // 井上→DH
      ] },
    ]);
    const d = tip();
    expect(posOf(d, "P8")).toBe("5");
    expect(posOf(d, "P6")).toBe("DH");
    expect(d.lineup_snapshots.at(-1)!.lineup).toHaveLength(12); // 誰も消えない
  });

  it("(3) 3回表: 渡辺→三・森田→DH・田村→投・上田→DH が成功する(12行が揃っていれば通る=reducer は無罪)", async () => {
    await mkGame("G20260818C", rows12);
    await applyOps("G20260818C", [
      { type: "changeDefense", inning: 2, half: "top", changes: [
        { player_id: "P8", to_position: "5" },
        { player_id: "P6", to_position: "DH" },
      ] },
    ]);
    // 実障害ではここが「ラインアップに居ません」で全損した。12行が揃っていれば通るはず。
    await applyOps("G20260818C", [
      { type: "changeDefense", inning: 3, half: "top", changes: [
        { player_id: "P10", to_position: "5" }, // 渡辺→三
        { player_id: "P8", to_position: "DH" }, // 森田→DH
        { player_id: "P12", to_position: "1" }, // 田村→投
        { player_id: "P9", to_position: "DH" }, // 上田→DH
      ] },
    ]);
    const d = tip();
    expect(posOf(d, "P10")).toBe("5");
    expect(posOf(d, "P8")).toBe("DH");
    expect(posOf(d, "P12")).toBe("1");
    expect(posOf(d, "P9")).toBe("DH");
    expect(d.lineup_snapshots.at(-1)!.lineup.filter((l) => l.position_id === "DH")).toHaveLength(3);
  });

  it("[旧ゲート撤去] ラインアップ外の選手の changeDefense は order:null でその場で加わり participants にも追加(実障害シナリオが全損しない)", async () => {
    // 実障害の形: AI側で rows 10-12 が落ち、reducer に届いたのは9行スタメン。
    // 旧仕様は3回表が「ラインアップに居ません」で列ごと全損した。新仕様はその場で加えて成功する。
    await mkGame("G20260818D", rows12.slice(0, 9) as typeof rows12);
    await applyOps("G20260818D", [
      { type: "changeDefense", inning: 2, half: "top", changes: [
        { player_id: "P8", to_position: "5" },
        { player_id: "P6", to_position: "DH" },
      ] },
    ]);
    // 3回表: 渡辺(P10)・田村(P12)はラインアップ外(参加者ですらない)→マスタIDなので参加者を自動追加し lineup へ。
    await applyOps("G20260818D", [
      { type: "changeDefense", inning: 3, half: "top", changes: [
        { player_id: "P10", to_position: "5" },
        { player_id: "P8", to_position: "DH" },
        { player_id: "P12", to_position: "1" },
        { player_id: "P9", to_position: "DH" },
      ] },
    ]);
    const d = tip();
    expect(d.participants!.some((p) => p.link.kind === "roster" && p.link.player_id === "P10")).toBe(true);
    expect(d.participants!.some((p) => p.link.kind === "roster" && p.link.player_id === "P12")).toBe(true);
    const snap = d.lineup_snapshots.at(-1)!;
    // 途中から加わった2人は order を持たない(打順は別の事実。打席に立てば box 側の paSlots フォールバックが枠を拾う)。
    expect(snap.lineup.find((l) => l.player_id === pid(d, "P10"))).toMatchObject({ order: null, position_id: "5", automatic_out: false });
    expect(snap.lineup.find((l) => l.player_id === pid(d, "P12"))).toMatchObject({ order: null, position_id: "1", automatic_out: false });
    // roster にも追加され、既存の9枠は消えない。
    expect(snap.roster.some((r) => r.player_id === pid(d, "P10"))).toBe(true);
    expect(snap.roster.some((r) => r.player_id === pid(d, "P12"))).toBe(true);
    expect(snap.lineup).toHaveLength(11);
    expect(posOf(d, "P8")).toBe("DH");
    expect(posOf(d, "P9")).toBe("DH");
  });

  it("[従来どおり] masters に無いIDの changeDefense はエラー(誰か分からないものは黙って作らない)", async () => {
    await mkGame("G20260818E", rows12);
    await expect(
      applyOps("G20260818E", [
        { type: "changeDefense", inning: 2, half: "top", changes: [{ player_id: "P404", to_position: "5" }] },
      ])
    ).rejects.toThrow(/マスタ未登録/);
  });
});
