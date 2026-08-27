"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDialog } from "@/components/DialogProvider";

/**
 * 下書きプレビュー(未公開)時にだけプレビュー画面の上部へ出す「確定バー」。
 * 確定/破棄の導線はここ(＝出来上がりを見ている画面)に集約する。
 *  - 確定(公開): POST /api/games/publish → 公開ビューへ遷移(確定結果を見せる)
 *  - 破棄してやり直す: confirm → POST /api/games/discard → AI入力へ戻る(ノートは残る)
 *  - AI入力に戻る: /admin/games/{id}/note へ(ノートを直して再集計)
 * 非破壊: publish/discard の既存API・楽観ロック・下書きモデルはそのまま呼ぶ。内部コード(gen等)は出さない。
 */
export function DraftConfirmBar({ id, flagsCount = 0 }: { id: string; flagsCount?: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  const { confirm } = useDialog();

  async function publish() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/games/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId: id }) }).then((x) => x.json());
      if (r.error) { setErr("確定に失敗しました: " + r.error); setBusy(false); return; }
      router.push(`/games/${id}`); // 確定した公開ビューを見せる
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  async function discard() {
    if (!(await confirm({ title: "未確定の集計結果を破棄", body: "入力したノートは残ります（直して再集計できます）。", confirmLabel: "破棄", danger: true }))) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/games/discard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId: id }) }).then((x) => x.json());
      if (r.error) { setErr("破棄に失敗しました: " + r.error); setBusy(false); return; }
      router.push(`/admin/games/${id}/note`); // ノートに戻ってやり直す
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <div className="confirmbar">
      <span className="cb-label">この未確定の集計結果はまだ公開されていません。内容を確認して確定してください。</span>
      {flagsCount > 0 && <span className="cb-flags">要確認 {flagsCount}件（下の ⚠ を確認）</span>}
      <div className="cb-acts">
        <button className="cb-ok" onClick={publish} disabled={busy}>この内容で確定（公開）</button>
        <button className="cb-danger" onClick={discard} disabled={busy}>破棄してやり直す</button>
        <Link className="cb-back" href={`/admin/games/${id}/note`}>AI入力に戻る</Link>
      </div>
      {err && <span className="cb-err">{err}</span>}
    </div>
  );
}
