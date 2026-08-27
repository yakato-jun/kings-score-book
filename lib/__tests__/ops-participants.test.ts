/**
 * §9 参加者ID層の書き込み側(4b/4d)テスト。
 * reducer群が接頭辞を見ずに参加者で解決すること・V-B・参加者操作(抜く/差し替え/再リンク)を固定する。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GameDoc, GameVersion, Participant } from "../types/v2";
import { doc, pa } from "./fixtures";

vi.mock("../db/mongo", () => ({ getDb: vi.fn() }));
vi.mock("../db/players", () => ({
  loadPlayers: vi.fn(async () => new Map([
    ["P1", "一山"], ["P2", "二川"], ["P3", "三田"], ["P10", "十条"], ["PP", "投森"],
  ])),
  // [タスクC 助っ人ライフサイクル] discardGame が種別guestの現マスタを引く。guestMock.made=現在の guest マスタ
  //   (createGuestPlayer スタブが作成・deletePlayer が削除を反映)＝作成/削除のライフサイクルを1箇所で観測する。
  loadPlayerMap: vi.fn(async () => new Map(guestMock.made.map((g) => [g.id, { ...g }] as const))),
  deletePlayer: vi.fn(async (id: string) => { guestMock.made = guestMock.made.filter((g) => g.id !== id); }),
}));
// [§12 P1] applyOps は助っ人名を createGuestPlayer(ops/players)で種別guestのマスタ選手(player_id)へ解決する。
//   ここでは best-effort の mint-only スタブ(採番順に P901..)＝作られた助っ人マスタを made に記録して検証に使う。
const { guestMock } = vi.hoisted(() => ({ guestMock: { made: [] as { id: string; name: string; type: string }[], seq: 0 } }));
vi.mock("../ops/players", () => ({
  createGuestPlayer: vi.fn(async (name: string) => {
    const p = { id: `P${900 + ++guestMock.seq}`, name: String(name).trim(), type: "guest" };
    guestMock.made.push(p);
    return p;
  }),
}));
import { getDb } from "../db/mongo";
import { deletePlayer } from "../db/players";
import {
  applyOps, setAttendance, swapParticipant,
  addParticipant, removeParticipant, deleteGame,
  upsertGameMeta, publishGame, discardGame,
} from "../ops/games";
import { validateGame } from "../ops/validate";
import { deriveResponsiblePitchers } from "../ops/gamestate";

let history: GameVersion[];
let gamesCol: Map<string, GameDoc>;

beforeEach(() => {
  history = [];
  gamesCol = new Map();
  guestMock.made = [];
  guestMock.seq = 0;
  vi.mocked(deletePlayer).mockClear();
  (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    collection: (name: string) => {
      if (name === "game_history") {
        return {
          findOne: async (q: Record<string, unknown>, opts?: { sort?: { gen: number } }) => {
            const rows = history.filter((h) => h.game_id === q.game_id
              && (q.draft === undefined || h.draft === q.draft)
              && (q.gen === undefined || h.gen === q.gen)); // loadVersion(特定gen)にも対応
            if (opts?.sort?.gen === -1) rows.sort((a, b) => b.gen - a.gen);
            return rows[0] ?? null;
          },
          insertOne: async (v: GameVersion) => { history.push(v); return { insertedId: "x" }; },
          // discardDrafts(draft:true & gen>$gt) / deleteGameCompletely(game_id のみ) の両方に対応する
          deleteMany: async (q: { game_id: string; draft?: boolean; gen?: { $gt: number } }) => {
            const hit = (h: GameVersion) => h.game_id === q.game_id
              && (q.draft === undefined || h.draft === q.draft)
              && (q.gen === undefined || h.gen > q.gen.$gt);
            const n = history.filter(hit).length;
            history = history.filter((h) => !hit(h));
            return { deletedCount: n };
          },
          // draftGameIds(distinct game_id where draft:true) 用
          distinct: async (_field: string, q: { draft?: boolean }) =>
            [...new Set(history.filter((h) => q?.draft === undefined || h.draft === q.draft).map((h) => h.game_id))],
        };
      }
      if (name === "game_notes") {
        return { deleteOne: async () => ({ deletedCount: 0 }) };
      }
      return {
        find: () => ({ sort: () => ({ toArray: async () => [...gamesCol.values()] }) }), // loadGames 用
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

describe("setStartingLineup: 参加者を生成しlineupは参加者IDを持つ(接頭辞推論なし)", () => {
  it("[§12 P1] マスタID/助っ人名ともに player_id 参照の roster 参加者(guest linkは生成しない)。助っ人は種別guestのマスタへ解決", async () => {
    await applyOps("G20990101", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P1" },
        { order: 2, position: "2", player_id: "P2" },
        { order: 3, position: "7", guest_name: "山田" },
      ] },
    ]);
    const d = tip();
    const parts = d.participants!;
    expect(parts).toHaveLength(3);
    // ゲート: guest link(kind:"guest")は一切生成されない＝全て player_id 参照の roster
    expect(parts.every((p) => p.link.kind === "roster")).toBe(true);
    // 助っ人は createGuestPlayer で種別guestのマスタ選手へ解決され、その player_id を roster link が参照する
    const gp = guestMock.made.find((g) => g.name === "山田")!;
    expect(gp.type).toBe("guest");
    expect(parts[2].link).toEqual({ kind: "roster", player_id: gp.id });
    // lineup は参加者ID(不透明)を参照
    const lu = d.lineup_snapshots[0].lineup;
    expect(lu.map((l) => l.player_id)).toEqual(parts.map((p) => p.id));
    // 旧形式の生成物が無い
    expect(d.attendance).toBeUndefined();
    expect(d.additional_players).toBeUndefined();
    for (const r of d.lineup_snapshots[0].roster) {
      expect(r.stat_scope).toBeUndefined();
      expect(r.include_in_season).toBeUndefined();
    }
  });

  it("lineup外の既存参加者(控え)は温存する。lineup入りも参加者はそのまま(在籍=出席)", async () => {
    const parts: Participant[] = [
      { id: "m1", link: { kind: "roster", player_id: "P1" } },
      { id: "m2", link: { kind: "roster", player_id: "P3" } }, // lineup外に留まる
    ];
    seed("G20990102", { participants: parts, lineup_snapshots: [] });
    await applyOps("G20990102", [{ type: "setStartingLineup", rows: [{ order: 1, position: "6", player_id: "P1" }] }]);
    const d = tip();
    const byId = new Map(d.participants!.map((p) => [p.id, p]));
    expect(byId.has("m1")).toBe(true); // 先発入り
    expect(byId.has("m2")).toBe(true); // 控え温存(旧実装は消していた)
  });

  it("マスタ未登録の選手IDは弾く", async () => {
    seed("G20990103", { participants: [], lineup_snapshots: [] });
    await expect(
      applyOps("G20990103", [{ type: "setStartingLineup", rows: [{ order: 1, position: "6", player_id: "P99" }] }])
    ).rejects.toThrow(/マスタ未登録/);
  });
});

describe("addPlateAppearance: 参加者解決・投捕/保存走者を焼き込まない・相手はopponent_slot", () => {
  const LINEUP_ROWS = [
    { order: 1, position: "6", player_id: "P1" },
    { order: 2, position: "2", player_id: "P2" },
  ];

  it("自軍: マスタID参照の代打は参加者を自動追加(打席=出欠の事実)。PAに投捕/runnersが無い", async () => {
    await applyOps("G20990104", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: LINEUP_ROWS },
      { type: "addPlateAppearance", result: "H1" }, // 自動=1番(参加者)
      { type: "addPlateAppearance", batter_id: "P10", result: "HR" }, // 代打=マスタ参照→自動参加
    ]);
    const d = tip();
    const pas = d.plate_appearances;
    expect(pas).toHaveLength(2);
    const p10 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P10")!;
    expect(p10).toBeDefined(); // 代打=participants 在籍(=出席)
    expect(pas[1].batter_id).toBe(p10.id); // 保存は参加者ID
    for (const p of pas) {
      expect(p.pitcher_id).toBeUndefined();
      expect(p.catcher_id).toBeUndefined();
      expect(p.runners).toBeUndefined();
      expect(p.opponent_slot).toBeUndefined();
    }
  });

  it("相手: half明示で opponent_slot＋プレースホルダが自動採番される", async () => {
    await applyOps("G20990105", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: LINEUP_ROWS },
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
      { type: "addPlateAppearance", half: "bottom", result: "K" },
    ]);
    const opp = tip().plate_appearances.filter((p) => p.half === "bottom");
    expect(opp.map((p) => [p.batter_id, p.opponent_slot])).toEqual([["o1", 1], ["o2", 2]]);
  });
});

describe("参加者操作(§9.6/§12): 1エントリ編集で差し替え/削除/追加。V-Bで二重計上を構造的に防止", () => {
  const seedWithParts = (id: string) =>
    seed(id, {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m2", link: { kind: "roster", player_id: "P2" } },
      ],
      plate_appearances: [pa({ inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" })],
    });

  it("swap: 差し替え先が既に参加している選手なら V-B throw(コミットされない)", async () => {
    seedWithParts("G20990112");
    const before = history.length;
    await expect(swapParticipant("G20990112", "m2", "P1")).rejects.toThrow(/複数の参加者/);
    expect(history.length).toBe(before); // throw-before-commit
    await swapParticipant("G20990112", "m2", "P3"); // 未参加の選手へは成功
    const m2 = tip().participants!.find((p) => p.id === "m2")!;
    expect(m2.link).toEqual({ kind: "roster", player_id: "P3" });
  });

  it("remove: 打席から参照されている参加者は削除不可・未参照は削除できる", async () => {
    seedWithParts("G20990113");
    await expect(removeParticipant("G20990113", "m1")).rejects.toThrow(/参照されている/);
    await removeParticipant("G20990113", "m2");
    expect(tip().participants!.map((p) => p.id)).toEqual(["m1"]);
  });

  it("addParticipant: 出席のみの参加者を作れる。既参加のマスタは弾く", async () => {
    seedWithParts("G20990114");
    await addParticipant("G20990114", { player_id: "P3" });
    const p3 = tip().participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P3");
    expect(p3).toBeDefined(); // 在籍=出席
    gamesCol.set("G20990114", tip());
    await expect(addParticipant("G20990114", { player_id: "P1" })).rejects.toThrow(/既に参加/);
  });
});

describe("[§12 P1 ゲート] going-forward の各経路で guest link(kind:\"guest\")を生成しない", () => {
  // 必達2点を固定: (1) 新規に guest LINK を作らない (2) 助っ人は type:\"guest\" のマスタ選手＋link は player_id 参照。
  it("スタメン登録(setStartingLineup): 助っ人名は player_id 参照の roster になる", async () => {
    await applyOps("GATE01", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P1" },
        { order: 2, position: "7", guest_name: "助っ人一郎" },
      ] },
    ]);
    const parts = tip().participants!;
    expect(parts.every((p) => p.link.kind === "roster")).toBe(true);
    const gp = guestMock.made.find((g) => g.name === "助っ人一郎")!;
    expect(gp.type).toBe("guest");
    expect(parts.some((p) => p.link.kind === "roster" && p.link.player_id === gp.id)).toBe(true);
  });

  it("参加者追加(addParticipant): player_id 専用＝guest link を作らない", async () => {
    seed("GATE02", { participants: [{ id: "m1", link: { kind: "roster", player_id: "P1" } }], plate_appearances: [] });
    await addParticipant("GATE02", { player_id: "P3" });
    expect(tip().participants!.every((p) => p.link.kind === "roster")).toBe(true);
  });

  it("AI全置換(replace): 助っ人を含むスタメンでも guest link ゼロ・助っ人は種別guestマスタ参照", async () => {
    await applyOps("GATE03", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P1" },
        { order: 2, position: "7", guest_name: "助っ人花子" },
      ] },
      { type: "addPlateAppearance", result: "H1" },
    ], { draft: true, replace: true });
    const parts = tip().participants!;
    expect(parts.every((p) => p.link.kind === "roster")).toBe(true);
    const gp = guestMock.made.find((g) => g.name === "助っ人花子")!;
    expect(gp.type).toBe("guest");
    expect(parts.some((p) => p.link.kind === "roster" && p.link.player_id === gp.id)).toBe(true);
    // 既存 guest link の読みは維持＝型としては残る(P2/P5で撤去)。ここでは新規生成ゼロを固定するだけ。
    expect(validateGame(tip()).some((f) => f.rule === "R6")).toBe(false); // V-B(二重計上)なし
  });
});

describe("setAttendance: マスタ基準のリコンサイル(未提出=欠席は参照ガード付きで参加者から外す)", () => {
  it("提出=upsert・未提出未参照=削除・未提出参照あり=エラー", async () => {
    seed("G20990121", {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } }, // 打席参照あり
        { id: "m2", link: { kind: "roster", player_id: "P2" } }, // 参照なし
      ],
      plate_appearances: [pa({ inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" })],
    });
    // P1・P3を提出(出席)・P2は未提出(=欠席)
    await setAttendance("G20990121", [
      { player_id: "P1" },
      { player_id: "P3" },
    ]);
    const parts = tip().participants!;
    expect(parts.some((p) => p.id === "m1")).toBe(true); // 提出＝出席のまま在籍
    expect(parts.some((p) => p.link.kind === "roster" && p.link.player_id === "P3")).toBe(true);
    expect(parts.some((p) => p.link.kind === "roster" && p.link.player_id === "P2")).toBe(false); // 欠席=除去
    // 参照ありのm1(P1)を未提出にするとエラー
    gamesCol.set("G20990121", tip());
    await expect(setAttendance("G20990121", [{ player_id: "P3" }])).rejects.toThrow(/参照されている/);
  });
});

describe("[§0/§11 major②] direct_stats のみ持つ参加者も参照ありとして守る(沈黙孤児化防止)", () => {
  // m2 は打席・守備・投手記録に一切現れず direct_stats(個人成績・断片)だけを持つ。
  const seedDirectOnly = (id: string) =>
    seed(id, {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m2", link: { kind: "roster", player_id: "P2" } },
      ],
      plate_appearances: [], // PA参照は無い＝direct_stats を見なければ m2 は「未参照」に見えてしまう
      direct_stats: [{ participant_id: "m2", batting: { h: 2, rbi: 1 }, origin: "manual" }],
    });

  it("removeParticipant: direct_stat のみ持つ参加者は削除できない(明示記録の喪失防止)", async () => {
    seedDirectOnly("G20990131");
    await expect(removeParticipant("G20990131", "m2")).rejects.toThrow(/参照されている/);
  });

  it("setAttendance: direct_stat のみ持つ参加者は未提出=欠席で外せない", async () => {
    seedDirectOnly("G20990132");
    // P1 だけ提出(P2 は未提出=欠席にしようとする)→ direct_stat 参照ありで弾かれる
    await expect(setAttendance("G20990132", [{ player_id: "P1" }])).rejects.toThrow(/参照されている/);
  });
});

describe("editPlateAppearance: 打席の直接編集(バックログ#1・スコア入力タブのフォームが使う)", () => {
  it("結果変更＋マスタ参照への打者差し替え(自動参加)＋走者クリア。runs[]は再導出される", async () => {
    await applyOps("G20990141", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P1" },
        { order: 2, position: "2", player_id: "P2" },
      ] },
      { type: "addPlateAppearance", result: "H1" }, // 1番 P1 出塁
      { type: "addPlateAppearance", result: "HR" }, // 2番 P2: 2ラン(=P1生還+P2生還)
    ]);
    let d = tip();
    expect(d.plate_appearances[1].runs).toHaveLength(2); // HRで2得点が導出済み

    // 2打席目を HR→K に修正 → runs[] が空に再導出される
    await applyOps("G20990141", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 2, result: "K" }]);
    d = tip();
    expect(d.plate_appearances[1].result).toBe("K");
    expect(d.plate_appearances[1].runs).toHaveLength(0);

    // 1打席目の打者を未参加のマスタ選手 P10 に差し替え → 自動参加し保存は参加者ID
    await applyOps("G20990141", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, batter_id: "P10" }]);
    d = tip();
    const p10 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P10")!;
    expect(p10).toBeDefined();
    expect(d.plate_appearances[0].batter_id).toBe(p10.id);
  });

  it("走者の動きクリア(baserunning_after/during=[]) で余分な進塁を取り消せる", async () => {
    await applyOps("G20990142", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P1" },
        { order: 2, position: "2", player_id: "P2" },
      ] },
      { type: "addPlateAppearance", result: "H1" },
      { type: "addPlateAppearance", result: "H1", baserunning_after: [{ from: "1", to: "home" }] }, // 一塁走者が余計に生還した誤記
    ]);
    expect(tip().plate_appearances[1].runs).toHaveLength(1);
    await applyOps("G20990142", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 2, baserunning_after: [], baserunning_during: [] }]);
    expect(tip().plate_appearances[1].runs).toHaveLength(0); // 生還が消え再導出
  });
});

describe("Phase A: 現行実バグ4件の修正(§10.3)", () => {
  const LINEUP_ROWS = [
    { order: 1, position: "6", player_id: "P1" },
    { order: 2, position: "2", player_id: "P2" },
  ];
  const mkGame = async (id: string) => {
    await applyOps(id, [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: LINEUP_ROWS },
    ]);
  };

  it("①削除: 交代境界(before_order)が同半イニング内で再マップされる", async () => {
    await mkGame("G20990151");
    // 相手の攻撃(bottom)に3打席 → 3人目の打者の前から守備交代(before_order=3)
    await applyOps("G20990151", [
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
      { type: "addPlateAppearance", half: "bottom", result: "K" },
      { type: "changeDefense", inning: 1, half: "bottom", changes: [{ player_id: "P1", to_position: "1" }] }, // P1が登板
      { type: "addPlateAppearance", half: "bottom", result: "OUT" },
    ]);
    let snaps = tip().lineup_snapshots;
    expect(snaps.at(-1)!.effective_from.before_order).toBe(3);
    // 1人目の打席を削除 → 後続が繰り上がる → 境界も 3→2 に追従(旧実装は3のままズレていた)
    await applyOps("G20990151", [{ type: "removePlateAppearance", inning: 1, half: "bottom", order: 1 }]);
    snaps = tip().lineup_snapshots;
    expect(snaps.at(-1)!.effective_from.before_order).toBe(2);
    // 境界より前(==削除order以下)の削除でない場合は不変: 2人目(旧3人目)を削除しても境界2はそのまま
    await applyOps("G20990151", [{ type: "removePlateAppearance", inning: 1, half: "bottom", order: 2 }]);
    expect(tip().lineup_snapshots.at(-1)!.effective_from.before_order).toBe(2);
  });

  it("②編集: 不明瞭注記は暗黙に消えない(clear_unclear明示時のみ解決)", async () => {
    await mkGame("G20990152");
    await applyOps("G20990152", [
      { type: "addPlateAppearance", result: "H1", annotations: [{ type: "unclear", detail: "打球方向が不明", source: "ai" }] },
    ]);
    // 部分編集(実況だけ)→ AI由来の要確認は残る(旧実装は黙って全消し)
    await applyOps("G20990152", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, note: "レフト前" }]);
    let ann = tip().plate_appearances[0].annotations ?? [];
    expect(ann.some((a) => a.type === "unclear" && a.source === "ai")).toBe(true);
    // 明示 clear_unclear → 解決される(AIの再解釈経路はこのフラグを送る)
    await applyOps("G20990152", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, result: "H2", clear_unclear: true }]);
    ann = tip().plate_appearances[0].annotations ?? [];
    expect(ann.some((a) => a.type === "unclear" && a.source === "ai")).toBe(false);
  });

  it("③守備交代: ラインアップ外のマスタ選手は order:null でその場で加わる(ベンチという機構は無い=旧ゲート撤去)", async () => {
    // [2026-08-18] 旧仕様は「ラインアップに居ません」エラー(旧実バグ③のゲート)。無反映の罠は
    // 「黙って落とす」ではなく「その場で加える」で塞ぐ(participants への自動追加=参加の事実)。
    await mkGame("G20990153");
    await applyOps("G20990153", [{ type: "changeDefense", inning: 1, half: "bottom", changes: [{ player_id: "P3", to_position: "1" }] }]);
    const d = tip();
    const p3 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P3");
    expect(p3).toBeDefined(); // 参加者に自動追加
    const snap = d.lineup_snapshots.at(-1)!;
    expect(snap.lineup.find((l) => l.player_id === p3!.id)).toMatchObject({ order: null, position_id: "1", automatic_out: false });
    expect(snap.roster.some((r) => r.player_id === p3!.id)).toBe(true); // roster にも追加
    expect(snap.lineup).toHaveLength(LINEUP_ROWS.length + 1); // 既存の枠は消えない
  });

  it("④楽観ロック: 呼び出し側のbase_genが検証される(旧実装は常に握り潰し)", async () => {
    await mkGame("G20990154"); // tip=1
    // 古い画面(gen=0)からのopは弾かれる
    await expect(
      applyOps("G20990154", [{ type: "addPlateAppearance", result: "H1" }], { draft: true, base_gen: 0 })
    ).rejects.toThrow(/世代衝突/);
    // 正しいgenなら通り、未指定はロード時genへフォールバック(AI経路の既存挙動)
    await applyOps("G20990154", [{ type: "addPlateAppearance", result: "H1" }], { draft: true, base_gen: 1 });
    await applyOps("G20990154", [{ type: "addPlateAppearance", result: "K" }], { draft: true });
    expect(tip().plate_appearances).toHaveLength(2);
  });

  it("[クラスタB2] AI編集(clear_unclear)は source:manual の保持unclearを消さない(validator/ai由来のみ解決)", async () => {
    await mkGame("G20990155");
    // 人/移行が明示保持した要確認(source:manual)と AI由来(source:ai)を両方付ける
    await applyOps("G20990155", [
      { type: "addPlateAppearance", result: "H1", annotations: [
        { type: "unclear", detail: "移行時の要確認(人が保持)", source: "manual" },
        { type: "unclear", detail: "打球方向が不明", source: "ai" },
      ] },
    ]);
    // AI再解釈経路(clear_unclear:true)で編集
    await applyOps("G20990155", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, result: "H2", clear_unclear: true }]);
    const ann = tip().plate_appearances[0].annotations ?? [];
    expect(ann.some((a) => a.type === "unclear" && a.source === "manual")).toBe(true); // 温存
    expect(ann.some((a) => a.type === "unclear" && a.source === "ai")).toBe(false);    // 解決
  });

  it("[クラスタB2一貫] AI編集(annotations指定+clear_unclear)は manual unclear を温存し 新AI unclear も付く(両方残る)", async () => {
    await mkGame("G20990157");
    // 人/移行が明示保持した要確認(source:manual)＋旧AI由来(source:ai)を両方付ける
    await applyOps("G20990157", [
      { type: "addPlateAppearance", result: "H1", annotations: [
        { type: "unclear", detail: "移行時の要確認(人が保持)", source: "manual" },
        { type: "unclear", detail: "旧AIの不明(打球方向)", source: "ai" },
      ] },
    ]);
    // AI再解釈経路(toGameOp相当): clear_unclear:true と 新しい aiUnclear(annotations) を併発させる
    await applyOps("G20990157", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, result: "H2",
      clear_unclear: true, annotations: [{ type: "unclear", detail: "新AIの不明(安打かエラーか)", source: "ai" }] }]);
    const ann = tip().plate_appearances[0].annotations ?? [];
    expect(ann.some((a) => a.type === "unclear" && a.source === "manual" && a.detail.includes("移行時"))).toBe(true); // 人明示は温存
    expect(ann.some((a) => a.type === "unclear" && a.source === "ai" && a.detail.includes("新AI"))).toBe(true);       // 新AI注記は付く
  });

  it("[クラスタB2退行なし] AI編集(annotations指定)は ai由来の旧unclearを落とす(要確認が残り続けない・重複しない)", async () => {
    await mkGame("G20990158");
    await applyOps("G20990158", [
      { type: "addPlateAppearance", result: "H1", annotations: [{ type: "unclear", detail: "旧AIの不明", source: "ai" }] },
    ]);
    await applyOps("G20990158", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, result: "H2",
      clear_unclear: true, annotations: [{ type: "unclear", detail: "新AIの不明", source: "ai" }] }]);
    const ann = tip().plate_appearances[0].annotations ?? [];
    expect(ann.some((a) => a.source === "ai" && a.detail.includes("旧AI"))).toBe(false); // 旧ai由来は入替で落ちる(退行=残り続けない)
    expect(ann.filter((a) => a.type === "unclear" && a.source === "ai").length).toBe(1); // 残るのは新AI 1件のみ(二重付与なし)
  });

  it("[クラスタB2一貫] 手編集寄り(annotations未指定)＋clear_unclear は従来どおり: manual unclear と承認(resolved)は温存・ai は解決", async () => {
    await mkGame("G20990159");
    await applyOps("G20990159", [
      { type: "addPlateAppearance", result: "H1", annotations: [
        { type: "unclear", detail: "移行時の要確認(人が保持)", source: "manual" },
        { type: "resolved", detail: "特別ルールで承認", source: "manual", resolved_by: "admin" },
        { type: "unclear", detail: "AI由来の不明", source: "ai" },
      ] },
    ]);
    // annotations未指定・clear_unclear:true(AIがaiUnclearを出さない再解釈)
    await applyOps("G20990159", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, result: "H2", clear_unclear: true }]);
    const ann = tip().plate_appearances[0].annotations ?? [];
    expect(ann.some((a) => a.type === "unclear" && a.source === "manual")).toBe(true);  // 人明示の要確認は温存
    expect(ann.some((a) => a.type === "resolved" && a.source === "manual")).toBe(true); // 人の承認も温存
    expect(ann.some((a) => a.type === "unclear" && a.source === "ai")).toBe(false);     // 機械生成(ai)は解決
  });

  it("[クラスタB3] editPlateAppearance に result:null を渡すと結果不明のまま保存(OUTに化けない・INCと別)", async () => {
    await mkGame("G20990156");
    await applyOps("G20990156", [{ type: "addPlateAppearance", result: "OUT" }]);
    await applyOps("G20990156", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, result: null }]);
    const p0 = tip().plate_appearances[0];
    expect(p0.result).toBe(null);       // 結果不明で保存(OUTのまま残らない)
    expect(p0.complete).not.toBe(false); // INC(打席継続中)とは別=打席は完了扱い
    expect(p0.runs).toHaveLength(0);     // 得点も捏造しない
  });
});

describe("Phase B: 再導出スイープ(§10.3)", () => {
  const LINEUP_ROWS = [
    { order: 1, position: "6", player_id: "P1" },
    { order: 2, position: "2", player_id: "P2" },
  ];

  it("[§10.6 非破壊] 上流編集で盤面から消えた走者の明示生還は落とさず保持し、R1が食い違いをflagする", async () => {
    await applyOps("G20990161", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: LINEUP_ROWS },
      { type: "addPlateAppearance", result: "H1" }, // 1番出塁
      { type: "addPlateAppearance", result: "H2", baserunning_after: [{ from: "1", to: "home" }] }, // 一塁走者が生還=1点
    ]);
    let d = tip();
    expect(d.plate_appearances[1].runs).toHaveLength(1);
    // 上流(1打席目)を三振に修正 → 一塁走者が盤面から消える → 後続の明示生還は盤面不支持に
    await applyOps("G20990161", [{ type: "editPlateAppearance", inning: 1, half: "top", order: 1, result: "K" }]);
    d = tip();
    expect(d.plate_appearances[0].result).toBe("K");
    // 非破壊: 明示された生還は黙って0にせず保持(★リワークの中核)
    expect(d.plate_appearances[1].runs).toHaveLength(1);
    // 食い違いは R1(得点数≠盤面から導いた生還数) で flag(保持=強制でない)
    const flags = validateGame(d);
    expect(flags.some((f) => f.rule === "R1" && f.half === "top" && f.order === 2)).toBe(true);
  });

  it("[§10.6] 責任投手の手動上書きは doc.run_overrides に保持され、編集を跨いでも読み取りで帰属する(自責は導出)", async () => {
    // 相手攻撃halfで失点する試合をシード(責任投手は runs[] でなく手動 run_override で明示する)
    const base = seed("G20990162", {
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
    void base;
    // 責任投手を m9 に手動上書き → doc.run_overrides(manual)へ(runs[]には畳まない)
    await applyOps("G20990162", [{ type: "editPlateAppearance", pa_id: "b2", inning: 1, half: "bottom", order: 2, run_overrides: [{ runner_id: "o1", responsible_pitcher_id: "m9" }] }]);
    // 実況だけ別編集 → スイープがrunsを再導出しても手動値は doc.run_overrides に保持
    await applyOps("G20990162", [{ type: "editPlateAppearance", pa_id: "b2", inning: 1, half: "bottom", order: 2, note: "タイムリー" }]);
    const d = tip();
    expect(d.run_overrides?.some((o) => o.pa_id === "b2" && o.runner_id === "o1" && o.responsible_pitcher_id === "m9" && o.origin === "manual")).toBe(true);
    // read時導出(集計/検査/表示が使う共有関数)で o1 の得点は m9 へ帰属
    const b2 = d.plate_appearances.find((p) => p.id === "b2")!;
    expect(deriveResponsiblePitchers(d).get(b2)?.get("o1")).toBe("m9");
    // 自責フラグは導出の近似(記録値として凍結しない・正本は投手記録)。hit→earned:true
    expect(b2.runs.find((r) => r.runner_id === "o1")!.earned).toBe(true);
  });

  it("不変ID: pa_id指定は削除でorderが振り直された後でも正しい打席に当たる", async () => {
    await applyOps("G20990163", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: LINEUP_ROWS },
      { type: "addPlateAppearance", result: "OUT" },
      { type: "addPlateAppearance", result: "K" },
      { type: "addPlateAppearance", result: "H1" },
    ]);
    const idOf3 = tip().plate_appearances[2].id!; // 3打席目(H1)
    // 1打席目を削除 → 旧#3は order2 に繰り上がる
    await applyOps("G20990163", [{ type: "removePlateAppearance", inning: 1, half: "top", order: 1 }]);
    // 古いアドレス(order3)ではなく不変IDで編集 → 正しい打席(H1→H2)に当たる
    await applyOps("G20990163", [{ type: "editPlateAppearance", pa_id: idOf3, inning: 1, half: "top", order: 3, result: "H2" }]);
    const pas = tip().plate_appearances;
    expect(pas).toHaveLength(2);
    expect(pas[1].id).toBe(idOf3);
    expect(pas[1].order).toBe(2); // スイープが振り直し
    expect(pas[1].result).toBe("H2");
    // 存在しないIDは「画面が古い」エラー
    await expect(
      applyOps("G20990163", [{ type: "editPlateAppearance", pa_id: "b999", inning: 1, half: "top", order: 1, result: "K" }])
    ).rejects.toThrow(/見つかりません/);
  });
});

describe("deleteGame: 試合まるごと削除(ハード)", () => {
  it("公開doc・全版履歴を消す。存在しない試合はエラー", async () => {
    const d = seed("G20990131");
    history.push(
      { game_id: "G20990131", gen: 1, draft: false, snapshot: d, updated_at: "", updated_by: "admin", edit_source: "manual", input: null },
      { game_id: "G20990131", gen: 2, draft: true, snapshot: d, updated_at: "", updated_by: "ai", edit_source: "ai_aggregate", input: null },
      { game_id: "G20990199", gen: 1, draft: false, snapshot: d, updated_at: "", updated_by: "admin", edit_source: "manual", input: null }, // 他試合は残す
    );
    const r = await deleteGame("G20990131");
    expect(r.versions).toBe(2); // 下書き含む全版
    expect(gamesCol.has("G20990131")).toBe(false);
    expect(history.filter((h) => h.game_id === "G20990131")).toHaveLength(0);
    expect(history.filter((h) => h.game_id === "G20990199")).toHaveLength(1); // 他試合は無傷
    await expect(deleteGame("G20990131")).rejects.toThrow(/見つかりません/);
  });
});

describe("[タスクC 助っ人ライフサイクル] discardGame: 破棄draftだけが参照していた guest マスタを掃除する", () => {
  // 方針: 名前一致での自動再利用(同一人物の自動同定)はしない。増殖の根因=破棄draftが作った guest の残留を
  //   discard 時に断つ。参照が残る guest(公開版/他試合/working)は消さない=疑わしきは残す。
  const draftWithGuest = (id: string, guestName: string) =>
    applyOps(id, [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "6", player_id: "P1" },
        { order: 2, position: "7", guest_name: guestName },
      ] },
      { type: "addPlateAppearance", result: "H1" },
    ], { draft: true, replace: true });

  it("(1) draft が作った助っ人は discard で master からも消える(戻り値=削除版数の既存契約は不変)", async () => {
    await draftWithGuest("GDC1", "助っ人破棄郎");
    const gp = guestMock.made.find((g) => g.name === "助っ人破棄郎")!;
    expect(gp).toBeDefined();
    const removed = await discardGame("GDC1");
    expect(removed).toBe(1); // 既存契約: 削除した draft 版数
    expect(deletePlayer).toHaveBeenCalledWith(gp.id);
    expect(guestMock.made.some((g) => g.id === gp.id)).toBe(false); // マスタから消えた
  });

  it("(2) 公開版が参照する助っ人は discard しても消えない", async () => {
    await draftWithGuest("GDC2", "公開助っ人");
    await publishGame("GDC2"); // 公開版が guest を参照する状態に
    await applyOps("GDC2", [{ type: "addPlateAppearance", result: "K" }], { draft: true }); // 公開後の下書き
    const gp = guestMock.made.find((g) => g.name === "公開助っ人")!;
    const removed = await discardGame("GDC2");
    expect(removed).toBe(1); // 公開後に積んだ draft 1版だけ破棄(公開版は非破壊)
    expect(deletePlayer).not.toHaveBeenCalled();
    expect(guestMock.made.some((g) => g.id === gp.id)).toBe(true); // 公開版の参照が残る=マスタは残す
  });

  it("(3) 別試合が参照する助っ人は消えない", async () => {
    // 別試合 GDC3B(公開)が guest P950 を参照している
    guestMock.made.push({ id: "P950", name: "共有助っ人", type: "guest" });
    seed("GDC3B", { participants: [{ id: "m1", link: { kind: "roster", player_id: "P950" } }] });
    // 破棄対象 GDC3A: draft だけが同じ P950 を参照
    const d = seed("GDC3A", { participants: [{ id: "m1", link: { kind: "roster", player_id: "P950" } }] });
    gamesCol.delete("GDC3A"); // 未公開(draftのみ)の試合にする
    history.push({ game_id: "GDC3A", gen: 1, draft: true, snapshot: d, updated_at: "", updated_by: "ai", edit_source: "ai_aggregate", input: null });
    const removed = await discardGame("GDC3A");
    expect(removed).toBe(1);
    expect(deletePlayer).not.toHaveBeenCalled(); // 別試合(GDC3B 公開版)の参照が残る=消さない
    expect(guestMock.made.some((g) => g.id === "P950")).toBe(true);
  });

  it("(4) どの試合とも無関係な手動追加 guest(未参照)は discard で消えない(候補にすらならない=誤削除の構造的排除)", async () => {
    guestMock.made.push({ id: "P960", name: "手動追加助っ人", type: "guest" });
    await applyOps("GDC4", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [{ order: 1, position: "6", player_id: "P1" }] },
    ], { draft: true, replace: true });
    const removed = await discardGame("GDC4");
    expect(removed).toBe(1);
    expect(deletePlayer).not.toHaveBeenCalled(); // 破棄draftが参照していない guest は候補に載らない
    expect(guestMock.made.some((g) => g.id === "P960")).toBe(true);
  });

  it("(5) 集計→破棄→集計を繰り返しても同名 guest が増殖しない(最終的に1つ)", async () => {
    await draftWithGuest("GDC5", "常連助っ人");
    await discardGame("GDC5");
    await draftWithGuest("GDC5", "常連助っ人");
    await discardGame("GDC5");
    await draftWithGuest("GDC5", "常連助っ人");
    // 名前による自動再利用はしない(集計のたび新規採番)が、破棄時の掃除で残骸が消える=最終的に同名は1つだけ
    expect(guestMock.made.filter((g) => g.name === "常連助っ人")).toHaveLength(1);
    expect(vi.mocked(deletePlayer).mock.calls).toHaveLength(2); // 破棄2回で残骸2件を掃除
  });
});

describe("validator: R2二軸(責任投手の網羅)とR6(参加者重複)", () => {
  it("R2: 相手攻撃halfの自軍責任投手が未登録なら検出(旧実装は未検査)", () => {
    const d = doc({ home_away: "away" });
    delete d.attendance;
    delete d.additional_players;
    d.participants = [{ id: "m1", link: { kind: "roster", player_id: "P1" } }];
    d.lineup_snapshots = [];
    d.plate_appearances = [
      pa({ inning: 1, half: "bottom", order: 1, batter_id: "o1", opponent_slot: 1, result: "HR",
        runs: [{ runner_id: "o1", rbi: true, earned: true, cause: "hr", responsible_pitcher_id: "mX" }] }),
    ];
    const flags = validateGame(d);
    expect(flags.some((f) => f.rule === "R2" && f.detail.includes("mX"))).toBe(true);
    // 相手の打者/走者(o1)は対象外(誤フラグしない)
    expect(flags.some((f) => f.rule === "R2" && f.detail.includes("o1"))).toBe(false);
  });

  it("R6: 同一マスタ選手を指す参加者が2つあると検出", () => {
    const d = doc({ home_away: "away" });
    delete d.attendance;
    delete d.additional_players;
    d.lineup_snapshots = [];
    d.participants = [
      { id: "m1", link: { kind: "roster", player_id: "P1" } },
      { id: "m2", link: { kind: "roster", player_id: "P1" } },
    ];
    d.plate_appearances = [pa({ inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" })];
    const flags = validateGame(d);
    expect(flags.some((f) => f.rule === "R6" && f.detail.includes("P1"))).toBe(true);
  });
});

describe("Phase E-1: R4突合(最終スコア)を公開・メタ保存の経路で必ず走らせる", () => {
  it("メタ保存(upsertGameMeta)で最終スコアを入れ、導出と食い違えばR4注記が付く", async () => {
    // away=自軍top(seed既定)。自軍1点(HR)を導出する公開試合をシード(annotations無し・result無し)。
    seed("G20990181", {
      plate_appearances: [
        pa({ inning: 1, half: "top", order: 1, batter_id: "P1", result: "HR",
          runs: [{ runner_id: "P1", rbi: true, earned: true, cause: "hr" }] }),
      ],
    });
    // 申告スコア5点(導出1点と食い違う)をメタ保存経路で最後に入れる → 突合が走ってR4がsurfaceする。
    await upsertGameMeta({
      id: "G20990181", date: "2026-07-01", opponent: "X", home_away: "away",
      result: { our_score: 5, their_score: 0, outcome: "win", decided_by: "regulation" },
    });
    const ann = tip().plate_appearances[0].annotations ?? [];
    expect(ann.some((a) => a.type === "unclear" && a.source === "validator" && a.rule === "R4")).toBe(true);
  });

  it("公開(publishGame)は検証未走の下書き(スコア食い違い)でもR4をsurfaceして公開する", async () => {
    // 検証を通していない下書き版(R4注記無し・result食い違い)を直接履歴に積む。
    const d = doc({
      home_away: "away",
      game: { id: "G20990182", date: "2026-07-01", opponent: "X", league: null, home_away: "away",
        result: { our_score: 9, their_score: 0, outcome: "win", decided_by: "regulation" } },
      plate_appearances: [
        pa({ inning: 1, half: "top", order: 1, batter_id: "P1", result: "HR",
          runs: [{ runner_id: "P1", rbi: true, earned: true, cause: "hr" }] }),
      ],
    });
    delete d.attendance; delete d.additional_players;
    history.push({ game_id: "G20990182", gen: 1, draft: true, snapshot: d, updated_at: "", updated_by: "ai", edit_source: "ai_aggregate", input: null });
    await publishGame("G20990182");
    const published = tip();
    const ann = published.plate_appearances[0].annotations ?? [];
    expect(ann.some((a) => a.type === "unclear" && a.source === "validator" && a.rule === "R4")).toBe(true);
    expect(history[history.length - 1].draft).toBe(false); // 公開版として積まれている
  });

  it("出欠保存(setAttendance)経路も検証を通す(スコア食い違いでR4)", async () => {
    seed("G20990183", {
      game: { id: "G20990183", date: "2026-07-01", opponent: "X", league: null, home_away: "away",
        result: { our_score: 4, their_score: 0, outcome: "win", decided_by: "regulation" } },
      participants: [{ id: "m1", link: { kind: "roster", player_id: "P1" } }],
      plate_appearances: [
        pa({ inning: 1, half: "top", order: 1, batter_id: "m1", result: "HR",
          runs: [{ runner_id: "m1", rbi: true, earned: true, cause: "hr" }] }),
      ],
    });
    await setAttendance("G20990183", [{ player_id: "P1" }]);
    const ann = tip().plate_appearances[0].annotations ?? [];
    expect(ann.some((a) => a.type === "unclear" && a.source === "validator" && a.rule === "R4")).toBe(true);
  });
});

describe("F-4 AI全置換(replace)で投手記録・ベンチのみ参加者を再グラフト", () => {
  it("再集計後も自責・勝敗Sが同一投手へ引き継がれ、出欠のみ参加者はparticipantとして残る", async () => {
    seed("G20990171", {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m9", link: { kind: "roster", player_id: "PP" } }, // 投手
        { id: "m3", link: { kind: "roster", player_id: "P3" } }, // ベンチのみ(打席ゼロ)
      ],
      plate_appearances: [pa({ id: "b1", inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" })],
      pitching: [{ pitcher_id: "m9", earned_runs: 2, decision: "W" }],
    });
    // AI再集計(全置換): P1とPP(投手pos1)を組み直す。P3(ベンチ)はノートに出てこない。
    await applyOps("G20990171", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [
        { order: 1, position: "1", player_id: "PP" },
        { order: 2, position: "6", player_id: "P1" },
      ] },
      { type: "addPlateAppearance", result: "H1" },
    ], { draft: true, replace: true });
    const d = tip();
    // (a) 投手記録: PPの自責2・勝利Wが新しいPP参加者IDへ引き継がれる
    const ppNew = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "PP")!;
    expect(d.pitching).toEqual([{ pitcher_id: ppNew.id, earned_runs: 2, decision: "W" }]);
    // (b) ノートに出てこないP3は participant として再追加(出欠=第一級の保全)
    const p3 = d.participants!.find((p) => p.link.kind === "roster" && p.link.player_id === "P3");
    expect(p3).toBeDefined();
    // V-B: 重複participantは無い
    expect(validateGame(d).some((f) => f.rule === "R6")).toBe(false);
  });

  it("引き継げない投手記録は末尾打席に注記し、投手自身はparticipantとして残る(出欠保全)", async () => {
    seed("G20990172", {
      participants: [
        { id: "m1", link: { kind: "roster", player_id: "P1" } },
        { id: "m9", link: { kind: "roster", player_id: "PP" } },
      ],
      plate_appearances: [pa({ id: "b1", inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" })],
      pitching: [{ pitcher_id: "m9", earned_runs: 3 }],
    });
    // 再集計にPPが出てこない → 記録は引き継げず注記。
    await applyOps("G20990172", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "X", home_away: "away" },
      { type: "setStartingLineup", rows: [{ order: 1, position: "6", player_id: "P1" }] },
      { type: "addPlateAppearance", result: "H1" },
    ], { draft: true, replace: true });
    const d = tip();
    expect(d.pitching).toBeUndefined(); // 引き継げた記録ゼロ=pitchingは付けない
    const last = d.plate_appearances.at(-1)!;
    expect((last.annotations ?? []).some((a) => a.type === "unclear" && a.detail.includes("引き継げませんでした") && a.detail.includes("投森"))).toBe(true);
    // 出欠は保全: PPは participant として残る
    expect(d.participants!.some((p) => p.link.kind === "roster" && p.link.player_id === "PP")).toBe(true);
  });
});

describe("AI全置換(replace): ノート沈黙のメタ(区分/先後/対戦相手)は手入力値を保持する", () => {
  // 手入力メタ(league/home_away/opponent)を持つ試合を、区分に触れないノートでAI再集計しても
  // 手入力が無音で消えない(=AIがnull/空を出したフィールドは旧値へマージ)ことを固定する。
  const seedMeta = (id: string) =>
    seed(id, {
      game: { id, date: "2026-07-01", opponent: "ライバルズ", league: "E2Eテスト", home_away: "away" },
      participants: [{ id: "m1", link: { kind: "roster", player_id: "P1" } }],
      plate_appearances: [pa({ id: "b1", inning: 1, half: "top", order: 1, batter_id: "m1", result: "H1" })],
    });

  it("ノートが区分に言及しない(AIが league:null)なら、手入力の区分を保持する", async () => {
    seedMeta("G20990191");
    // ノート沈黙をAIの出力で再現: league は null(=何も言っていない)。opponent/home_away はノートから確定。
    await applyOps("G20990191", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "ライバルズ", home_away: "away", league: null },
      { type: "setStartingLineup", rows: [{ order: 1, position: "6", player_id: "P1" }] },
      { type: "addPlateAppearance", result: "H1" },
    ], { draft: true, replace: true });
    const g = tip().game;
    expect(g.league).toBe("E2Eテスト"); // 手入力の区分は沈黙時に保持(空へ化けない)
    expect(g.opponent).toBe("ライバルズ");
    expect(g.home_away).toBe("away");
  });

  it("ノートが区分に言及する(AIが非空の league)なら、AI値で更新する", async () => {
    seedMeta("G20990192");
    await applyOps("G20990192", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "ライバルズ", home_away: "away", league: "練習試合" },
      { type: "setStartingLineup", rows: [{ order: 1, position: "6", player_id: "P1" }] },
      { type: "addPlateAppearance", result: "H1" },
    ], { draft: true, replace: true });
    expect(tip().game.league).toBe("練習試合"); // ノートが区分に触れた→AI値を採用
  });

  it("先後(home_away)・対戦相手(opponent)も、AIが null/空なら手入力を保持する", async () => {
    seed("G20990193", {
      game: { id: "G20990193", date: "2026-07-01", opponent: "ライバルズ", league: "E2Eテスト", home_away: "home" },
      participants: [{ id: "m1", link: { kind: "roster", player_id: "P1" } }],
      plate_appearances: [pa({ id: "b1", inning: 1, half: "bottom", order: 1, batter_id: "m1", result: "H1" })],
    });
    // AIが先後・対戦相手を確定できず null/空 を出す(ノート沈黙)
    await applyOps("G20990193", [
      { type: "setGameMeta", date: "2026-07-01", opponent: "", home_away: null, league: null },
      { type: "setStartingLineup", rows: [{ order: 1, position: "6", player_id: "P1" }] },
      { type: "addPlateAppearance", half: "bottom", result: "H1" },
    ], { draft: true, replace: true });
    const g = tip().game;
    expect(g.home_away).toBe("home");     // 手入力の先後を保持
    expect(g.opponent).toBe("ライバルズ"); // 手入力の対戦相手を保持
    expect(g.league).toBe("E2Eテスト");    // 手入力の区分を保持
  });
});
