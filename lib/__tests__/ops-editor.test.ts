/**
 * Phase C(§10.3 op層拡張)のテスト。
 * C-1 挿入(境界再マップ/スロットシフト/先頭挿入)・C-2 選手交代/退場・C-3 打順変更・
 * C-4 守備交代の打席粒度タイミング・C-5 投手記録(全置換/参照エラー/AI-replaceクリア/R7・R8)・
 * C-6 受理フィールド拡張(振り逃げ/申告敬遠/スロット修正/代走/run_overrides)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GameDoc, GameVersion } from "../types/v2";
import { doc, pa } from "./fixtures";

vi.mock("../db/mongo", () => ({ getDb: vi.fn() }));
vi.mock("../db/players", () => ({
  loadPlayers: vi.fn(async () => new Map([
    ["P1", "一山"], ["P2", "二川"], ["P3", "三田"], ["P4", "四谷"], ["P5", "五味"], ["P6", "六郷"],
    ["P10", "十条"], ["PP", "投森"],
  ])),
}));
// [§12 P1] 助っ人名は createGuestPlayer(ops/players)で種別guestのマスタ選手(player_id)へ解決される。mint-onlyスタブ。
const { guestMock } = vi.hoisted(() => ({ guestMock: { made: [] as { id: string; name: string; type: string }[], seq: 0 } }));
vi.mock("../ops/players", () => ({
  createGuestPlayer: vi.fn(async (name: string) => {
    const p = { id: `P${900 + ++guestMock.seq}`, name: String(name).trim(), type: "guest" };
    guestMock.made.push(p);
    return p;
  }),
}));
import { getDb } from "../db/mongo";
import { applyOps, generateGameId, newGameId, upsertGameMeta } from "../ops/games";
import { deriveNextPA, derivePAStates, deriveResponsiblePitchers } from "../ops/gamestate";
import { validateGame } from "../ops/validate";
import { effectiveSnapshot, posMap, outsMade } from "../agg";
import { aggregateGameP } from "../agg/participants";
import type { DirectStatLine } from "../types/v2";

let history: GameVersion[];
let gamesCol: Map<string, GameDoc>;

beforeEach(() => {
  history = [];
  gamesCol = new Map();
  guestMock.made = [];
  guestMock.seq = 0;
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
        deleteOne: async (q: Record<string, string>) => {
          const had = gamesCol.delete(q["game.id"]);
          return { deletedCount: had ? 1 : 0 };
        },
      };
    },
  });
});

const tip = () => history[history.length - 1].snapshot;

/** 新形式のシード試合(participants持ち・旧フィールド無し)を games に置く */
function seed(id: string, over: Partial<GameDoc> = {}): GameDoc {
  const base = doc({ home_away: "away", ...over });
  delete base.attendance;
  delete base.additional_players;
  base.game = { ...base.game, id };
  gamesCol.set(id, base);
  return base;
}

