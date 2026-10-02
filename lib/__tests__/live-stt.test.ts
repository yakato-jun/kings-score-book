import { describe, it, expect } from "vitest";
import { createLiveOrdering } from "../live-stt/ordering";
import { resample, floatToPcm16, bytesToBase64 } from "../live-stt/pcm";

// Live 文字起こしの純ロジック: item 整列(到着順が入れ替わっても発話順で放出)と PCM 変換。

describe("createLiveOrdering", () => {
  it("delta は item ごとに連結され、確定前の途中テキストとして発話順に見える", () => {
    const o = createLiveOrdering();
    o.delta("a", "一回"); o.delta("a", "表");
    o.delta("b", "山田");
    expect(o.partial()).toBe("一回表 山田");
  });

  it("確定は発話順に放出する(後の item が先に確定しても、前が確定するまで出さない)", () => {
    const o = createLiveOrdering();
    o.delta("a", "一回表"); o.delta("b", "山田");
    expect(o.completed("b", "山田ヒット")).toEqual([]);
    expect(o.partial()).toBe("一回表 山田ヒット");
    expect(o.completed("a", "一回表")).toEqual(["一回表", "山田ヒット"]);
    expect(o.pending()).toBe(false);
    expect(o.partial()).toBe("");
  });

  it("空の確定(無音の item)は放出しないが、後続の放出は塞がない", () => {
    const o = createLiveOrdering();
    o.delta("a", ""); o.delta("b", "佐藤");
    expect(o.completed("b", "佐藤ゴロ")).toEqual([]);
    expect(o.completed("a", "  ")).toEqual(["佐藤ゴロ"]);
  });

  it("失敗した item は捨てて後続を放出する", () => {
    const o = createLiveOrdering();
    o.delta("a", "あ"); o.delta("b", "い");
    o.completed("b", "い");
    expect(o.failed("a")).toEqual(["い"]);
    expect(o.pending()).toBe(false);
  });
});

describe("pcm", () => {
  it("同レートはそのまま、48k→24k は半分の長さで補間する", () => {
    const x = new Float32Array([0, 0.5, 1, 0.5]);
    expect(resample(x, 24000, 24000)).toBe(x);
    expect(Array.from(resample(x, 48000, 24000))).toEqual([0, 1]);
  });

  it("Float32 → PCM16 LE(範囲外はクリップ)", () => {
    const b = floatToPcm16(new Float32Array([0, 1, -1, 2]));
    const v = new DataView(b.buffer);
    expect([v.getInt16(0, true), v.getInt16(2, true), v.getInt16(4, true), v.getInt16(6, true)]).toEqual([0, 32767, -32768, 32767]);
  });

  it("base64 は Buffer と一致する(分割境界をまたぐ長さでも)", () => {
    const bytes = new Uint8Array(0x8000 + 7).map((_, i) => i % 251);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
