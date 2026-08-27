import { describe, it, expect } from "vitest";
import { normalizeOperations } from "../ai/agent";

// operations 文字列モード(モデルがJSON文字列で二重エンコードする稀ケース)防御の単体テスト。
// 契約: 配列=素通し / 復元可能な文字列=配列化 / 復元不能=null(呼び元がリトライ判断) / 未指定=空配列。
describe("normalizeOperations: operations のJSON文字列二重エンコード防御", () => {
  it("配列はそのまま素通し(同一参照)", () => {
    const ops = [{ op: "addPlateAppearance", result_code: "H1" }];
    expect(normalizeOperations(ops)).toBe(ops);
  });

  it("正常なJSON文字列(配列)は復元して配列にする", () => {
    expect(normalizeOperations('[{"op":"setGameMeta","date":"2026-05-10"}]')).toEqual([
      { op: "setGameMeta", date: "2026-05-10" },
    ]);
  });

  it("壊れたJSON文字列は null(=リトライ判断)", () => {
    expect(normalizeOperations('[{"op":"addPlateAppearance"')).toBeNull();
  });

  it("JSONとしては正しいが配列でない文字列も null", () => {
    expect(normalizeOperations('{"op":"setGameMeta"}')).toBeNull();
  });

  it("undefined/null は空配列(=operations 無し)扱い", () => {
    expect(normalizeOperations(undefined)).toEqual([]);
    expect(normalizeOperations(null)).toEqual([]);
  });
});
