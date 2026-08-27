"use client";
import { useState } from "react";
import { draftBlockMsg } from "@/lib/draft-msg";
import { useDialog } from "@/components/DialogProvider";

/** 過去版へロールバック(確認→POST→再読込)。disabled は下書きがある時に上位から渡す(軸1=予防)。 */
export function RollbackButton({ gameId, gen, disabled }: { gameId: string; gen: number; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { confirm } = useDialog();

  async function run() {
    if (!(await confirm({ title: "この版へ戻す", body: `gen ${gen} の内容へ戻します（新しい版として積まれ、公開版になります）。`, confirmLabel: "戻す" }))) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/games/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, gen }),
      });
      const j = await res.json();
      if (!res.ok || j.error) {
        setErr(j.error ?? "失敗しました"); // 軸2: route が draftRaceMsg を返す
        setBusy(false);
        return;
      }
      location.reload();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <button className="db-act" onClick={run} disabled={disabled || busy} title={disabled ? draftBlockMsg("ロールバック") : undefined}>{busy ? "戻し中…" : "この版へ戻す"}</button>
      {err && <span className="muted">　{err}　<button className="db-act" onClick={() => location.reload()}>再読み込み</button></span>}
    </>
  );
}