/** away(自軍先攻)の試合をスタメン付きで作る */
const mkGame = async (id: string, rows = [
  { order: 1, position: "6", player_id: "P1" },
  { order: 2, position: "2", player_id: "P2" },
  { order: 3, position: "7", player_id: "P3" },
]) => {
  await applyOps(id, [
    { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
    { type: "setStartingLineup", rows },
  ]);
};

describe("C-1 insertPlateAppearance: 挿入(order/交代境界/スロットの再マップ＋スイープ)", () => {
  it("中間挿入: 後続orderが+1・挿入位置より後の交代境界が+1・相手スロットとoNが追従・盤面再導出", async () => {
    await mkGame("G20990201");
    await applyOps("G20990201", [
      { type: "addPlateAppearance", half: "bottom", result: "OUT" }, // o1
      { type: "addPlateAppearance", half: "bottom", result: "K" }, // o2
      { type: "changeDefense", inning: 1, half: "bottom", changes: [{ player_id: "P1", to_position: "1" }] }, // 境界 before_order=3
      { type: "addPlateAppearance", half: "bottom", result: "OUT" }, // o3
    ]);
    const firstId = tip().plate_appearances.filter((p) => p.half === "bottom")[0].id!;
    // 1人目の直後に H1 を挿入(記録漏れの後入れ)
    await applyOps("G20990201", [{ type: "insertPlateAppearance", inning: 1, half: "bottom", after_pa_id: firstId, result: "H1" }]);
    const d = tip();
    const opp = d.plate_appearances.filter((p) => p.half === "bottom").sort((a, b) => a.order - b.order);
    // [§10.6 item11] 後続打席の打順スロット機械回転は撤去＝観測記録値は据え置き(データ破壊防止)。挿入PA自身の既定スロットのみ提案。
    expect(opp.map((p) => [p.order, p.result, p.opponent_slot, p.batter_id])).toEqual([
      [1, "OUT", 1, "o1"],
      [2, "H1", 2, "o2"], // 挿入PA: 既定スロット=直前+1(この新PA限定のassist)
      [3, "K", 2, "o2"], // 旧#2: スロット据え置き(機械回転しない)
      [4, "OUT", 3, "o3"], // 旧#3: 据え置き
    ]);
    // 交代境界: 挿入位置(2)より後の 3 → 4 へ再マップ(維持)
    expect(d.lineup_snapshots.at(-1)!.effective_from.before_order).toBe(4);
    // スイープ: 挿入PAの開始時アウトは先頭からの再導出(#1がOUT)。outsは主張値でなく導出で読む(§10.6)。
    expect(derivePAStates(d).get(opp[1])!.outs).toBe(1);
    // 不変IDが採番されている
    expect(opp[1].id).toMatch(/^b\d+$/);
  });

  it("境界==挿入位置は不変(挿入PAは新スナップショットの下に入る)", async () => {
    await mkGame("G20990202");
    await applyOps("G20990202", [
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
      { type: "addPlateAppearance", half: "bottom", result: "K" },
      { type: "changeDefense", inning: 1, half: "bottom", changes: [{ player_id: "P1", to_position: "1" }] }, // before_order=3
    ]);
    const secondId = tip().plate_appearances.filter((p) => p.half === "bottom")[1].id!;
    await applyOps("G20990202", [{ type: "insertPlateAppearance", inning: 1, half: "bottom", after_pa_id: secondId, result: "OUT" }]);
    expect(tip().lineup_snapshots.at(-1)!.effective_from.before_order).toBe(3);
  });

  it("先頭挿入(after_pa_id未指定): 挿入PAは先頭スロット・既存スロットは据え置き(非回転)・代打は自動参加", async () => {
    await mkGame("G20990203");
    await applyOps("G20990203", [
      { type: "addPlateAppearance", result: "H1" }, // slot1 P1
      { type: "addPlateAppearance", result: "OUT" }, // slot2 P2
    ]);
    await applyOps("G20990203", [{ type: "insertPlateAppearance", inning: 1, half: "top", result: "K", batter_id: "P10" }]);
    const d = tip();
    const p10 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P10")!;
    expect(p10).toBeDefined(); // 未参加マスタの自動参加
    const top = d.plate_appearances.filter((p) => p.half === "top").sort((a, b) => a.order - b.order);
    // [§10.6 item11] 後続スロット機械回転は撤去。挿入PAは先頭スロットを提案、既存打席のスロットは観測値のまま据え置き。
    expect(top.map((p) => [p.order, p.result, p.batting_slot])).toEqual([
      [1, "K", 1], // 挿入PA: 直前なし→先頭スロット
      [2, "H1", 1], // 旧#1: 据え置き(機械回転しない)
      [3, "OUT", 2], // 旧#2: 据え置き
    ]);
    expect(top[0].batter_id).toBe(p10.id);
    // 自軍のbatter_id(実在の参加者)はスロットシフトで書き換えない
    const m1 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P1")!;
    const m2 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P2")!;
    expect([top[1].batter_id, top[2].batter_id]).toEqual([m1.id, m2.id]);
  });

  it("スロット既定は直前打席+1(一巡)。batter_id未指定なら有効スナップショットのスロット占有者", async () => {
    await mkGame("G20990204"); // 3人打ち(P1,P2,P3)
    await applyOps("G20990204", [
      { type: "addPlateAppearance", result: "OUT" }, // slot1
      { type: "addPlateAppearance", result: "OUT" }, // slot2
      { type: "addPlateAppearance", result: "OUT" }, // slot3
    ]);
    const lastId = tip().plate_appearances.at(-1)!.id!;
    await applyOps("G20990204", [{ type: "insertPlateAppearance", inning: 1, half: "top", after_pa_id: lastId, result: "H1" }]);
    const d = tip();
    const ins = d.plate_appearances.find((p) => p.order === 4)!;
    expect(ins.batting_slot).toBe(1); // 3の次は一巡して1
    const m1 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P1")!;
    expect(ins.batter_id).toBe(m1.id); // スロット1の占有者
  });

  it("shift_slots:false は後続スロット据え置き(打順に入らない特殊挿入用)", async () => {
    await mkGame("G20990205");
    await applyOps("G20990205", [
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
      { type: "addPlateAppearance", half: "bottom", result: "K" },
    ]);
    await applyOps("G20990205", [
      { type: "insertPlateAppearance", inning: 1, half: "bottom", result: "AUTO_OUT", shift_slots: false, opponent_slot: 9 },
    ]);
    const opp = tip().plate_appearances.filter((p) => p.half === "bottom").sort((a, b) => a.order - b.order);
    expect(opp.map((p) => [p.result, p.opponent_slot])).toEqual([
      ["AUTO_OUT", 9], // 挿入PA: 入力指定を優先
      ["OUT", 1], // 据え置き
      ["K", 2],
    ]);
  });

  it("挿入位置が見つからない/半イニング違いはエラー", async () => {
    await mkGame("G20990206");
    await applyOps("G20990206", [{ type: "addPlateAppearance", result: "H1" }]);
    const id1 = tip().plate_appearances[0].id!;
    await expect(
      applyOps("G20990206", [{ type: "insertPlateAppearance", inning: 1, half: "top", after_pa_id: "b999", result: "K" }])
    ).rejects.toThrow(/見つかりません/);
    await expect(
      applyOps("G20990206", [{ type: "insertPlateAppearance", inning: 2, half: "top", after_pa_id: id1, result: "K" }])
    ).rejects.toThrow(/半イニングにありません/);
  });

  it("スイープ: 挿入で上流が変わると後続打席のruns(幽霊得点)も再導出される", async () => {
    await mkGame("G20990207");
    await applyOps("G20990207", [
      { type: "addPlateAppearance", result: "H1" }, // P1が一塁
      { type: "addPlateAppearance", result: "H2", baserunning_after: [{ from: "1", to: "home" }] }, // P1生還=1点
    ]);
    expect(tip().plate_appearances[1].runs).toHaveLength(1);
    // 先頭に「P1は実は盗塁死していた」…ではなく、間に走者を消す打席を挿入するのは編集の話。
    // ここでは挿入自体が後続の盤面を正しく通すこと=挿入後もrunsが保たれることを確認する。
    const firstId = tip().plate_appearances[0].id!;
    await applyOps("G20990207", [{ type: "insertPlateAppearance", inning: 1, half: "top", after_pa_id: firstId, result: "K" }]);
    const top = tip().plate_appearances.filter((p) => p.half === "top").sort((a, b) => a.order - b.order);
    expect(top.map((p) => p.result)).toEqual(["H1", "K", "H2"]);
    expect(top[2].runs).toHaveLength(1); // P1(一塁)の生還は挿入後も成立(保存runsを非破壊で保持)
    expect(derivePAStates(tip()).get(top[2])!.outs).toBe(1); // 挿入されたKのアウトが導出で波及(§10.6: outsは導出で読む)
  });
});

describe("C-2 substitutePlayer / leaveGame: 交代スナップショットの追記", () => {
  it("未参加マスタは自動参加(played)し、outの打順スロット/守備位置を引き継ぐ(reason:substitution)", async () => {
    await mkGame("G20990211");
    await applyOps("G20990211", [
      { type: "substitutePlayer", out: "P2", in: { player_id: "P10" }, timing: { inning: 5, half: "bottom" } },
    ]);
    const d = tip();
    const p10 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P10")!;
    expect(p10).toBeDefined(); // 交代出場=participants 在籍(=出席)
    const snap = d.lineup_snapshots.at(-1)!;
    expect(snap.seq).toBe(1);
    expect(snap.reason).toBe("substitution");
    expect(snap.effective_from).toEqual({ inning: 5, half: "bottom", before_order: null }); // 打席なし→半イニング頭
    const slot2 = snap.lineup.find((l) => l.order === 2)!;
    expect(slot2.player_id).toBe(p10.id);
    expect(slot2.position_id).toBe("2"); // outの守備位置を引き継ぐ
    // outの参加者はそのまま(出欠は事実)
    expect(d.participants!.some((p) => p.link.kind === "roster" && p.link.player_id === "P2")).toBe(true);
  });

  it("position指定で守備位置も変更。before_order未指定は既存打席数+1(現行既定)", async () => {
    await mkGame("G20990212");
    await applyOps("G20990212", [
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
      { type: "addPlateAppearance", half: "bottom", result: "K" },
      { type: "substitutePlayer", out: "P1", in: { player_id: "P10" }, position: "1", timing: { inning: 1, half: "bottom" } },
    ]);
    const snap = tip().lineup_snapshots.at(-1)!;
    expect(snap.effective_from.before_order).toBe(3); // 既存2打席→次の打者から
    const p10 = tip().participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P10")!;
    expect(snap.lineup.find((l) => l.player_id === p10.id)!.position_id).toBe("1"); // リリーフ登板
  });

  it("[§12 P1] guest_name の助っ人交代は種別guestマスタ(player_id)へ解決し roster参加者になる(guest link生成なし)", async () => {
    await mkGame("G20990213");
    await applyOps("G20990213", [
      { type: "substitutePlayer", out: "P3", in: { guest_name: "山田" }, timing: { inning: 3, half: "top" } },
    ]);
    const d = tip();
    // ゲート: guest link は生成されない＝全て player_id 参照の roster
    expect(d.participants!.every((p) => p.link.kind === "roster")).toBe(true);
    const gp = guestMock.made.find((g) => g.name === "山田")!;
    expect(gp.type).toBe("guest");
    const inPart = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === gp.id)!;
    expect(inPart).toBeDefined(); // 助っ人の交代出場=participants 在籍(player_id 参照)
    expect(d.lineup_snapshots.at(-1)!.lineup.find((l) => l.order === 3)!.player_id).toBe(inPart.id);
  });

  it("outがラインアップに居ない/inが既にラインアップ/同一選手はエラー(黙って無反映にしない)", async () => {
    await mkGame("G20990214");
    await expect(
      applyOps("G20990214", [{ type: "substitutePlayer", out: "P5", in: { player_id: "P10" }, timing: { inning: 1, half: "bottom" } }])
    ).rejects.toThrow(/ラインアップに居ません/);
    await expect(
      applyOps("G20990214", [{ type: "substitutePlayer", out: "P1", in: { player_id: "P2" }, timing: { inning: 1, half: "bottom" } }])
    ).rejects.toThrow(/既にラインアップ/);
    await expect(
      applyOps("G20990214", [{ type: "substitutePlayer", out: "P1", in: { player_id: "P1" }, timing: { inning: 1, half: "bottom" } }])
    ).rejects.toThrow(/同じ選手/);
  });

  it("leaveGame: ラインアップから外すだけ=スロットは欠員になり次打者導出がスキップする", async () => {
    await mkGame("G20990215");
    await applyOps("G20990215", [
      { type: "addPlateAppearance", result: "OUT" }, // slot1 P1
      { type: "leaveGame", out: "P2", timing: { inning: 1, half: "top" }, reason: "injury" },
    ]);
    const d = tip();
    const snap = d.lineup_snapshots.at(-1)!;
    expect(snap.reason).toBe("injury");
    expect(snap.lineup.map((l) => l.order)).toEqual([1, 3]); // 2番が欠員
    const n = deriveNextPA(d, 1, "top");
    const m3 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P3")!;
    expect([n.batting_slot, n.batter_id]).toEqual([3, m3.id]); // 欠員スキップ
    await expect(
      applyOps("G20990215", [{ type: "leaveGame", out: "P10", timing: { inning: 1, half: "top" } }])
    ).rejects.toThrow(/ラインアップに居ません/);
  });
});

