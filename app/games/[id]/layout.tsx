import { GameViewTabs } from "./GameViewTabs";

export const dynamic = "force-dynamic";

/** 試合閲覧の共有レイアウト。ボックス/テキストをタブで並べ、子(各ビュー)を中身に出す。 */
export default async function GameViewLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div>
      <GameViewTabs id={id} />
      {children}
    </div>
  );
}
