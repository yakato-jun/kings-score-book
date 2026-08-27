import { describe, it, expect } from "vitest";
import { toGameOp } from "../ai/agent";

// AIのフラットop → ops層 GameOpInput の写像契約。
// 背景(2026-08-18 ユーザー確定): 実在する事実は「参加/守備位置/打順枠」の3つだけで「選手交代」はこの複合＝
// AIの語彙から substitutePlayer を撤去し、打順枠の変化は changeBattingOrder(order_changes)で表す
// (ops層 reduceSubstitutePlayer は UI/過去互換で残置)。

describe("toGameOp: changeBattingOrder の写像", () => {
  it("order_changes → rows・timing は inning/half から組む(「AがBの枠に入った」=2件・order:null=枠から外れる)", () => {
    const g = toGameOp({ op: "changeBattingOrder", order_changes: [{ player: "P004", order: 5 }, { player: "高橋 健", order: null }], inning: 5, half: "top" });
    expect(g).toEqual({ type: "changeBattingOrder", rows: [{ player: "P004", order: 5 }, { player: "高橋 健", order: null }], timing: { inning: 5, half: "top" } });
  });
  it("substitutePlayer は AI の語彙から撤去済み=未知の操作としてエラー(黙って別opに化けない)", () => {
    expect(() => toGameOp({ op: "substitutePlayer", out_player: "P010", in_guest_name: "山本", inning: 6, half: "bottom" }))
      .toThrow(/未知の操作/);
  });
});