describe("C-3 changeBattingOrder: 打順変更スナップショット(reason:order_change)", () => {
  const rows6 = [
    { order: 1, position: "6", player_id: "P1" },
    { order: 2, position: "2", player_id: "P2" },
    { order: 3, position: "7", player_id: "P3" },
    { order: 4, position: "4", player_id: "P4" },
    { order: 5, position: "5", player_id: "P5" },
    { order: 6, position: "3", player_id: "P6" },
  ];

  it("5番6番交換をrows2件で表現し、次打者導出が追従する(editor-baseのop版)", async () => {
    await mkGame("G20990221", rows6);
    await applyOps("G20990221", [
      { type: "addPlateAppearance", result: "OUT" },
      { type: "addPlateAppearance", result: "OUT" },
      { type: "addPlateAppearance", result: "OUT" },
      { type: "addPlateAppearance", result: "OUT" }, // 4番まで消化
      { type: "changeBattingOrder", rows: [{ player: "P5", order: 6 }, { player: "P6", order: 5 }], timing: { inning: 1, half: "top", before_order: 5 } },
    ]);
    const d = tip();
    const snap = d.lineup_snapshots.at(-1)!;
    expect(snap.reason).toBe("order_change");
    expect(snap.effective_from).toEqual({ inning: 1, half: "top", before_order: 5 });
    const m6 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P6")!;
    const n = deriveNextPA(d, 1, "top");
    expect([n.batting_slot, n.batter_id]).toEqual([5, m6.id]); // 交換後: 5番=P6
  });

  it("同一orderの重複が生じたらエラー(片側だけの入れ替えを黙って通さない)", async () => {
    await mkGame("G20990222", rows6);
    await expect(
      applyOps("G20990222", [{ type: "changeBattingOrder", rows: [{ player: "P5", order: 6 }], timing: { inning: 1, half: "top" } }])
    ).rejects.toThrow(/重複/);
  });

  it("[2026-08-18 参加ベース化] ラインアップ外の対象は参加者解決してその場で枠へ加える(位置null。changeDefenseの新経路と同流儀)", async () => {
    await mkGame("G20990223", rows6);
    await applyOps("G20990223", [{ type: "changeBattingOrder", rows: [{ player: "P10", order: 7 }], timing: { inning: 3, half: "top" } }]);
    const d = tip();
    const m10 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P10")!;
    expect(m10).toBeDefined(); // 枠に入る=参加の事実(participants 自動追加)
    const snap = d.lineup_snapshots.at(-1)!;
    expect(snap.lineup.find((l) => l.player_id === m10.id)).toMatchObject({ order: 7, position_id: null, automatic_out: false });
    expect(snap.roster.some((r) => r.player_id === m10.id)).toBe(true);
    expect(snap.lineup).toHaveLength(7); // 既存6枠は消えない
  });

  it("[従来どおり] masters に無いIDの changeBattingOrder はエラー(誰か分からないものは黙って作らない)", async () => {
    await mkGame("G20990224", rows6);
    await expect(
      applyOps("G20990224", [{ type: "changeBattingOrder", rows: [{ player: "P404", order: 7 }], timing: { inning: 1, half: "top" } }])
    ).rejects.toThrow(/マスタ未登録/);
  });

  it("[2026-08-18 遡及の無音欠落] 遡及の枠追加(ラインアップ外)は既存の後続スナップショットにもカスケードする", async () => {
    await mkGame("G20990225", rows6);
    // 5回表の打順変更(後続スナップショット)を先に作る
    await applyOps("G20990225", [{ type: "changeBattingOrder", rows: [{ player: "P5", order: 6 }, { player: "P6", order: 5 }], timing: { inning: 5, half: "top" } }]);
    // 3回表へ遡及: ラインアップ外の P10 を7番の枠へ
    await applyOps("G20990225", [{ type: "changeBattingOrder", rows: [{ player: "P10", order: 7 }], timing: { inning: 3, half: "top" } }]);
    const d = tip();
    const m10 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P10")!;
    const luAt = (inning: number) => effectiveSnapshot(d.lineup_snapshots, inning, "top", 1)!;
    expect(luAt(3).lineup.find((l) => l.player_id === m10.id)).toMatchObject({ order: 7, position_id: null });
    expect(luAt(5).lineup.find((l) => l.player_id === m10.id)).toMatchObject({ order: 7 }); // 後続時点から黙って消えない
    expect(luAt(5).roster.some((r) => r.player_id === m10.id)).toBe(true);
    expect(luAt(2).lineup.some((l) => l.player_id === m10.id)).toBe(false); // 遡及点より前には現れない
    // 5回の既存変更(5-6交換)は保持される
    const orderAt = (inning: number, master: string) => luAt(inning).lineup.find(
      (l) => l.player_id === d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === master)!.id)!.order;
    expect([orderAt(5, "P5"), orderAt(5, "P6")]).toEqual([6, 5]);
  });
});

describe("C-4 changeDefense: 打席粒度のタイミング引数(before_order)", () => {
  it("before_order明示(数値/null)は effective_from にそのまま入る=遡及修正", async () => {
    await mkGame("G20990231");
    await applyOps("G20990231", [
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
      { type: "addPlateAppearance", half: "bottom", result: "K" },
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
    ]);
    // 「実は2人目の前から交代していた」を遡って記録
    await applyOps("G20990231", [
      { type: "changeDefense", inning: 1, half: "bottom", before_order: 2, changes: [{ player_id: "P1", to_position: "1" }] },
    ]);
    expect(tip().lineup_snapshots.at(-1)!.effective_from).toEqual({ inning: 1, half: "bottom", before_order: 2 });
    // null明示=半イニング頭から。[F-1] 遡及挿入は有効位置順にreseqされ .at(-1) ではなくなるので、
    // reasonと位置で当該スナップショットを特定して null が保存されたことを確認する。
    await applyOps("G20990231", [
      { type: "changeDefense", inning: 1, half: "bottom", before_order: null, changes: [{ player_id: "P2", to_position: "6" }] },
    ]);
    expect(tip().lineup_snapshots.some((s) => s.reason === "defensive_change" && s.effective_from.before_order === null)).toBe(true);
  });

  it("before_order未指定は現行どおり既存打席数+1", async () => {
    await mkGame("G20990232");
    await applyOps("G20990232", [
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
      { type: "addPlateAppearance", half: "bottom", result: "K" },
      { type: "changeDefense", inning: 1, half: "bottom", changes: [{ player_id: "P1", to_position: "1" }] },
    ]);
    expect(tip().lineup_snapshots.at(-1)!.effective_from.before_order).toBe(3);
  });
});

describe("[§12 P1] changeDefense の助っ人名解決(参加ベース化で初登場経路になった)", () => {
  it("guest_name は種別guestマスタ(player_id)へ解決され roster参加者としてラインアップへ加わる(guest link生成なし)", async () => {
    await mkGame("G20990233");
    await applyOps("G20990233", [
      { type: "changeDefense", inning: 3, half: "bottom", changes: [{ guest_name: "山田", to_position: "9" }] },
    ]);
    const d = tip();
    expect(d.participants!.every((p) => p.link.kind === "roster")).toBe(true); // ゲート: guest link は生成されない
    const gp = guestMock.made.find((g) => g.name === "山田")!;
    expect(gp.type).toBe("guest");
    const part = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === gp.id)!;
    expect(part).toBeDefined(); // 守備につく=参加の事実
    expect(d.lineup_snapshots.at(-1)!.lineup.find((l) => l.player_id === part.id)).toMatchObject({ order: null, position_id: "9", automatic_out: false });
  });

  it("[§12 P1追補] 同一集計内で作成した助っ人の名前参照(changes[].player_id)は player_id へ解決される", async () => {
    // スタメンで助っ人「山本」を新規作成→同じ applyOps 内の changeDefense が名前で参照(AIの辞書にはまだ無いケース)
    await applyOps("G20990234", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P1" },
        { order: 2, position: "2", player_id: "P2" },
        { order: 3, position: "7", guest_name: "山本" },
      ] },
      { type: "changeDefense", inning: 2, half: "bottom", changes: [{ player_id: "山本", to_position: "9" }] },
    ]);
    const d = tip();
    const gp = guestMock.made.find((g) => g.name === "山本")!;
    const part = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === gp.id)!;
    // 名前が解決されず生の「山本」のままなら reducer が「マスタ未登録」で throw していた=成功が解決の証拠。位置も追従。
    expect(d.lineup_snapshots.at(-1)!.lineup.find((l) => l.player_id === part.id)).toMatchObject({ order: 3, position_id: "9" });
  });

  it("[§12 P1追補] changeBattingOrder rows[].player も同一集計内の助っ人名を解決する", async () => {
    await applyOps("G20990235", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P1" },
        { order: 2, position: "2", player_id: "P2" },
        { order: 3, position: "7", guest_name: "山本" },
      ] },
      { type: "changeBattingOrder", rows: [{ player: "山本", order: null }], timing: { inning: 2, half: "top" } },
    ]);
    const d = tip();
    const gp = guestMock.made.find((g) => g.name === "山本")!;
    const part = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === gp.id)!;
    // 枠から外れた(order:null)=名前が player_id へ解決されて対象に当たった証拠
    expect(d.lineup_snapshots.at(-1)!.lineup.find((l) => l.player_id === part.id)).toMatchObject({ order: null, position_id: "7" });
  });
});

