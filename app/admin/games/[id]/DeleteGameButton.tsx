"use client";
import { useState } from "react";
import { useDialog } from "@/components/DialogProvider";

/** 試合まるごと削除(危険操作)。確認ダイアログ→POST→管理一覧へ。版履歴・下書き・ノートも全て消える。 */
export function DeleteGameButton({ gameId, date, opponent }: { gameId: string; date: string; opponent: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { confirm } = useDialog();

  async function run() {
    const ok = await confirm({
      title: "試合を完全に削除",
      body: `${date} vs ${opponent} を完全に削除します。版履歴・未確定の集計結果・入力ノートもすべて消え、元に戻せません（復元はバックアップからのみ）。`,
      confirmLabel: "完全に削除",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/games/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const j = await res.json();
      if (!res.ok || j.error) {
        setErr(j.error ?? "失敗しました");
        setBusy(false);
        return;
      }
      location.href = "/admin"; // 消えた試合の画面には留まらない
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn-danger" onClick={run} disabled={busy}>{busy ? "削除中…" : "この試合を完全に削除"}</button>
      {err && <span className="loss">　{err}</span>}
    </>
  );
}
