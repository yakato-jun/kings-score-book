"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/components/DialogProvider";

/**
 * [§12 P3] 選手編集画面の「この選手を別の選手に名寄せ(統合)」操作(専用ページは作らない＝助っ人は"機能"でなく種別フラグ)。
 * 統合先を名前で選び(内部コードは見せない)、確認ダイアログ→/api/players/merge で from(この選手)→to へ全出場を付け替える。
 * 非破壊(版管理append)。付け替え先が既に参加している試合はサーバ側で skip される(結果件数を表示)。
 * mergePlayer は全出場を付け替え切ると from(この選手)マスタを削除するため、成功後は一覧へ戻る(この選手ページは消える)。
 * skip が残った場合は from マスタが残る＝この画面に留まり結果を表示(スキップ分は個別に確認)。
 */
export function MergePlayerControl({
  player,
  targets,
}: {
  player: { id: string; name: string };
  targets: { id: string; name: string }[];
}) {
  const { confirm } = useDialog();
  const router = useRouter();
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    if (!to) return;
    const target = targets.find((t) => t.id === to);
    const ok = await confirm({
      title: "選手を名寄せ",
      body: `「${player.name}」の全出場を「${target?.name ?? ""}」に付け替えます(過去試合の参加記録を統合先へ移動)。付け替え先が既に参加している試合はそのまま残します。`,
      confirmLabel: "名寄せする",
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/players/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: player.id, to }),
      });
      const j = await res.json();
      if (!res.ok || j.error) {
        setMsg(j.error ?? "失敗しました");
        setBusy(false);
        return;
      }
      const updated = (j.updatedGames ?? []).length;
      const skipped = (j.skipped ?? []).length;
      if (skipped) {
        // skip 有り＝この選手はまだ参照が残り(マスタも削除されない)、この画面は消えないので留まって結果を表示。
        setMsg(`${updated}試合を付け替えました（${skipped}試合はスキップ）。スキップ分は個別に確認してください。`);
        setTo("");
        setBusy(false);
        router.refresh();
        return;
      }
      // 全付け替え成功＝この選手マスタは削除され、この編集画面は消えるため一覧へ戻る。
      router.push("/admin/players");
    } catch (e) {
      setMsg((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <span className="mergectl">
      <select aria-label="名寄せ先" value={to} onChange={(e) => setTo(e.target.value)} disabled={busy}>
        <option value="">統合先の選手を選ぶ…</option>
        {targets.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <button type="button" className="mergebtn" onClick={run} disabled={busy || !to}>
        {busy ? "処理中…" : "名寄せする"}
      </button>
      {msg && <span className="muted">　{msg}</span>}
    </span>
  );
}
