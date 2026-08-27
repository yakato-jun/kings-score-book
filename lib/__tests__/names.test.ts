import { describe, it, expect } from "vitest";
import { playerName, docNameResolver } from "../names";
import type { GameDoc } from "../types/v2";

describe("playerName", () => {
  const players = new Map([["P001", "ダミー太郎"]]);
  it("マスタ登録名を優先", () => {
    expect(playerName("P001", players)).toBe("ダミー太郎");
  });
  it("助っ人(G-id)は試合内連番「助っ人N」", () => {
    expect(playerName("G001", players)).toBe("助っ人1");
    expect(playerName("G002", players)).toBe("助っ人2");
  });
  it("その他の未登録IDはそのまま", () => {
    expect(playerName("O005", players)).toBe("O005");
  });
});

// docNameResolver = validator注記/走者再解決注記の nameOf(buildNameOf)。参加者ID・マスタID・oN・未知を解決する。
describe("docNameResolver (=buildNameOf): participants が名前の正本", () => {
  const players = new Map([["P001", "ダミー太郎"]]);
  const d = {
    schema_version: "2.0",
    game: { id: "G", date: "2026-01-01", opponent: "T", league: null, home_away: null },
    plate_appearances: [],
    participants: [
      { id: "m1", link: { kind: "roster", player_id: "P001" } },
      { id: "m2", link: { kind: "guest", name: "助っ人花子" } },
    ],
  } as unknown as GameDoc;
  const nameOf = docNameResolver(d, players);

  it("roster参加者はマスタ名", () => expect(nameOf("m1")).toBe("ダミー太郎"));
  it("guest参加者はlink.name(実名)", () => expect(nameOf("m2")).toBe("助っ人花子"));
  it("マスタID直参照も名前(R6のdupsはマスタID)", () => expect(nameOf("P001")).toBe("ダミー太郎"));
  it("相手プレースホルダ(oN)は「相手N番」", () => expect(nameOf("o3")).toBe("相手3番"));
  it("未知の内部ID(宙に浮いたmID)は捏造せずそのまま", () => expect(nameOf("m9")).toBe("m9"));
  // 本番 digest 99012289 の回帰ガード: 走者不明(runner_id=null)は第一級の値。nameOf が落ちずに「不明」で表現する
  it("null/undefined(走者不明)は「不明」を返し落ちない", () => {
    expect(nameOf(null)).toBe("不明");
    expect(nameOf(undefined)).toBe("不明");
  });
});
