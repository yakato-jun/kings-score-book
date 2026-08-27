import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { correctTranscript, applyCorrections, type CorrectTransport } from "../ai/voice";

// 音声補正レイヤの単体テスト。実APIは叩かない: correctTranscript は transport 注入を受けるので、
// テストからは API 呼び出し部だけを差し替えて契約を検証する。
// 契約(構造で縛る): モデルが出せるのは置換ペアの列挙のみ。本文への適用はコード(applyCorrections)が行う
// =言い換え・作文は構造的に不可能。失敗しても例外を投げず raw を返す(音声入力を硬く失敗させない)。

const RAW = "1回表、ナカムラがヒット。ヤマモトは三振。ヤマモトの守備は遊撃。";
const DICT = ["中村", "山本"];

describe("applyCorrections: 置換ペアのコード適用(決定的)", () => {
  it("本文に現れるペアだけを全出現に適用し、適用したものだけを返す", () => {
    const r = applyCorrections(RAW, [
      { heard: "ヤマモト", corrected: "山本" },
      { heard: "タカハシ", corrected: "高橋" }, // 本文に無い=無効(モデルの空振り)
    ]);
    expect(r.text).toBe("1回表、ナカムラがヒット。山本は三振。山本の守備は遊撃。"); // 全出現置換
    expect(r.applied).toEqual([{ heard: "ヤマモト", corrected: "山本" }]);
  });
  it("空のheard・heard===corrected・同一heardの重複指定は無効(先勝ち)", () => {
    const r = applyCorrections("ナカムラとヤマモト", [
      { heard: "", corrected: "x" },
      { heard: "ヤマモト", corrected: "ヤマモト" },
      { heard: "ナカムラ", corrected: "中村" },
      { heard: "ナカムラ", corrected: "掘切" }, // 同一heardの2つ目は無視(先勝ち)
    ]);
    expect(r.text).toBe("中村とヤマモト");
    expect(r.applied).toEqual([{ heard: "ナカムラ", corrected: "中村" }]);
  });
});

describe("correctTranscript: 正常応答(置換ペア)の適用", () => {
  it("ペアをコードで適用し、適用済み一覧を返す", async () => {
    let seen: { model: string; systemText: string; userText: string } | null = null;
    const transport: CorrectTransport = async (args) => {
      seen = args;
      return {
        corrections: [
          { heard: "ナカムラ", corrected: "中村" },
          { heard: "ヤマモト", corrected: "山本" },
        ],
      };
    };
    const r = await correctTranscript(RAW, DICT, transport);
    expect(r.text).toBe("1回表、中村がヒット。山本は三振。山本の守備は遊撃。");
    expect(r.corrections).toEqual([
      { heard: "ナカムラ", corrected: "中村" },
      { heard: "ヤマモト", corrected: "山本" },
    ]);
    // 辞書は名前だけがシステム文に載る(IDを渡さない契約)。本文は userText にそのまま渡る。
    expect(seen!.systemText).toContain("中村");
    expect(seen!.systemText).toContain("山本");
    expect(seen!.userText).toBe(RAW);
  });
  it("不正形の要素は捨てて有効なペアだけ適用する", async () => {
    const transport: CorrectTransport = async () => ({
      corrections: [{ heard: "ナカムラ" }, { heard: "ヤマモト", corrected: "山本" }, "junk"],
    });
    const r = await correctTranscript(RAW, DICT, transport);
    expect(r.text).toBe("1回表、ナカムラがヒット。山本は三振。山本の守備は遊撃。");
    expect(r.corrections).toEqual([{ heard: "ヤマモト", corrected: "山本" }]);
  });
});

describe("correctTranscript: フォールバック(例外を投げない)", () => {
  // フォールバック経路は console.error でログする仕様なので、テスト出力を汚さないよう黙らせる。
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("API例外 → raw をそのまま返す(corrections は空)", async () => {
    const transport: CorrectTransport = async () => { throw new Error("api down"); };
    const r = await correctTranscript(RAW, DICT, transport);
    expect(r).toEqual({ text: RAW, corrections: [] });
  });

  it("出力が復元不能(undefined=壊れたJSON等) → raw フォールバック", async () => {
    const transport: CorrectTransport = async () => undefined;
    const r = await correctTranscript(RAW, DICT, transport);
    expect(r).toEqual({ text: RAW, corrections: [] });
  });

  it("corrections が欠落/非配列 → raw フォールバック", async () => {
    const transport: CorrectTransport = async () => ({ corrections: "oops" });
    const r = await correctTranscript(RAW, DICT, transport);
    expect(r).toEqual({ text: RAW, corrections: [] });
  });
});
