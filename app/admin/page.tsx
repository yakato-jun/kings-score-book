import Link from "next/link";

export const dynamic = "force-dynamic";

export default function AdminHome() {
  return (
    <div>
      <h1>管理</h1>
      <ul className="adminnav">
        <li><Link href="/admin/players">選手マスタ</Link> — 選手の追加・編集</li>
        <li><Link href="/admin/games">試合管理</Link> — メタ情報・出欠・JSON取込</li>
        <li><Link href="/admin/chat">AI入力</Link> — チャットで提案→適用(下書き)→確定</li>
      </ul>
      <p className="muted">
        ※ 現在ログイン無し・無制限です。将来この管理機能をユーザー認証（LINE申請式・簡易ロール）でゲートする想定です。
      </p>
    </div>
  );
}
