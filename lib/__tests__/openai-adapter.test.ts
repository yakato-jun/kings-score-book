import { describe, it, expect } from "vitest";
import { isOpenAiModel, parseToolArguments } from "../ai/openai";

// プロバイダ切替(AI_MODEL)の判定と、OpenAI 応答の arguments(JSON文字列)復元の単体テスト。
// SDK 呼び出し自体は純関数の外にあるのでモック不要。
describe("isOpenAiModel: モデルID接頭辞でのプロバイダ自動判別", () => {
  it("gpt- 接頭辞は OpenAI", () => {
    expect(isOpenAiModel("gpt-5.6-sol")).toBe(true);
    expect(isOpenAiModel("gpt-5.6-terra")).toBe(true);
  });

  it("o+数字 接頭辞は OpenAI", () => {
    expect(isOpenAiModel("o3")).toBe(true);
  });

  it("それ以外は Anthropic(現行)", () => {
    expect(isOpenAiModel("claude-fable-5")).toBe(false);
    expect(isOpenAiModel("haiku")).toBe(false);
  });
});

describe("parseToolArguments: function.arguments(常にJSON文字列)→ toolInput 復元", () => {
  it("正常なJSON文字列はオブジェクトに復元", () => {
    expect(parseToolArguments('{"operations":[{"op":"setGameMeta"}],"clarification":null}')).toEqual({
      operations: [{ op: "setGameMeta" }],
      clarification: null,
    });
  });

  it("壊れた文字列は undefined(={} でなく。requestSubmit の復元不能→リトライ経路に乗せる)", () => {
    expect(parseToolArguments('{"operations":[')).toBeUndefined();
  });

  it("null/undefined(tool_call 不在)も undefined", () => {
    expect(parseToolArguments(undefined)).toBeUndefined();
    expect(parseToolArguments(null)).toBeUndefined();
  });
});
