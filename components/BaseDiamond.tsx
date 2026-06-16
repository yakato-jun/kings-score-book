/**
 * 走者状況(左のダイヤ)とアウトカウント(右のドット)のミニ図。
 * 静的アセットではなく runners/outs から都度描く(8塁状態×3アウト=24通りを1コンポーネントで網羅)。
 * 走者=オレンジ / アウト=赤。
 */
const RUNNER = "#f97316"; // 走者(占有)
const OUT = "#dc2626"; // アウト
const OFF = "#fff"; // 空
const EDGE = "#6b7280";
const LINE = "#d1d5db";

function Base({ cx, cy, on }: { cx: number; cy: number; on: boolean }) {
  const s = 7;
  return (
    <rect
      x={cx - s / 2}
      y={cy - s / 2}
      width={s}
      height={s}
      transform={`rotate(45 ${cx} ${cy})`}
      fill={on ? RUNNER : OFF}
      stroke={EDGE}
      strokeWidth={1}
    />
  );
}

export function BaseDiamond({
  first,
  second,
  third,
  outs,
  label,
}: {
  first: boolean;
  second: boolean;
  third: boolean;
  outs: number;
  label?: string;
}) {
  // 左: 走者ダイヤ(本塁=下・一塁=右・二塁=上・三塁=左) / 右: アウトカウント(横2点)
  const H = [18, 29], B1 = [31, 17], B2 = [18, 5], B3 = [5, 17];
  return (
    <svg className="diamond" width={44} height={26} viewBox="0 0 66 40" role="img" aria-label={label ?? `${outs}アウト`}>
      <polygon
        points={`${H[0]},${H[1]} ${B1[0]},${B1[1]} ${B2[0]},${B2[1]} ${B3[0]},${B3[1]}`}
        fill="none"
        stroke={LINE}
        strokeWidth={1.5}
      />
      <Base cx={B1[0]} cy={B1[1]} on={first} />
      <Base cx={B2[0]} cy={B2[1]} on={second} />
      <Base cx={B3[0]} cy={B3[1]} on={third} />
      {[0, 1].map((i) => (
        <circle key={i} cx={48 + i * 12} cy={17} r={5} fill={outs > i ? OUT : OFF} stroke={EDGE} strokeWidth={1} />
      ))}
    </svg>
  );
}
