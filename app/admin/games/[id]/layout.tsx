import { notFound } from "next/navigation";
import Link from "next/link";
import { loadGame } from "@/lib/db/games";
import { GameTabs } from "./GameTabs";

export const dynamic = "force-dynamic";

/** 試合の編集ハブ。共有タブ(メタ・出欠 / ノート / 版履歴)＋ビューへのプレビュー導線を被せ、子(各タブ)を中身に出す。 */
export default async function GameAdminLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await loadGame(id);
  if (!doc) notFound();
  const g = doc.game;
  return (
    <div>
      <p className="muted" style={{ margin: "0 0 0.4rem" }}>
        <Link href="/admin/games">← 試合管理</Link>
      </p>
      <h1>{g.date}　{g.opponent}<span className="muted" style={{ fontSize: "0.62em", marginLeft: "0.5rem", fontWeight: 400 }}>編集</span></h1>
      <div className="pvbar">
        <span className="pvbar-label">プレビュー（公開ビュー）</span>
        <Link href={`/games/${id}?preview=1`} className="pvbar-btn">ボックス</Link>
        <Link href={`/games/${id}/text?preview=1`} className="pvbar-btn">テキスト</Link>
      </div>
      <GameTabs id={id} />
      {children}
    </div>
  );
}
