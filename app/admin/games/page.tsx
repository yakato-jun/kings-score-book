import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { listGameMeta, importGameDoc } from "@/lib/ops/games";

export const dynamic = "force-dynamic";

async function importAction(formData: FormData) {
  "use server";
  const id = await importGameDoc(String(formData.get("json") ?? ""));
  revalidatePath("/admin/games");
  redirect(`/admin/games/${id}`);
}

const HA: Record<string, string> = { home: "後攻", away: "先攻", "": "—" };

export default async function GamesAdmin() {
  const games = await listGameMeta();

  return (
    <div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        <Link href="/admin">← 管理</Link>
      </p>
      <h1>試合管理</h1>
      <p className="muted">Atlas が正本です。メタ情報・出欠は各試合の編集画面で。詳細な打席は下の JSON 取込で丸ごと差し替えます。</p>

      <div className="scrollx">
        <table className="frz1">
          <thead>
            <tr><th className="tl">日付</th><th className="tl">相手</th><th className="tl">区分</th><th>キングス</th><th>結果</th><th></th></tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.id}>
                <td className="tl">{g.date}</td>
                <td className="tl">{g.opponent}</td>
                <td className="tl muted">{g.league ?? ""}</td>
                <td>{HA[g.home_away ?? ""]}</td>
                <td>{g.result ? `${g.result.our_score} - ${g.result.their_score}` : "—"}</td>
                <td><Link href={`/admin/games/${g.id}`}>編集</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>JSON取込（新規 / 丸ごと差し替え）</h2>
      <p className="muted">v2 試合doc を貼り付けて取り込みます（schema_version 2.0・game.id が G20260607 形式）。既存 id は上書き。</p>
      <form action={importAction} className="adminform">
        <textarea name="json" rows={10} placeholder='{ "schema_version": "2.0", "game": { ... }, ... }' required />
        <div><button>取り込む</button></div>
      </form>
    </div>
  );
}
