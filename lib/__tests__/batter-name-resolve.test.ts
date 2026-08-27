import { describe, it, expect } from "vitest";
import { buildBatterNameResolver } from "../ops/games";

// [§12 P1追補] 打者参照の名前→player_id 解決(決定的・完全一致のみ)。
// 背景: 同じ集計内で新規作成された助っ人は事前辞書に無く、AIが打席に生の名前を書く→未登録ID(R2)が
// 「作り直す」たびに再現するループの根治。曖昧(同名複数)は触らない=自動同定しない。

const masters = new Map<string, string>([
  ["P013", "山本 太郎"],
  ["P026", "佐々木"],
  ["P027", "佐々木さん知人"],
  ["P030", "山田 太郎"],
  ["P031", "山田 次郎"], // 姓が重複(曖昧ケース)
]);
const resolve = buildBatterNameResolver(masters);

describe("buildBatterNameResolver", () => {
  it("フルネーム完全一致は player_id へ解決する", () => {
    expect(resolve("佐々木さん知人")).toBe("P027");
    expect(resolve("山本 太郎")).toBe("P013");
  });
  it("姓(先頭トークン)の一意な完全一致も解決する", () => {
    expect(resolve("山本")).toBe("P013");
  });
  it("同名/同姓が複数なら曖昧として触らない(R2の網に残す)", () => {
    expect(resolve("山田")).toBe("山田"); // 太郎と次郎で曖昧
  });
  it("既知のIDはそのまま", () => {
    expect(resolve("P013")).toBe("P013");
  });
  it("一致しない参照(相手プレースホルダ・未知の名前)は素通り", () => {
    expect(resolve("相手3番")).toBe("相手3番");
    expect(resolve("o3")).toBe("o3");
    expect(resolve("新しい助っ人ヤマモト")).toBe("新しい助っ人ヤマモト");
  });
});
