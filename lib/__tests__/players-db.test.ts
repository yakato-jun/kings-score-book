import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Player } from "../types/v2";

// DBモック: getDb を差し替え、Atlas に接続せず loadPlayerMap の正規化(type既定)を検証
vi.mock("../db/mongo", () => ({ getDb: vi.fn() }));
import { getDb } from "../db/mongo";
import { loadPlayerMap } from "../db/players";
import { createGuestPlayer, setPlayerType, upsertPlayer } from "../ops/players";

// type: 未設定 / 空文字 / 既存の非空値("member") / "guest" を混在させる
let players: Player[];

beforeEach(() => {
  players = [
    { id: "P001", name: "一郎" }, // type 未設定
    { id: "P002", name: "二郎", type: "" }, // type 空
    { id: "P003", name: "三郎", type: "member" }, // 既存の非空値
    { id: "P004", name: "助っ人", type: "guest" }, // 新設値
  ];
  // loadPlayerList=find().sort().toArray() / loadPlayers=find().toArray() / writePlayer=replaceOne(upsert) を返すフェイクcollection
  (getDb as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    collection: () => ({
      find: () => ({
        sort: () => ({ toArray: async () => [...players].sort((a, b) => a.id.localeCompare(b.id)) }),
        toArray: async () => players,
      }),
      replaceOne: async (q: { id: string }, d: Player) => {
        const i = players.findIndex((p) => p.id === q.id);
        if (i >= 0) players[i] = d; else players.push(d);
        return { acknowledged: true };
      },
    }),
  });
});

describe("loadPlayerMap (getDbモック)", () => {
  it("id → Player の Map を返す", async () => {
    const m = await loadPlayerMap();
    expect(m.get("P003")?.name).toBe("三郎");
    expect([...m.keys()]).toEqual(["P001", "P002", "P003", "P004"]);
  });
  it("未設定/空の type は既定 'regular' に正規化（メモリ上のみ）", async () => {
    const m = await loadPlayerMap();
    expect(m.get("P001")?.type).toBe("regular");
    expect(m.get("P002")?.type).toBe("regular");
  });
  it("既存の非空値・新設値 'guest' はそのまま保持", async () => {
    const m = await loadPlayerMap();
    expect(m.get("P003")?.type).toBe("member");
    expect(m.get("P004")?.type).toBe("guest");
  });
});

describe("[§12 P1] createGuestPlayer / setPlayerType / validate 緩和", () => {
  it("createGuestPlayer: 種別guestで新規採番(P###)し、マスタへ書き込む", async () => {
    const p = await createGuestPlayer("新助っ人");
    expect(p.type).toBe("guest");
    expect(/^P\d{3}$/.test(p.id)).toBe(true);
    expect(p.id).toBe("P005"); // 既存最大 P004 の次
    expect((await loadPlayerMap()).get("P005")?.name).toBe("新助っ人");
  });

  it("createGuestPlayer: best-effort＝同名でも新規採番(重複防止は作り込まない・後から名寄せ)", async () => {
    const a = await createGuestPlayer("助っ人"); // 既存 P004 と同名でも
    expect(a.id).toBe("P005"); // 再利用せず別マスタを採番する(過剰設計を避ける方針)
  });

  it("setPlayerType: 種別を書き換える(guest→regular=正式加入)。名前は保持", async () => {
    const p = await setPlayerType("P004", "regular");
    expect(p.type).toBe("regular");
    expect(p.name).toBe("助っ人");
    expect((await loadPlayerMap()).get("P004")?.type).toBe("regular");
  });

  it("setPlayerType: 未登録IDはエラー", async () => {
    await expect(setPlayerType("P999", "guest")).rejects.toThrow(/選手マスタにありません/);
  });

  it("upsertPlayer: 旧G-id特別拒否は撤廃。P###以外は従来どおり書式エラー(助っ人誘導文言は出さない)", async () => {
    await expect(upsertPlayer({ id: "G001", name: "x" })).rejects.toThrow(/P001 形式/);
    // 旧「additional_players で記録して」への誘導は出ない
    await expect(upsertPlayer({ id: "G001", name: "x" })).rejects.not.toThrow(/additional_players/);
  });

  it("upsertPlayer: origin(出自)は渡されたら保持する(非破壊)", async () => {
    const p = await upsertPlayer({ id: "P006", name: "移行助っ人", type: "guest", origin: { kind: "guest_migration", game_id: "G1", participant_id: "m3" } });
    expect(p.origin).toEqual({ kind: "guest_migration", game_id: "G1", participant_id: "m3" });
  });
});
