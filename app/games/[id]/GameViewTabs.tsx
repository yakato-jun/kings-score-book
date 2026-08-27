"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

/** 試合閲覧の共有タブ(ボックス/テキスト)。タブ切替で ?preview/?gen を引き継ぐ。activeは現在パスで判定。 */
export function GameViewTabs({ id }: { id: string }) {
  const path = usePathname();
  const sp = useSearchParams();
  const qs = sp.toString() ? `?${sp.toString()}` : "";
  const box = `/games/${id}`;
  const text = `/games/${id}/text`;
  return (
    <nav className="tabnav">
      <Link href={`${box}${qs}`} className={path === box ? "active" : ""}>ボックス</Link>
      <Link href={`${text}${qs}`} className={path === text ? "active" : ""}>テキスト</Link>
    </nav>
  );
}