describe("C-5 setPitchingRecords: doc.pitching の全置換(記録値)", () => {
  const seedWithParts = (id: string) =>
    seed(id, {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m9", link: { kind: "roster", player_id: "PP" } },
      ],
      plate_appearances: [pa({ id: "b1", inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" })],
    });

  it("マスタID参照は参加者へ解決して保存。再設定は全置換", async () => {
    seedWithParts("G20990241");
    await applyOps("G20990241", [{ type: "setPitchingRecords", records: [{ player: "PP", earned_runs: 2, decision: "W" }] }]);
    expect(tip().pitching).toEqual([{ pitcher_id: "m9", earned_runs: 2, decision: "W" }]);
    gamesCol.set("G20990241", tip());
    await applyOps("G20990241", [{ type: "setPitchingRecords", records: [{ player: "m1", earned_runs: 0 }] }]);
    expect(tip().pitching).toEqual([{ pitcher_id: "m1", earned_runs: 0 }]); // 全置換=旧行は残らない
  });

  it("参加者に居ない選手(未参加マスタ含む)はエラー=自動参加しない(登板してないのに記録はおかしい)", async () => {
    seedWithParts("G20990242");
    await expect(
      applyOps("G20990242", [{ type: "setPitchingRecords", records: [{ player: "P3", earned_runs: 1 }] }])
    ).rejects.toThrow(/参加者に居ません/);
  });

  it("[minor①] 判定=W & 自責null(不明)は保存でき勝ち投手が保持される(無警告消失しない)", async () => {
    seedWithParts("G20990245");
    await applyOps("G20990245", [{ type: "setPitchingRecords", records: [{ player: "PP", earned_runs: null, decision: "W" }] }]);
    expect(tip().pitching).toEqual([{ pitcher_id: "m9", earned_runs: null, decision: "W" }]); // W保持・er=不明(null)
  });

  it("[minor①] 自責も勝敗Sも無い空record(earned_runs:null & decision無し)は拒否", async () => {
    seedWithParts("G20990246");
    await expect(
      applyOps("G20990246", [{ type: "setPitchingRecords", records: [{ player: "PP", earned_runs: null }] }])
    ).rejects.toThrow(/自責点も勝敗Sも無い/);
  });

  it("[minor①] 不正型の earned_runs(数値でもnullでもない/負数)は従来どおり拒否", async () => {
    seedWithParts("G20990247");
    await expect(
      applyOps("G20990247", [{ type: "setPitchingRecords", records: [{ player: "PP", earned_runs: -1, decision: "W" }] }])
    ).rejects.toThrow(/自責点は0以上/);
  });

  it("AI全置換(replace)は doc.pitching もクリアする(旧IDの誤解決の時限爆弾を除去)", async () => {
    const base = seedWithParts("G20990243");
    gamesCol.set("G20990243", { ...base, pitching: [{ pitcher_id: "m9", earned_runs: 3 }] });
    await applyOps("G20990243", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [{ order: 1, position: "6", player_id: "P1" }] },
      { type: "addPlateAppearance", result: "H1" },
    ], { draft: true, replace: true });
    expect(tip().pitching).toBeUndefined();
  });

  it("[§0/§11 major①] AI全置換(replace)で direct_stats が別人へ化けず同一人物の新IDへ再グラフトされる", async () => {
    // 旧: m1=P1, m2=P2。direct_stat は m2(P2)の「2安打1打点」。
    seed("G20990244", {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m2", link: { kind: "roster", player_id: "P2" } },
      ],
      plate_appearances: [],
      direct_stats: [{ participant_id: "m2", batting: { h: 2, rbi: 1 }, origin: "manual" }],
    });
    // 再集計(replace)で participants を再採番＝並びを反転(P2先頭→新m1 / P1→新m2)。
    // 素朴に旧participant_id"m2"を残すと新m2(=P1)へ誤帰属(捏造)する。
    await applyOps("G20990244", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P2" },
        { order: 2, position: "4", player_id: "P1" },
      ] },
    ], { draft: true, replace: true });
    const d = tip();
    expect(d.direct_stats).toHaveLength(1);
    const ds = d.direct_stats![0];
    // direct_stat は「別人」ではなく P2 に付いたまま
    const dsPart = d.participants!.find((p) => p.id === ds.participant_id)!;
    expect(dsPart.link).toEqual({ kind: "roster", player_id: "P2" });
    expect(ds.batting).toEqual({ h: 2, rbi: 1 });
    // 反転の証拠: 新m2 は P1(=もし旧IDを残していたら誤って合算されていた相手)
    expect(d.participants!.find((p) => p.id === "m2")!.link).toEqual({ kind: "roster", player_id: "P1" });
  });

  it("[§0/§11 major①] replaceで新docから消えた direct-stat 選手は participant 再追加＋記録保全(明示記録を失わない)", async () => {
    seed("G20990245", {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m2", link: { kind: "roster", player_id: "P2" } },
      ],
      plate_appearances: [],
      direct_stats: [{ participant_id: "m2", batting: { h: 3 }, origin: "manual" }],
    });
    // 新ノートは P1 だけ再構成(P2 は登場しない)＝ノートから消えた人物
    await applyOps("G20990245", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [{ order: 1, position: "6", player_id: "P1" }] },
    ], { draft: true, replace: true });
    const d = tip();
    const p2 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P2")!;
    expect(p2).toBeDefined(); // 消えた人物を participant として再追加(出欠=第一級の保全)
    expect(d.direct_stats).toHaveLength(1);
    expect(d.direct_stats![0].participant_id).toBe(p2.id); // 再追加したP2の新IDへ保全
    expect(d.direct_stats![0].batting).toEqual({ h: 3 });
  });

  it("R7: 投手記録の投手が参加者に居なければタグ(弾かない)", () => {
    const d = doc({ home_away: "away" });
    delete d.attendance;
    delete d.additional_players;
    d.lineup_snapshots = [];
    d.participants = [{ id: "m1", link: { kind: "roster", player_id: "P1" } }];
    d.plate_appearances = [pa({ inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" })];
    d.pitching = [{ pitcher_id: "mX", earned_runs: 0 }];
    const flags = validateGame(d);
    expect(flags.some((f) => f.rule === "R7" && f.detail.includes("mX"))).toBe(true);
  });

  it("R8: 投手別の自責点が帰属失点を超えるとタグ。以下なら出ない", () => {
    const mk = (er: number) => {
      const d = doc({ home_away: "away" });
      delete d.attendance;
      delete d.additional_players;
      d.lineup_snapshots = [];
      d.participants = [{ id: "m9", link: { kind: "roster", player_id: "PP" } }];
      d.plate_appearances = [
        pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", opponent_slot: 1, result: "HR",
          runs: [{ runner_id: "o1", rbi: true, earned: true, cause: "hr", responsible_pitcher_id: "m9" }] }),
      ];
      d.pitching = [{ pitcher_id: "m9", earned_runs: er }];
      return d;
    };
    expect(validateGame(mk(2)).some((f) => f.rule === "R8")).toBe(true); // 帰属1に対して自責2
    expect(validateGame(mk(1)).some((f) => f.rule === "R8")).toBe(false);
  });
});

describe("C-6 受理フィールド拡張(Add/Edit)とrun_overrides", () => {
  it("振り逃げ(dropped_third_strike): 保存され、アウトに数えない導出が波及する", async () => {
    await mkGame("G20990251");
    await applyOps("G20990251", [
      { type: "addPlateAppearance", result: "K", dropped_third_strike: true, baserunning_after: [{ from: null, to: "1", runner_id: "batter" }] },
      { type: "addPlateAppearance", result: "OUT" },
    ]);
    const d = tip();
    const pas = d.plate_appearances;
    expect(pas[0].dropped_third_strike).toBe(true);
    expect(derivePAStates(d).get(pas[1])!.outs).toBe(0); // 振り逃げ成立=アウト無し→次打者は0アウト開始(§10.6: outsは導出で読む)
  });

  it("申告敬遠(intentional)と自動アウト(automatic_out)が保存される", async () => {
    await mkGame("G20990252");
    await applyOps("G20990252", [
      { type: "addPlateAppearance", result: "BB", intentional: true },
      { type: "addPlateAppearance", result: "AUTO_OUT", automatic_out: true },
    ]);
    const pas = tip().plate_appearances;
    expect(pas[0].intentional).toBe(true);
    expect(pas[1].automatic_out).toBe(true);
    // 編集でも受理される(付け外し)
    await applyOps("G20990252", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, intentional: false }]);
    expect(tip().plate_appearances[0].intentional).toBe(false);
  });

  it("代走(pinch_runner): 未参加マスタは自動参加し、参加者IDで保存される", async () => {
    await mkGame("G20990253");
    await applyOps("G20990253", [
      { type: "addPlateAppearance", result: "H1" }, // P1が一塁
      { type: "addPlateAppearance", result: "OUT", pinch_runner: { type: "pinch_runner", runner_id: "P10", for_base: "1" } },
    ]);
    const d = tip();
    const p10 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P10")!;
    expect(p10).toBeDefined(); // 代走=participants 在籍(=出席)
    expect(d.plate_appearances[1].pinch_runner!.runner_id).toBe(p10.id);
  });

  it("スロット修正: 自軍batting_slotは編集で直せる。相手opponent_slotはbatter_id(oN)も追従", async () => {
    await mkGame("G20990254");
    await applyOps("G20990254", [
      { type: "addPlateAppearance", result: "H1" }, // 自軍 slot1
      { type: "addPlateAppearance", half: "bottom", result: "OUT" }, // 相手 slot1
    ]);
    await applyOps("G20990254", [
      { type: "editPlateAppearance", inning: 1, half: "top", order: 1, batting_slot: 3 },
      { type: "editPlateAppearance", inning: 1, half: "bottom", order: 1, opponent_slot: 5 },
    ]);
    const d = tip();
    expect(d.plate_appearances[0].batting_slot).toBe(3);
    const opp = d.plate_appearances.find((p) => p.half === "bottom")!;
    expect([opp.opponent_slot, opp.batter_id]).toEqual([5, "o5"]); // プレースホルダ追従
    // 次打者導出も修正へ追従(スロット=記録値が基準)
    const n = deriveNextPA(d, 1, "bottom");
    expect([n.opponent_slot, n.batter_id]).toEqual([6, "o6"]);
    // addでもスロット指定を優先できる
    await applyOps("G20990254", [{ type: "addPlateAppearance", half: "bottom", result: "K", opponent_slot: 8 }]);
    const last = tip().plate_appearances.at(-1)!;
    expect([last.opponent_slot, last.batter_id]).toEqual([8, "o8"]);
  });

  it("run_overrides: 責任投手の手動上書きは doc.run_overrides に保持され、read時に帰属する(自責は常に導出)", async () => {
    seed("G20990255", {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m9", link: { kind: "roster", player_id: "PP" } },
      ],
      plate_appearances: [
        pa({ id: "b1", inning: 1, half: "bottom", order: 1, batter_id: "o1", opponent_slot: 1, result: "H1" }),
        pa({
          id: "b2", inning: 1, half: "bottom", order: 2, batter_id: "o2", opponent_slot: 2, result: "H2",
          runs: [{ runner_id: "o1", rbi: true, earned: true, cause: "hit" }],
          baserunning_after: [{ runner_id: "o1", from: "1", to: "home" }],
        }),
      ],
    });
    // [§10.6] 責任投手を PP(マスタ参照→m9へ解決)に手動上書き→ doc.run_overrides(manual)へ。runs[]へ畳まない。
    await applyOps("G20990255", [{
      type: "editPlateAppearance", pa_id: "b2", inning: 1, half: "bottom", order: 2,
      run_overrides: [{ runner_id: "o1", responsible_pitcher_id: "PP" }],
    }]);
    let d = tip();
    let b2 = d.plate_appearances.find((p) => p.id === "b2")!;
    expect(d.run_overrides?.some((o) => o.pa_id === "b2" && o.runner_id === "o1" && o.responsible_pitcher_id === "m9" && o.origin === "manual")).toBe(true);
    expect(deriveResponsiblePitchers(d).get(b2)?.get("o1")).toBe("m9"); // read時導出で帰属(マスタ参照→参加者ID)
    expect(b2.runs.find((r) => r.runner_id === "o1")!.earned).toBe(true); // 導出(近似)＝正本は投手記録
    // 別の編集(実況だけ)を挟んでも手動値は doc.run_overrides に保持される
    await applyOps("G20990255", [{ type: "editPlateAppearance", pa_id: "b2", inning: 1, half: "bottom", order: 2, note: "タイムリー" }]);
    d = tip();
    b2 = d.plate_appearances.find((p) => p.id === "b2")!;
    expect(deriveResponsiblePitchers(d).get(b2)?.get("o1")).toBe("m9");
    // 導出runsに居ない走者へのoverrideは幽霊得点を作らない(runsは変わらない)
    await applyOps("G20990255", [{
      type: "editPlateAppearance", pa_id: "b2", inning: 1, half: "bottom", order: 2,
      run_overrides: [{ runner_id: "oX", responsible_pitcher_id: "m9" }],
    }]);
    expect(tip().plate_appearances.find((p) => p.id === "b2")!.runs.map((r) => r.runner_id)).toEqual(["o1"]);
  });

  it("run_overrides: add(新規打席)でも責任投手の手動上書きが受理される(doc.run_overrides)", async () => {
    await mkGame("G20990256");
    await applyOps("G20990256", [
      { type: "addPlateAppearance", half: "bottom", result: "HR", run_overrides: [{ runner_id: "o1", responsible_pitcher_id: "P1" }] },
    ]);
    const d = tip();
    const p0 = d.plate_appearances[0];
    expect(p0.runs[0].runner_id).toBe("o1"); // 相手1番のソロHR
    const m1 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P1")!.id;
    expect(d.run_overrides?.some((o) => o.pa_id === p0.id && o.runner_id === "o1" && o.responsible_pitcher_id === m1)).toBe(true);
    expect(deriveResponsiblePitchers(d).get(p0)?.get("o1")).toBe(m1); // read時導出(マスタ参照→参加者ID)
  });
});

