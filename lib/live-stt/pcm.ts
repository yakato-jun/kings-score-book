// マイク音声(Float32・AudioContext のレート)→ ストリーミングSTT 向け PCM16 LE への変換(純関数・ブラウザAPI非依存)。

/** 線形補間でリサンプリング(音声認識用途には十分な品質)。同レートはそのまま返す */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = x - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

/** Float32(-1..1) → 16bit 符号付き整数 LE のバイト列。範囲外はクリップ */
export function floatToPcm16(input: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(input.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** バイト列 → base64(ブラウザ/Node 共通。大きい配列でも引数上限を超えないよう分割) */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
