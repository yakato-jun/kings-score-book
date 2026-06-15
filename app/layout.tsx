import type { Metadata } from "next";

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
      <body>{children}</body>
    </html>
  );
}