describe("F-1 遡及タイミングの交代がスナップショット履歴を汚染しない", () => {
  const idOf = (d: GameDoc, pid: string) => d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === pid)!.id;

  it("substitute: 5回裏P1登板の後に3回裏の交代を遡及入力しても、5回以降はP1投手のまま", async () => {
    // 投手PP先発。5回裏からP1が登板(既存の交代)。
    await mkGame("G20990261", [
      { order: 1, position: "1", player_id: "PP" }, // 投手
      { order: 2, position: "2", player_id: "P2" }, // 捕手
      { order: 3, position: "6", player_id: "P3" },
    ]);
    await applyOps("G20990261", [
      { type: "substitutePlayer", out: "PP", in: { player_id: "P1" }, position: "1", timing: { inning: 5, half: "bottom" } },
    ]);
    // 3回裏から P2→P10(捕手)を遡及入力(記録漏れの後入れ)。
    await applyOps("G20990261", [
      { type: "substitutePlayer", out: "P2", in: { player_id: "P10" }, position: "2", timing: { inning: 3, half: "bottom" } },
    ]);
    const d = tip();
    const at = (inning: number, pos: string) => posMap(effectiveSnapshot(d.lineup_snapshots, inning, "bottom", 1)).get(pos);
    // 投手(pos1): 1-4回はPP(P1登板は5回から)。5回以降はP1のまま=遡及入力に汚染されない(旧実装はここでP1が3回に漏れた)。
    expect(at(1, "1")).toBe(idOf(d, "PP"));
    expect(at(4, "1")).toBe(idOf(d, "PP"));
    expect(at(5, "1")).toBe(idOf(d, "P1"));
    expect(at(6, "1")).toBe(idOf(d, "P1"));
    // 捕手(pos2): 3回以降はP10(遡及交代が後続スナップショットにもカスケード)。
    expect(at(2, "2")).toBe(idOf(d, "P2"));
    expect(at(3, "2")).toBe(idOf(d, "P10"));
    expect(at(5, "2")).toBe(idOf(d, "P10"));
    // seqは有効位置順に振り直されている(start=0, 3回=1, 5回=2)。
    expect(d.lineup_snapshots.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(d.lineup_snapshots.map((s) => s.effective_from.inning)).toEqual([1, 3, 5]);
  });

  it("changeDefense: 遡及の守備変更が後の守備変更を汚染しない", async () => {
    await mkGame("G20990262", [
      { order: 1, position: "1", player_id: "PP" },
      { order: 2, position: "2", player_id: "P2" },
      { order: 3, position: "6", player_id: "P3" },
    ]);
    await applyOps("G20990262", [{ type: "changeDefense", inning: 5, half: "bottom", changes: [{ player_id: "P2", to_position: "5" }] }]);
    await applyOps("G20990262", [{ type: "changeDefense", inning: 3, half: "bottom", changes: [{ player_id: "P3", to_position: "4" }] }]);
    const d = tip();
    const at = (inning: number, pos: string) => posMap(effectiveSnapshot(d.lineup_snapshots, inning, "bottom", 1)).get(pos);
    expect(at(5, "5")).toBe(idOf(d, "P2")); // 5回の変更が残る
    expect(at(5, "4")).toBe(idOf(d, "P3")); // 3回の変更が5回へカスケード
    expect(at(4, "4")).toBe(idOf(d, "P3"));
    expect(at(4, "2")).toBe(idOf(d, "P2")); // 4回はまだP2が捕手(5回で三塁へ)
    expect(at(2, "2")).toBe(idOf(d, "P2"));
    expect(at(2, "6")).toBe(idOf(d, "P3"));
  });

  it("[2026-08-18 遡及の無音欠落] changeDefense: ラインアップ外選手の遡及追加が既存の後続スナップショットにもカスケードする", async () => {
    await mkGame("G20990265", [
      { order: 1, position: "1", player_id: "PP" },
      { order: 2, position: "2", player_id: "P2" },
      { order: 3, position: "6", player_id: "P3" },
    ]);
    // 5回の守備変更(後続スナップショット)を先に作っておく
    await applyOps("G20990265", [{ type: "changeDefense", inning: 5, half: "bottom", changes: [{ player_id: "P2", to_position: "5" }] }]);
    // 3回へ遡及: ラインアップ外の P10 を右翼へ(order:null 追加の新経路)
    await applyOps("G20990265", [{ type: "changeDefense", inning: 3, half: "bottom", changes: [{ player_id: "P10", to_position: "9" }] }]);
    const d = tip();
    const at = (inning: number, pos: string) => posMap(effectiveSnapshot(d.lineup_snapshots, inning, "bottom", 1)).get(pos);
    expect(at(2, "9")).toBeUndefined(); // 遡及点より前には現れない
    expect(at(3, "9")).toBe(idOf(d, "P10"));
    expect(at(4, "9")).toBe(idOf(d, "P10"));
    // 旧実装は挿入スナップショットにしか載らず、5回(後続)時点から P10 が黙って消えた=守備帰属が途切れた。
    expect(at(5, "9")).toBe(idOf(d, "P10"));
    expect(at(5, "5")).toBe(idOf(d, "P2")); // 5回の既存変更は保持
    const snap5 = effectiveSnapshot(d.lineup_snapshots, 5, "bottom", 1)!;
    expect(snap5.roster.some((r) => r.player_id === idOf(d, "P10"))).toBe(true); // roster にも伝播
    expect(snap5.lineup.find((l) => l.player_id === idOf(d, "P10"))).toMatchObject({ order: null, position_id: "9" });
  });

  it("[2026-08-18] 追加の伝播は後続に既に居る選手を触らない(後で別位置につけた明示変更を壊さない)", async () => {
    await mkGame("G20990266", [
      { order: 1, position: "1", player_id: "PP" },
      { order: 2, position: "2", player_id: "P2" },
      { order: 3, position: "6", player_id: "P3" },
    ]);
    // 5回: P10(ラインアップ外)を三塁で初登場させる(後続スナップショット)
    await applyOps("G20990266", [{ type: "changeDefense", inning: 5, half: "bottom", changes: [{ player_id: "P10", to_position: "5" }] }]);
    // 3回へ遡及: 実は P10 は3回から右翼だった
    await applyOps("G20990266", [{ type: "changeDefense", inning: 3, half: "bottom", changes: [{ player_id: "P10", to_position: "9" }] }]);
    const d = tip();
    const at = (inning: number, pos: string) => posMap(effectiveSnapshot(d.lineup_snapshots, inning, "bottom", 1)).get(pos);
    expect(at(3, "9")).toBe(idOf(d, "P10")); // 3-4回は右翼
    expect(at(4, "9")).toBe(idOf(d, "P10"));
    expect(at(5, "5")).toBe(idOf(d, "P10")); // 5回の明示変更(三塁)はそのまま=追加の伝播が上書きしない
    expect(at(5, "9")).toBeUndefined();
  });

  it("leaveGame: 遡及の退場が後の交代を汚染しない", async () => {
    await mkGame("G20990263", [
      { order: 1, position: "1", player_id: "PP" },
      { order: 2, position: "2", player_id: "P2" },
      { order: 3, position: "6", player_id: "P3" },
    ]);
    await applyOps("G20990263", [{ type: "substitutePlayer", out: "P2", in: { player_id: "P10" }, timing: { inning: 5, half: "bottom" } }]);
    await applyOps("G20990263", [{ type: "leaveGame", out: "P3", timing: { inning: 3, half: "bottom" } }]);
    const d = tip();
    const lu = (inning: number) => effectiveSnapshot(d.lineup_snapshots, inning, "bottom", 1)!.lineup.map((l) => l.player_id);
    expect(lu(2)).toContain(idOf(d, "P3"));
    expect(lu(4)).not.toContain(idOf(d, "P3")); // 3回退場
    expect(lu(5)).not.toContain(idOf(d, "P3")); // 退場は5回にもカスケード
    expect(lu(5)).toContain(idOf(d, "P10")); // 5回の交代は残る
  });

  it("changeBattingOrder: 遡及の打順変更が後の打順変更を汚染しない", async () => {
    const rows6 = [
      { order: 1, position: "6", player_id: "P1" }, { order: 2, position: "2", player_id: "P2" },
      { order: 3, position: "7", player_id: "P3" }, { order: 4, position: "4", player_id: "P4" },
      { order: 5, position: "5", player_id: "P5" }, { order: 6, position: "3", player_id: "P6" },
    ];
    await mkGame("G20990264", rows6);
    await applyOps("G20990264", [{ type: "changeBattingOrder", rows: [{ player: "P5", order: 6 }, { player: "P6", order: 5 }], timing: { inning: 5, half: "top" } }]);
    await applyOps("G20990264", [{ type: "changeBattingOrder", rows: [{ player: "P1", order: 2 }, { player: "P2", order: 1 }], timing: { inning: 3, half: "top" } }]);
    const d = tip();
    const orderAt = (inning: number, pid: string) => effectiveSnapshot(d.lineup_snapshots, inning, "top", 1)!.lineup.find((l) => l.player_id === idOf(d, pid))!.order;
    // 5回: 1-2交換(3回から)と5-6交換(5回から)の両方が効く。
    expect([orderAt(5, "P1"), orderAt(5, "P2")]).toEqual([2, 1]);
    expect([orderAt(5, "P5"), orderAt(5, "P6")]).toEqual([6, 5]);
    // 4回: 1-2交換のみ(5-6はまだ)。
    expect(orderAt(4, "P1")).toBe(2);
    expect(orderAt(4, "P5")).toBe(5);
    // 2回: 変更前。
    expect(orderAt(2, "P1")).toBe(1);
  });
});

