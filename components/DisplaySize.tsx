"use client";
import { useEffect, useState } from "react";

// 表示倍率。中=等倍(既定)。極小環境向けに小で縮小、大で拡大。値は調整可。
const SIZES: [string, string][] = [
  ["小", "0.6"],
  ["中", "1"],
  ["大", "1.3"],
];

export function DisplaySize() {
  const [scale, setScale] = useState("1");

  useEffect(() => {
    const s = localStorage.getItem("ui-scale") ?? "1";
    setScale(s);
    document.documentElement.style.setProperty("--ui-scale", s);
  }, []);

  const pick = (s: string) => {
    setScale(s);
    localStorage.setItem("ui-scale", s);
    document.documentElement.style.setProperty("--ui-scale", s);
  };

  return (
    <span className="uiscale" aria-label="表示サイズ">
      {SIZES.map(([label, val]) => (
        <button key={val} onClick={() => pick(val)} className={scale === val ? "active" : ""} title={`表示サイズ ${label}`}>
          {label}
        </button>
      ))}
    </span>
  );
}
