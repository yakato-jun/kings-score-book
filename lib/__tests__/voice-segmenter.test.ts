import { describe, it, expect } from "vitest";
import { createSegmenter, DEFAULT_SEGMENTER_OPTS } from "../voice-segmenter";

// 発話区切り状態機械の単体テスト。実マイク・ブラウザAPIは使わない:
// push(rms, dtMs) を ~100ms 刻みで模擬呼び出しし、cut のタイミングだけを契約として検証する。

const STEP = 100; // 実装側の想定呼び出し間隔(~100ms)に合わせる
const VOICE = 0.5; // 明確な有声(threshold=0.03 より十分上)
const QUIET = 0.001; // 明確な無音(ノイズフロア相当)

// ms ぶん一定の rms を push し続け、途中で返った結果を全て集める(cut の回数・位置の検証用)
function feed(seg: ReturnType<typeof createSegmenter>, rms: number, ms: number): Array<"none" | "cut"> {
  const out: Array<"none" | "cut"> = [];
  for (let t = 0; t < ms; t += STEP) out.push(seg.push(rms, STEP));
  return out;
}

describe("createSegmenter: 基本の区切り", () => {
  it("(1) 発話300ms以上→無音1.8秒で cut する", () => {
    const seg = createSegmenter();
    expect(feed(seg, VOICE, 300)).toEqual(["none", "none", "none"]); // 発話中は切らない
    const silence = feed(seg, QUIET, DEFAULT_SEGMENTER_OPTS.silenceMs);
    // 無音連続がちょうど silenceMs(1800ms) に達した push で cut。それ以前は none
    expect(silence.slice(0, -1).every((r) => r === "none")).toBe(true);
    expect(silence[silence.length - 1]).toBe("cut");
  });

  it("(1)' 閾値ちょうどのRMSは有声として扱う(>=)", () => {
    const seg = createSegmenter();
    feed(seg, DEFAULT_SEGMENTER_OPTS.threshold, 300); // ちょうど threshold=有声
    expect(seg.hadVoice()).toBe(true);
    const silence = feed(seg, QUIET, DEFAULT_SEGMENTER_OPTS.silenceMs);
    expect(silence[silence.length - 1]).toBe("cut");
  });

  it("(2) 無音だけでは何分経っても cut しない", () => {
    const seg = createSegmenter();
    // 5分の無音(hardCapMs=60秒 を大きく超える)。緩い条件に切り替わっても有声ゼロなら切らない
    const results = feed(seg, QUIET, 5 * 60 * 1000);
    expect(results.every((r) => r === "none")).toBe(true);
    expect(seg.hadVoice()).toBe(false);
  });

  it("(3) 短い物音(minVoiceMs未満)+無音では cut しない", () => {
    const seg = createSegmenter();
    feed(seg, VOICE, 200); // 200ms < minVoiceMs(300ms) = 咳・物音レベル
    expect(seg.hadVoice()).toBe(false);
    const results = feed(seg, QUIET, 10_000); // その後どれだけ無音が続いても
    expect(results.every((r) => r === "none")).toBe(true);
  });
});

describe("createSegmenter: cut後のリセットと再機能", () => {
  it("(4) cut 後は状態がリセットされ、次の発話で再び cut できる", () => {
    const seg = createSegmenter();
    feed(seg, VOICE, 500);
    let silence = feed(seg, QUIET, DEFAULT_SEGMENTER_OPTS.silenceMs);
    expect(silence[silence.length - 1]).toBe("cut");
    // cut 直後は内部リセット済み=有声なしの状態から始まる
    expect(seg.hadVoice()).toBe(false);
    // 前セグメントの無音を持ち越さない: 新しい発話→無音で再び正しく cut する
    feed(seg, VOICE, 400);
    expect(seg.hadVoice()).toBe(true);
    silence = feed(seg, QUIET, DEFAULT_SEGMENTER_OPTS.silenceMs);
    expect(silence.slice(0, -1).every((r) => r === "none")).toBe(true);
    expect(silence[silence.length - 1]).toBe("cut");
  });
});

describe("createSegmenter: ハードキャップ(長話の分割)", () => {
  it("(5) hardCap超過後は relaxedSilenceMs の短い息継ぎで cut する", () => {
    const seg = createSegmenter();
    // hardCap 到達前は 800ms の無音では切らない(通常条件 silenceMs=1800ms が適用される)
    feed(seg, VOICE, 30_000);
    let results = feed(seg, QUIET, DEFAULT_SEGMENTER_OPTS.relaxedSilenceMs);
    expect(results.every((r) => r === "none")).toBe(true);
    // 発話を続けて hardCapMs(60秒) を超えさせる
    feed(seg, VOICE, 31_000);
    // 息継ぎ程度の無音(relaxedSilenceMs=800ms)で cut される
    results = feed(seg, QUIET, DEFAULT_SEGMENTER_OPTS.relaxedSilenceMs);
    expect(results.slice(0, -1).every((r) => r === "none")).toBe(true);
    expect(results[results.length - 1]).toBe("cut");
  });
});

describe("createSegmenter: 文中の谷では切らない", () => {
  it("(6) 有声が続く限り silenceMs 未満の無音の谷では cut しない", () => {
    const seg = createSegmenter();
    // 発話1秒→間1秒(silenceMs=1800ms 未満)を10回繰り返しても一度も切れない
    for (let i = 0; i < 10; i++) {
      expect(feed(seg, VOICE, 1000).every((r) => r === "none")).toBe(true);
      expect(feed(seg, QUIET, 1000).every((r) => r === "none")).toBe(true);
    }
    // その後まとまった無音が来れば通常どおり cut する
    const silence = feed(seg, QUIET, DEFAULT_SEGMENTER_OPTS.silenceMs);
    expect(silence).toContain("cut");
  });
});