describe("F-D1 編集の round-trip 保全(op層側=編集で未編集フィールドを失わない)", () => {
  it("代走の replaced_id/note を持つ打席を result だけ編集しても保持される", async () => {
    // 代走に UI が出さないフィールド(replaced_id/note)を持つ打席をシード。
    seed("G20990291", {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m2", link: { kind: "roster", player_id: "P2" } },
      ],
      plate_appearances: [
        pa({
          id: "b1", inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1",
          pinch_runner: { type: "pinch", runner_id: "m2", for_base: "1", replaced_id: "m1", note: "代走メモ" },
        }),
      ],
    });
    // result だけ変更(pinch_runner は input に含めない)→ 代走の全フィールドが不変
    await applyOps("G20990291", [{ type: "editPlateAppearance", pa_id: "b1", inning: 1, half: "top", order: 1, result: "H2" }]);
    const pr = tip().plate_appearances[0].pinch_runner!;
    expect(pr.replaced_id).toBe("m1");
    expect(pr.note).toBe("代走メモ");
    expect(pr.runner_id).toBe("m2");
    // pinch_runner を再送(UIのスプレッド保全を模擬)しても replaced_id/note が残る
    await applyOps("G20990291", [{
      type: "editPlateAppearance", pa_id: "b1", inning: 1, half: "top", order: 1,
      pinch_runner: { type: "pinch", runner_id: "m2", for_base: "1", replaced_id: "m1", note: "代走メモ" },
    }]);
    const pr2 = tip().plate_appearances[0].pinch_runner!;
    expect([pr2.replaced_id, pr2.note]).toEqual(["m1", "代走メモ"]);
  });

  it("during 守備 out の putout_position/assist_positions が編集・スイープを跨いで保持される", async () => {
    // during-fielding の out 型は narrow(putout_position 非モデル)だが実データには乗りうる。型を広げて runtime 保全を検証。
    const outWithExtra = { at: "2", type: "tag", runner_id: "m1", putout_position: "6", assist_positions: ["2"] } as unknown as { at: string; type: string; runner_id?: string | null };
    seed("G20990292", {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m2", link: { kind: "roster", player_id: "P2" } },
      ],
      plate_appearances: [
        pa({ id: "b1", inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" }),
        pa({
          id: "b2", inning: 1, half: "top", order: 2, batter_id: "m2", result: "OUT",
          baserunning_during: [{
            event: "CS", runners: [{ runner_id: "m1", from: "1", to: "out" }],
            fielding: { sequence: ["2", "6"], outs: [outWithExtra] },
          }],
        }),
      ],
    });
    // during を再送(UIのスプレッド保全を模擬)→ putout_position/assist_positions が残る
    await applyOps("G20990292", [{
      type: "editPlateAppearance", pa_id: "b2", inning: 1, half: "top", order: 2,
      baserunning_during: [{
        event: "CS", runners: [{ runner_id: "m1", from: "1", to: "out" }],
        fielding: { sequence: ["2", "6"], outs: [outWithExtra] },
      }],
    }]);
    const out = tip().plate_appearances[1].baserunning_during![0].fielding!.outs![0] as { putout_position?: string; assist_positions?: string[] };
    expect(out.putout_position).toBe("6");
    expect(out.assist_positions).toEqual(["2"]);
  });

  it("fielding の非モデル項目(infield_hit)が編集で失われない", async () => {
    seed("G20990293", {
      participants: [{ id: "m1", link: { kind: "roster", player_id: "P1" } }],
      plate_appearances: [
        pa({ id: "b1", inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1",
          fielding: { hit_to: "6", hit_type: "G", infield_hit: true, sequence: [], outs: [], errors: [] } }),
      ],
    });
    // UI の buildFielding が元 f をスプレッドして再送する挙動(可視項目クリア＋infield_hit保持)を模擬
    await applyOps("G20990293", [{
      type: "editPlateAppearance", pa_id: "b1", inning: 1, half: "top", order: 1,
      fielding: { hit_to: null, hit_type: null, infield_hit: true, sequence: [], outs: [], errors: [] },
    }]);
    expect(tip().plate_appearances[0].fielding!.infield_hit).toBe(true);
  });
});

describe("F-D2 double_play/triple_play を op から露出", () => {
  it("editPlateAppearance で double_play:true → pa.double_play=true かつアウト下限2", async () => {
    await mkGame("G20990294");
    await applyOps("G20990294", [{ type: "addPlateAppearance", result: "OUT" }]); // 通常の凡退=1アウト
    await applyOps("G20990294", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, double_play: true }]);
    const p = tip().plate_appearances[0];
    expect(p.double_play).toBe(true);
    expect(outsMade(p)).toBe(2); // 併殺=最低2アウト(agg のアウト下限)
  });

  it("addPlateAppearance でも triple_play:true が保存され、アウト下限3", async () => {
    await mkGame("G20990295");
    await applyOps("G20990295", [{ type: "addPlateAppearance", result: "OUT", triple_play: true }]);
    const p = tip().plate_appearances[0];
    expect(p.triple_play).toBe(true);
    expect(outsMade(p)).toBe(3);
  });
});

