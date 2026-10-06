// 守備位置表記の正規化(純関数)。正本は番号 "1".."9"(lineup_snapshots の position_id と同じ)。
// AI や手入力は漢字(三)・語(三塁/ショート)・連結("三-一")で書くことがあり、そのままでは守備位置→選手の解決に失敗する
// (失策・刺殺・捕殺の取りこぼし)。集計時と取り込み時の両方でここを通す。

const POS_WORDS: Record<string, string> = {
  投: "1", 投手: "1", ピッチャー: "1", P: "1",
  捕: "2", 捕手: "2", キャッチャー: "2", C: "2",
  一: "3", 一塁: "3", 一塁手: "3", ファースト: "3", "1B": "3",
  二: "4", 二塁: "4", 二塁手: "4", セカンド: "4", "2B": "4",
  三: "5", 三塁: "5", 三塁手: "5", サード: "5", "3B": "5",
  遊: "6", 遊撃: "6", 遊撃手: "6", ショート: "6", SS: "6",
  左: "7", 左翼: "7", 左翼手: "7", レフト: "7", LF: "7",
  中: "8", 中堅: "8", 中堅手: "8", センター: "8", CF: "8",
  右: "9", 右翼: "9", 右翼手: "9", ライト: "9", RF: "9",
};

/** 1つの守備位置表記 → "1".."9"。解釈できなければ null */
export function normPos(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toUpperCase();
  if (/^[1-9]$/.test(s)) return s;
  return POS_WORDS[s] ?? null;
}

/**
 * 送球順も守備アウトも記録されていない「内野ゴロの打者アウト」の標準的な送球順を補う(集計の救済)。
 * 遊ゴロ等=打球処理野手→一塁(捕殺+一塁刺殺)。一ゴロ=一塁手が自ら踏む(刺殺のみ)。
 * ゴロ以外・外野・野選等は推測しない(null)= 呼び出し側は従来どおり hit_to に刺殺を付ける。
 */
export function inferGroundOutSeq(result: string | null | undefined, hitType: string | null | undefined, hitTo: string | null): string[] | null {
  if (hitType !== "G" || (result !== "OUT" && result !== "SH") || !hitTo) return null;
  if (hitTo === "3") return ["3"];
  return ["1", "2", "4", "5", "6"].includes(hitTo) ? [hitTo, "3"] : null;
}

type OutRecord = { putout_position?: string | null; assist_positions?: string[]; at?: string | null; type?: string };

/**
 * 守備アウトごとの刺殺・捕殺の付け先(守備位置番号)。seq は normPosSeq 済みの送球順。
 * - putout_position / assist_positions が明示されていればそれを使う。
 * - 複数アウトで明示が無く、送球順の長さが「アウト数+1」なら前から順に割り当てる(6-4-3 → [4刺殺/6捕殺],[3刺殺/4捕殺])。
 * - それ以外は従来どおり 刺殺=送球順の最後・捕殺=それ以外。
 * - 送球順が無い捕球アウト(catch)は at を捕球した野手の守備位置とみなす(捕球に塁は無い)。
 */
export function outCredits(outs: readonly OutRecord[], seq: readonly string[]): { putout: string | null; assists: string[] }[] {
  const chain = outs.length >= 2 && seq.length === outs.length + 1 && outs.every((o) => !normPos(o.putout_position) && !o.assist_positions);
  return outs.map((o, i) => {
    if (chain) return { putout: seq[i + 1], assists: [seq[i]] };
    const putout = normPos(o.putout_position) ?? (seq.length ? seq[seq.length - 1] : o.type === "catch" ? normPos(o.at) : null);
    const assists = o.assist_positions ? normPosSeq(o.assist_positions) : [...new Set(seq.slice(0, -1))].filter((p) => p !== putout);
    return { putout, assists };
  });
}

/** 送球順(sequence)の正規化: 各要素を番号へ。連結表記("三-一" "6-4-3")は分割。解釈できない要素(文章など)は捨てる */
export function normPosSeq(seq: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const item of seq ?? []) {
    const whole = normPos(item);
    if (whole) { out.push(whole); continue; }
    for (const tok of String(item).split(/[-ー−‐→>,、・\s]+/)) {
      const p = normPos(tok);
      if (p) out.push(p);
    }
  }
  return out;
}
