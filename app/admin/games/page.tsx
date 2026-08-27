import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { upsertGameMeta, newGameId } from "@/lib/ops/games";
import { pendingDraftGameIds, loadGames } from "@/lib/db/games";
import { displayResult } from "@/lib/agg";

export const dynamic = "force-dynamic";

// 新規試合を作成 → そのままノート入力(AI集計)画面へ。id は不透明な短い16進ランダム(衝突チェック付き)を採番する。
async function createGame(formData: FormData) {
  "use server";
  const date = String(formData.get("date") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日付を入力してください");
  const id = await newGameId();
  const ha = String(formData.get("home_away") ?? "");
  await upsertGameMeta({
    id,
    date,
    opponent: String(formData.get("opponent") ?? "").trim() || "未定",
    league: String(formData.get("league") ?? "").trim() || null,
    home_away: ha === "home" || ha === "away" ? ha : null,
    result: null,
  });
  revalidatePath("/admin/games");
  redirect(`/admin/games/${id}/note`);
}

const HA: Record<string, string> = { home: "後攻", away: "先攻", "": "—" };

export default async function GamesAdmin() {
  // 結果列は displayResult(記録スコアからの導出／手入力上書き)で出すため、メタだけでなく doc 全体を読む。
  const [docs, pending] = await Promise.all([loadGames(), pendingDraftGameIds()]);
  const games = [...docs].sort((a, b) => b.game.date.localeCompare(a.game.date));

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
      <p className="muted">Atlas が正本です。各試合の編集画面で試合情報・出欠・AI入力・スコア入力へ進めます。</p>
      <div className="scrollx">
        <table className="frz1">
          <thead>
            <tr><th className="tl">日付</th><th className="tl">相手</th><th className="tl">区分</th><th>キングス</th><th>結果</th><th></th></tr>
          </thead>
          <tbody>
            {games.map((doc) => {
              const g = doc.game;
              const dr = displayResult(doc);
              return (
                <tr key={g.id}>
                  <td className="tl">{g.date}</td>
                  <td className="tl">{g.opponent}{pending.has(g.id) && <span className="draftchip" title="未確定の集計結果があります（未公開）">未確定</span>}</td>
                  <td className="tl muted">{g.league ?? ""}</td>
                  <td>{HA[g.home_away ?? ""]}</td>
                  <td>{dr ? `${dr.our} - ${dr.their}` : "—"}</td>
                  <td><Link href={`/admin/games/${g.id}`}>編集</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
}
