import Link from "next/link";

export default function Home() {
  return (
    <div>
      <h1>N-KINGS スコアブック</h1>
      <p className="muted">草野球チーム N-KINGS の成績集計（Phase1: 読み取り専用表示）</p>
      <ul>
        <li>
          <Link href="/season">シーズン成績</Link> — 選手別の打撃・投手・守備・出欠
        </li>
        <li>
          <Link href="/games">試合一覧</Link> — 各試合のボックススコア
        </li>
      </ul>
    </div>
  );
}
