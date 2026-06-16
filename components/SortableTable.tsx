"use client";
import { useEffect, useState } from "react";

export type Column = {
  key: string;
  label: string;
  left?: boolean; // 左寄せ(選手名など)
  format?: "rate3" | "fixed2" | "ip"; // 数値の表示整形
};

const FMT: Record<NonNullable<Column["format"]>, (v: number) => string> = {
  rate3: (v) => v.toFixed(3).replace(/^0(?=\.)/, ""),
  fixed2: (v) => v.toFixed(2),
  ip: (v) => `${Math.floor(v / 3)}.${v % 3}`, // outs → "5.2"
};

export type Row = Record<string, number | string>;

export function SortableTable({
  columns,
  rows,
  initialKey,
  initialDir = -1,
  storageKey,
}: {
  columns: Column[];
  rows: Row[];
  initialKey?: string;
  initialDir?: 1 | -1;
  storageKey?: string; // 指定すると並べ替え状態を localStorage に保存・復元
}) {
  const [key, setKey] = useState(initialKey ?? columns[0].key);
  const [dir, setDir] = useState<1 | -1>(initialDir);

  // 保存済みの並べ替えを復元(ハイドレーション後)
  useEffect(() => {
    if (!storageKey) return;
    try {
      const s = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (s && columns.some((c) => c.key === s.k) && (s.d === 1 || s.d === -1)) {
        setKey(s.k);
        setDir(s.d);
      }
    } catch {}
  }, [storageKey, columns]);

  const apply = (k: string, d: 1 | -1) => {
    setKey(k);
    setDir(d);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ k, d }));
      } catch {}
    }
  };

  const sorted = [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv), "ja") * dir;
  });

  const onClick = (k: string) => {
    if (k === key) apply(k, dir === 1 ? -1 : 1);
    else apply(k, -1);
  };

  return (
    <div className="scrollx">
    <table className="frz1">
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              onClick={() => onClick(c.key)}
              style={{ cursor: "pointer", textAlign: c.left ? "left" : "right", userSelect: "none" }}
              title="クリックで並べ替え"
            >
              {c.label}
              {key === c.key ? (dir === 1 ? " ▲" : " ▼") : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r, i) => (
          <tr key={i}>
            {columns.map((c) => {
              const v = r[c.key];
              const text = c.format && typeof v === "number" ? FMT[c.format](v) : v;
              return (
                <td key={c.key} style={{ textAlign: c.left ? "left" : "right" }}>
                  {text}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
