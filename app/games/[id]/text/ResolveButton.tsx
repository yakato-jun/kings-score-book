"use client";
import { useState } from "react";
import type { Half } from "@/lib/types/v2";
import { useDialog } from "@/components/DialogProvider";

/** 要確認を「承認(解決)」する。直さず意図どおりと認める＝特別ルール等。理由を共通ダイアログで入力→POST→再読込。 */
export function ResolveButton({ gameId, inning, half, order, rule }: { gameId: string; inning: number; half: Half; order: number; rule: string | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { promptText } = useDialog();

  async function run() {
    const reason = await promptText({
      title: "要確認を承認",
      body: "直さず意図どおりと認めます（特別ルール等）。理由（空欄可）:",
      defaultValue: "特別ルールで問題なし",
      confirmLabel: "承認",
    });
    if (reason === null) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/games/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, inning, half, order, reason, rule }),
      });
      const j = await res.json();
      if (!res.ok || j.error) { setErr(j.error ?? "失敗しました"); setBusy(false); return; }
      location.reload();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <>
      <button className="pbp-edit" onClick={run} disabled={busy}>{busy ? "…" : "承認"}</button>
      {err && <span className="muted">　{err}</span>}
    </>
  );
}
