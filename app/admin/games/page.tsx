import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { listGameMeta, importGameDoc, upsertGameMeta } from "@/lib/ops/games";

export const dynamic = "force-dynamic";

// 新規試合を作成 → そのままノート入力(AI集計)画面へ。日付から id(G+YYYYMMDD)を作る。
async function createGame(formData: FormData) {
  "use server";
  const date = String(formData.get("date") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日付を入力してください");
  const id = "G" + date.replace(/-/g, "");
  const ha = String(formData.get("home_away") ?? "");
  await upsertGameMeta({
    id,
    date,
    opponent: String(formData.get("opponent") ?? "").trim() || "未定",
    league: String(formData.get("league") ?? "").trim() || null,
    home_away: ha === "home" || ha === "away" ? ha : null,
    dh: false,
    result: null,
  });
  revalidatePath("/admin/games");
  redirect(`/admin/games/${id}/note`);
}

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

      <h2>新規試合を作成</h2>
      <p className="muted">日付と相手を入れて作成 → そのまま<b>ノート入力（AI集計）</b>へ進みます。相手・先後はノートからAIが補完するので未定でも構いません。</p>
      <form action={createGame} className="adminform">
        <label>日付<input type="date" name="date" required /></label>
        <label>対戦相手<input name="opponent" placeholder="未定可" /></label>
        <label>先後<select name="home_away" defaultValue="">
          <option value="away">先攻</option><option value="home">後攻</option><option value="">未定</option>
        </select></label>
        <label>区分（リーグ）<input name="league" placeholder="東葛Bリーグ 等" /></label>
        <div><button>作成してノート入力へ →</button></div>
      </form>

      <h2>試合一覧</h2>
      <p className="muted">Atlas が正本です。各試合の編集画面でメタ情報・出欠・ノート入力（AI集計）へ進めます。</p>
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
                <td><Link href={`/admin/games/${g.id}`}>編集</Link>　<Link href={`/admin/games/${g.id}/note`}>ノート入力</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>JSON取込（上級者向け / 丸ごと差し替え）</h2>
      <p className="muted">v2 試合doc を貼り付けて取り込みます（schema_version 2.0・game.id が G20260607 形式）。既存 id は上書き。</p>
      <form action={importAction} className="adminform">
        <textarea name="json" rows={10} placeholder='{ "schema_version": "2.0", "game": { ... }, ... }' required />
        <div><button>取り込む</button></div>
      </form>
    </div>
  );
}
