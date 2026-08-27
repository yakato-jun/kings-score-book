import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { DisplaySize } from "@/components/DisplaySize";
import { DialogProvider } from "@/components/DialogProvider";

// 保存済みの表示倍率を描画前に適用(チラつき防止)
const applyScale = `(function(){try{var s=localStorage.getItem('ui-scale');if(s)document.documentElement.style.setProperty('--ui-scale',s);}catch(e){}})()`;

export const metadata: Metadata = {
  title: "N-KINGS スコアブック",
  description: "草野球チーム N-KINGS の成績集計",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: applyScale }} />
      </head>
      <body>
        <nav>
          <Link href="/">N-KINGS</Link>
          <Link href="/season">シーズン成績</Link>
          <Link href="/games">試合一覧</Link>
          <Link href="/admin">管理</Link>
          <DisplaySize />
        </nav>
        <main><DialogProvider>{children}</DialogProvider></main>
      </body>
    </html>
  );
}
