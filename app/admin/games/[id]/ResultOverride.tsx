"use client";
import { useState } from "react";

/**
 * 最終結果の「手入力で上書き」トグル。
 * 既定は導出(記録スコアから)に委ねる。チェックを入れた時だけ下のスコア/勝敗/決着入力が有効になり、
 * 外すと無効(グレーアウト)＝保存時 result=null で導出に戻す。無効な input は送信されないので、
 * saveMeta 側では override チェックの有無で「手入力 or 導出」を判定できる。
 */
const DECIDED: [string, string][] = [
  ["regulation", "通常"], ["time_limit", "時間切れ"], ["walkoff", "サヨナラ"],
  ["called", "コールド"], ["forfeit", "不戦"], ["tie", "引分"],
];
const OUTCOME: [string, string][] = [["win", "勝"], ["loss", "負"], ["tie", "分"]];

export function ResultOverride({
  defaultOverride,
  our,
  their,
  outcome,
  decidedBy,
  disabled,
}: {
  defaultOverride: boolean;
  our: number | "";
  their: number | "";
  outcome: string;
  decidedBy: string;
  disabled: boolean; // 下書き中(hasDraft)は丸ごと操作不可
}) {
  const [override, setOverride] = useState(defaultOverride);
  const off = disabled || !override;
  return (
    <fieldset>
      <legend>最終結果（通常は記録したスコアから導出。訂正/断片試合のみ手入力で上書き）</legend>
      <label style={{ display: "block", marginBottom: "0.4rem" }}>
        <input
          type="checkbox"
          name="override"
          checked={override}
          disabled={disabled}
          onChange={(e) => setOverride(e.target.checked)}
        />
        {" "}手入力で最終結果を上書きする
      </label>
      <div style={off ? { opacity: 0.5 } : undefined}>
        <label>自スコア<input type="number" name="our_score" defaultValue={our} min={0} disabled={off} /></label>
        <label>相手スコア<input type="number" name="their_score" defaultValue={their} min={0} disabled={off} /></label>
        <label>勝敗<select name="outcome" defaultValue={outcome} disabled={off}>
          {OUTCOME.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></label>
        <label>決着<select name="decided_by" defaultValue={decidedBy} disabled={off}>
          {DECIDED.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></label>
      </div>
    </fieldset>
  );
}