describe("F-3 removePlateAppearance の shift_slots(insertと対称)", () => {
  it("insert(shift)→remove(shift)の往復で相手スロットとoNが恒等に戻る", async () => {
    await mkGame("G20990271");
    await applyOps("G20990271", [
      { type: "addPlateAppearance", half: "bottom", result: "OUT" }, // o1
      { type: "addPlateAppearance", half: "bottom", result: "K" }, // o2
      { type: "addPlateAppearance", half: "bottom", result: "OUT" }, // o3
    ]);
    const firstId = tip().plate_appearances.filter((p) => p.half === "bottom").sort((a, b) => a.order - b.order)[0].id!;
    // 1人目の直後にH1を挿入(後続スロット+1シフト)
    await applyOps("G20990271", [{ type: "insertPlateAppearance", inning: 1, half: "bottom", after_pa_id: firstId, result: "H1" }]);
    const insertedId = tip().plate_appearances.filter((p) => p.half === "bottom").sort((a, b) => a.order - b.order)[1].id!;
    // 挿入したPAを削除(既定shift=trueで後続スロット-1) → 元に戻る
    await applyOps("G20990271", [{ type: "removePlateAppearance", pa_id: insertedId, inning: 1, half: "bottom", order: 2 }]);
    const opp = tip().plate_appearances.filter((p) => p.half === "bottom").sort((a, b) => a.order - b.order);
    expect(opp.map((p) => [p.order, p.result, p.opponent_slot, p.batter_id])).toEqual([
      [1, "OUT", 1, "o1"],
      [2, "K", 2, "o2"],
      [3, "OUT", 3, "o3"],
    ]);
  });

  it("shift_slots:false は後続スロット据え置き(挿入で入れた特殊打席の削除)", async () => {
    await mkGame("G20990272");
    await applyOps("G20990272", [
      { type: "addPlateAppearance", half: "bottom", result: "OUT" }, // o1
      { type: "addPlateAppearance", half: "bottom", result: "K" }, // o2
      { type: "addPlateAppearance", half: "bottom", result: "OUT" }, // o3
    ]);
    const firstId = tip().plate_appearances.filter((p) => p.half === "bottom").sort((a, b) => a.order - b.order)[0].id!;
    await applyOps("G20990272", [{ type: "removePlateAppearance", pa_id: firstId, inning: 1, half: "bottom", order: 1, shift_slots: false }]);
    const opp = tip().plate_appearances.filter((p) => p.half === "bottom").sort((a, b) => a.order - b.order);
    // orderは詰まるが opponent_slot は据え置き(元の2,3のまま)。
    expect(opp.map((p) => [p.order, p.opponent_slot])).toEqual([[1, 2], [2, 3]]);
  });
});

describe("E-3 継投を跨いだ失点の責任投手を自動導出", () => {
  const idOf = (d: GameDoc, pid: string) => d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === pid)!.id;
  // away=自軍先攻→守備=bottom。投手A=PP先発、2人目の前でB=P1へ継投。
  const pitcherChangeGame = async (id: string) => {
    await mkGame(id, [
      { order: 1, position: "1", player_id: "PP" }, // 投手A
      { order: 2, position: "2", player_id: "P2" },
      { order: 3, position: "6", player_id: "P3" },
    ]);
    await applyOps(id, [
      { type: "addPlateAppearance", half: "bottom", result: "H1" }, // o1がA(PP)から出塁
      { type: "substitutePlayer", out: "PP", in: { player_id: "P1" }, position: "1", timing: { inning: 1, half: "bottom", before_order: 2 } },
      { type: "addPlateAppearance", half: "bottom", result: "HR" }, // o2の2ラン: o1(A由来)とo2(B由来)が生還
    ]);
  };

  it("前投手Aが出した走者の生還はA(出塁時)へ帰属し、後投手Bへ誤帰属しない(read時導出)", async () => {
    await pitcherChangeGame("G20990281");
    const d = tip();
    const hr = d.plate_appearances.find((p) => p.result === "HR")!;
    // [§10.6] 責任投手は sweep で runs へ焼かず read 時に導出(reach規則=出塁時投手)。
    const resp = deriveResponsiblePitchers(d).get(hr)!;
    expect(resp.get("o1")).toBe(idOf(d, "PP")); // 出塁時の投手A
    expect(resp.get("o1")).not.toBe(idOf(d, "P1")); // 後投手Bではない
    expect(resp.get("o2")).toBe(idOf(d, "P1")); // 当該打席で出塁+生還=投手B
  });

  it("手動 run_override が read時の自動導出より優先され、以後の編集でも保持される", async () => {
    await pitcherChangeGame("G20990282");
    let d = tip();
    let hr = d.plate_appearances.find((p) => p.result === "HR")!;
    expect(deriveResponsiblePitchers(d).get(hr)?.get("o1")).toBe(idOf(d, "PP")); // 自動=A
    // o1の責任投手をP3へ手動上書き(doc.run_overrides)
    await applyOps("G20990282", [{
      type: "editPlateAppearance", pa_id: hr.id!, inning: 1, half: "bottom", order: 2,
      run_overrides: [{ runner_id: "o1", responsible_pitcher_id: "P3" }],
    }]);
    d = tip();
    hr = d.plate_appearances.find((p) => p.result === "HR")!;
    expect(deriveResponsiblePitchers(d).get(hr)?.get("o1")).toBe(idOf(d, "P3")); // 手動が勝つ
    // 別の編集(実況だけ)を挟んでも手動値は doc.run_overrides に保持され、自動で潰れない
    await applyOps("G20990282", [{ type: "editPlateAppearance", pa_id: hr.id!, inning: 1, half: "bottom", order: 2, note: "2ラン" }]);
    d = tip();
    hr = d.plate_appearances.find((p) => p.result === "HR")!;
    expect(deriveResponsiblePitchers(d).get(hr)?.get("o1")).toBe(idOf(d, "P3"));
  });
});

describe("§10.6 非破壊: 明示outsの保持 と 下流の別打席の保持", () => {
  const mkG = async (id: string) => {
    await applyOps(id, [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P1" },
        { order: 2, position: "2", player_id: "P2" },
      ] },
    ]);
  };

  it("(b) §0の特別ルール: 明示 outs(4アウト回等)は導出値と食い違ってもsweepを通して保持される", async () => {
    await mkG("G20990301");
    // 相手攻撃(bottom)。導出のアウト累積は2だが、5人目に開始時アウト=4を人が主張(特別ルール)。
    await applyOps("G20990301", [
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
      { type: "addPlateAppearance", half: "bottom", result: "H1", outs: 4 },
    ]);
    const third = tip().plate_appearances.filter((p) => p.half === "bottom").sort((a, b) => a.order - b.order)[2];
    expect(third.outs).toBe(4); // 主張値が保存(導出値2で上書きしない)
    expect(derivePAStates(tip()).get(third)!.outs).toBe(4); // 表示も主張値を優先
    // 別打席の追加や当該打席の編集(sweep発火)を挟んでも主張outsは潰れない
    await applyOps("G20990301", [{ type: "editPlateAppearance", pa_id: third.id!, inning: 1, half: "bottom", order: 3, note: "特別ルール" }]);
    expect(tip().plate_appearances.find((p) => p.id === third.id)!.outs).toBe(4);
  });

  it("(c) 編集は当該打席のみruns再導出・下流の別打席の保存runsは保持し、盤面食い違いはR1でflag", async () => {
    await mkG("G20990302");
    await applyOps("G20990302", [
      { type: "addPlateAppearance", result: "H1" }, // #1 P1一塁
      { type: "addPlateAppearance", result: "H1", baserunning_after: [{ from: "1", to: "home" }] }, // #2 P1生還=1点(保存runs)
      { type: "addPlateAppearance", result: "OUT" }, // #3 下流の別打席
    ]);
    expect(tip().plate_appearances[1].runs).toHaveLength(1);
    // 上流#1を三振に編集 → #2の走者は盤面から消える(#2は編集対象でない=下流)
    await applyOps("G20990302", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, result: "K" }]);
    const d = tip();
    expect(d.plate_appearances[0].result).toBe("K"); // 編集打席は再導出済み
    expect(d.plate_appearances[1].runs).toHaveLength(1); // 下流の別打席の保存runsは非破壊で保持(0にしない)
    expect(validateGame(d).some((f) => f.rule === "R1" && f.half === "top" && f.order === 2)).toBe(true); // 食い違いはflag
  });
});

