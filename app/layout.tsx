import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

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
    <html lang="ja">
      <body>
        <nav>
          <Link href="/">N-KINGS</Link>
          <Link href="/season">シーズン成績</Link>
          <Link href="/games">試合一覧</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
