import { describe, it, expect } from "vitest";
import { playerName } from "../names";

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