// ─── Phase 4a/4b: 個人成績(断片) op ＋ 得点(走者不明)の非破壊保全 ───
describe("§0/§11 Phase4a setDirectStats op", () => {
  const mkG = async (id: string) => {
    await applyOps(id, [
      { type: "setGameMeta", date: "2026-07-02", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P1" },
        { order: 2, position: "2", player_id: "P2" },
      ] },
    ]);
  };

  it("全置換される・origin未指定でもmanualに強制・未参加participantはthrow(V-D)", async () => {
    await mkG("G20990401");
    // origin を渡さなくても manual に強制されること(型の隙間を突いて未指定で送る)
    await applyOps("G20990401", [{ type: "setDirectStats", stats: [
      { participant_id: "P1", batting: { h: 2, rbi: 1 } } as unknown as DirectStatLine,
    ] }]);
    let d = tip();
    expect(d.direct_stats).toHaveLength(1);
    const p1 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P1")!.id;
    expect(d.direct_stats![0]).toMatchObject({ participant_id: p1, batting: { h: 2, rbi: 1 }, origin: "manual" });
    // 全置換: 次の設定で前の行は消える(追記でなく置換)
    await applyOps("G20990401", [{ type: "setDirectStats", stats: [
      { participant_id: "P2", pitching: { outs: 3 }, origin: "manual" },
    ] }]);
    d = tip();
    expect(d.direct_stats).toHaveLength(1);
    const p2 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P2")!.id;
    expect(d.direct_stats![0].participant_id).toBe(p2);
    // 未参加participant(存在しないID)はthrow
    await expect(applyOps("G20990401", [{ type: "setDirectStats", stats: [
      { participant_id: "zzz", batting: { h: 1 }, origin: "manual" },
    ] }])).rejects.toThrow(/参加者に居ません/);
    // マスタID参照でも自動参加しない=未参加なら拒否(P10はlineup外)
    await expect(applyOps("G20990401", [{ type: "setDirectStats", stats: [
      { participant_id: "P10", batting: { h: 1 }, origin: "manual" },
    ] }])).rejects.toThrow(/参加者に居ません/);
  });

  it("空欄=None=0埋めしない: 全空の line と空 sub-object は保存しない", async () => {
    await mkG("G20990403");
    await applyOps("G20990403", [{ type: "setDirectStats", stats: [
      { participant_id: "P1", batting: {}, pitching: {}, fielding: {}, origin: "manual" },
      { participant_id: "P2", batting: { h: 1 }, origin: "manual" },
    ] }]);
    const d = tip();
    expect(d.direct_stats).toHaveLength(1); // 全空のP1行は落ちる
    expect(d.direct_stats![0].batting).toEqual({ h: 1 });
  });
});

describe("§0/§11 Phase4b 得点(走者不明)=manual_runs の非破壊保全", () => {
  const mkG = async (id: string) => {
    await applyOps(id, [
      { type: "setGameMeta", date: "2026-07-02", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "1", player_id: "PP" },
        { order: 2, position: "2", player_id: "P2" },
        { order: 3, position: "6", player_id: "P1" },
      ] },
    ]);
  };

  it("editでnull-manual run付与→無関係フィールド(note)編集でも保持・agg投手Rへ帰属・選手別R不動", async () => {
    await mkG("G20990402");
    // 相手攻撃(bottom=自軍守備)の打席に「得点(走者不明)」を1件付ける
    await applyOps("G20990402", [{ type: "addPlateAppearance", half: "bottom", result: "H1" }]);
    const paId = tip().plate_appearances.find((p) => p.half === "bottom")!.id!;
    await applyOps("G20990402", [{
      type: "editPlateAppearance", pa_id: paId, inning: 1, half: "bottom", order: 1,
      manual_runs: [{ runner_id: null, rbi: true }],
    }]);
    let d = tip();
    let pa0 = d.plate_appearances.find((p) => p.id === paId)!;
    const nullRun = pa0.runs.find((r) => r.runner_id === null);
    expect(nullRun).toBeDefined();
    expect(nullRun!.origin).toBe("manual");
    // 無関係フィールド(note)だけ編集→ sweepが走っても null-manual run は残る(非破壊)
    await applyOps("G20990402", [{ type: "editPlateAppearance", pa_id: paId, inning: 1, half: "bottom", order: 1, note: "得点あり(誰か不明)" }]);
    d = tip();
    pa0 = d.plate_appearances.find((p) => p.id === paId)!;
    expect(pa0.runs.filter((r) => r.runner_id === null && r.origin === "manual")).toHaveLength(1);
    // agg: 失点/自責は当該facing投手(PP)へ+1、選手別Rは誰にも付かない・幽霊guest行なし(§0-C防御a)
    const box = aggregateGameP(d);
    expect(box.pitching.find((p) => p.player_id === "PP")?.r).toBe(1);
    expect(box.batting.some((b) => b.player_id.includes("null"))).toBe(false);
    expect(box.batting.reduce((s, b) => s + b.r, 0)).toBe(0);
  });

  it("空 manual_runs を送ると走者不明runは消える(全置換)・auto runは影響しない", async () => {
    await mkG("G20990404");
    await applyOps("G20990404", [{ type: "addPlateAppearance", half: "bottom", result: "H1" }]);
    const paId = tip().plate_appearances.find((p) => p.half === "bottom")!.id!;
    await applyOps("G20990404", [{ type: "editPlateAppearance", pa_id: paId, inning: 1, half: "bottom", order: 1, manual_runs: [{ runner_id: null, rbi: false }] }]);
    expect(tip().plate_appearances.find((p) => p.id === paId)!.runs.some((r) => r.runner_id === null)).toBe(true);
    await applyOps("G20990404", [{ type: "editPlateAppearance", pa_id: paId, inning: 1, half: "bottom", order: 1, manual_runs: [] }]);
    expect(tip().plate_appearances.find((p) => p.id === paId)!.runs.some((r) => r.runner_id === null)).toBe(false);
  });

  it("[minor] insertでも manual_runs(得点(走者不明))を origin:manual で畳む(reduceAddPAと対称)", async () => {
    await mkG("G20990405");
    // 相手攻撃(bottom)に1打席置き、その直後へ「得点(走者不明)」付きの打席を挿入する
    await applyOps("G20990405", [{ type: "addPlateAppearance", half: "bottom", result: "OUT" }]);
    const anchorId = tip().plate_appearances.find((p) => p.half === "bottom")!.id!;
    await applyOps("G20990405", [{
      type: "insertPlateAppearance", inning: 1, half: "bottom", after_pa_id: anchorId,
      result: "H1", manual_runs: [{ runner_id: null, rbi: false }],
    }]);
    const inserted = tip().plate_appearances.find((p) => p.half === "bottom" && p.order === 2)!;
    const manual = inserted.runs.filter((r) => r.runner_id === null && r.origin === "manual");
    expect(manual).toHaveLength(1); // 挿入経由でも走者不明得点が保全される
  });

  it("[クラスタA A4] manual run の earned は null(自責不明)＝deriveの true/false と混同しない", async () => {
    await mkG("G20990410");
    await applyOps("G20990410", [{ type: "addPlateAppearance", half: "bottom", result: "H1" }]);
    const paId = tip().plate_appearances.find((p) => p.half === "bottom")!.id!;
    await applyOps("G20990410", [{ type: "editPlateAppearance", pa_id: paId, inning: 1, half: "bottom", order: 1, manual_runs: [{ runner_id: null, rbi: true }] }]);
    const run = tip().plate_appearances.find((p) => p.id === paId)!.runs.find((r) => r.origin === "manual")!;
    expect(run.earned).toBe(null); // true固定でなく不明(null)
    // 集計: PP は失点1・自責は不明(null)＝0/防御率0.00 に潰さない(分岐4)
    const box = aggregateGameP(tip());
    const pp = box.pitching.find((p) => p.player_id === "PP");
    expect(pp?.r).toBe(1);
    expect(pp?.er).toBe(null);
  });
});

describe("新規試合IDの採番(不透明16進ランダム)", () => {
  it("generateGameId: 10桁hex・URLセーフ(緩和後の検証を通る)・毎回異なる", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const id = generateGameId();
      expect(id).toMatch(/^[0-9a-f]{10}$/); // 5バイト=10桁の16進
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/); // 緩和後の upsertGameMeta/reduceSetGameMeta 検証を通る
      ids.add(id);
    }
    expect(ids.size).toBe(300); // 300回すべて一意(衝突なし)
  });

  it("newGameId: 既存IDに衝突したら再生成し、空いたIDを返す", async () => {
    seed("dead00beef"); // 既存試合として games に置く
    const queued = ["dead00beef", "dead00beef", "cafe12b34d"]; // 2回衝突→3回目で空き
    const id = await newGameId(() => queued.shift()!);
    expect(id).toBe("cafe12b34d");
  });

  it("newGameId: 衝突し続ければ採番失敗で throw する(黙って壊さない)", async () => {
    seed("aaaaaaaaaa");
    await expect(newGameId(() => "aaaaaaaaaa")).rejects.toThrow(/採番に失敗/);
  });
});

describe("試合IDの検証緩和(不透明キー=URLセーフのみ強制)", () => {
  it("upsertGameMeta: 新hexID/旧日付IDは通し、空IDは弾く", async () => {
    await expect(upsertGameMeta({ id: "3f8a2c9e1b", date: "2026-07-01", opponent: "X", home_away: "away", result: null })).resolves.toBeUndefined();
    await expect(upsertGameMeta({ id: "G20260614", date: "2026-07-01", opponent: "X", home_away: "away", result: null })).resolves.toBeUndefined();
    await expect(upsertGameMeta({ id: "", date: "2026-07-01", opponent: "X", home_away: "away", result: null })).rejects.toThrow(/試合IDが不正/);
  });

  it("applyOps(setGameMeta): 新hexIDを通し、不正IDは弾く", async () => {
    await expect(applyOps("3f8a2c9e1b", [{ type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" }])).resolves.toBeDefined();
    await expect(applyOps("bad id!", [{ type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" }])).rejects.toThrow(/試合IDが不正/);
  });
});
