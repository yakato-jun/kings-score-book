"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { draftBlockMsg } from "@/lib/draft-msg";
import { useDialog } from "@/components/DialogProvider";

/**
 * 版の取り消し(revert): その版が加えた変更だけを取り消し、AIが下書きを作る。
 * 確認→POST→成功したらプレビューへ誘導(下書きを人がレビューして公開)。disabled は下書きがある時(軸1=予防)。
 */
export function RevertButton({ gameId, gen, disabled }: { gameId: string; gen: number; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const { confirm } = useDialog();

  async function run() {
    if (!(await confirm({ title: "この版を取り消す", body: `gen ${gen} が加えた変更だけを取り消します（それ以降の変更は保持）。AIが未確定の集計結果を作るので、プレビューで確認してから公開してください。`, confirmLabel: "取り消す" }))) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/games/revert", {
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
      if (!j.applied) {
        // 反映op0=取り消す変化点を特定できず(下書きは作られない)
        setErr(j.clarification ?? "取り消す変化点を特定できませんでした。");
        setBusy(false);
        return;
      }
      router.push(`/games/${gameId}/text?preview=1`); // 出来た下書きをレビュー
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn-danger" onClick={run} disabled={disabled || busy} title={disabled ? draftBlockMsg("取り消し") : undefined}>{busy ? "取消中…" : "この版を取り消す"}</button>
      {err && <span className="muted">　{err}　<button className="db-act" onClick={() => location.reload()}>再読み込み</button></span>}
    </>
  );
}
