"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useDialog } from "@/components/DialogProvider";
import { confirmLeaveIfDirty } from "@/lib/unsaved-guard";

/**
 * 編集ハブの共有タブ。AI編集(ノート)と直接編集(メタ/出欠)と版履歴を並列に。activeは現在パスで判定。
 * 未保存の編集(出欠移動など)がある状態でタブを離れると破棄確認を挟む(共有レジストリを参照)。
 * 通常の左クリックのみ横取りし、修飾/中クリック(新規タブで開く等)は素通りさせる。
 */
export function GameTabs({ id }: { id: string }) {
  const path = usePathname();
  const router = useRouter();
  const { confirm } = useDialog();
  const base = `/admin/games/${id}`;
  const tabs = [
    { href: base, label: "出欠" },
    { href: `${base}/note`, label: "AI入力" },
    { href: `${base}/score`, label: "スコア入力" },
    { href: `${base}/history`, label: "版管理" },
  ];

  async function onNav(e: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (href === path) return; // 現在タブは素通り
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // 新規タブ等は横取りしない
    e.preventDefault();
    if (await confirmLeaveIfDirty(confirm)) router.push(href);
  }

  return (
    <nav className="tabnav">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={path === t.href ? "active" : ""}
          onClick={(e) => onNav(e, t.href)}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
