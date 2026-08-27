import Link from "next/link";
import { loadGames } from "@/lib/db/games";
import { listSeasons, resolveSeason, seasonOf } from "@/lib/season";
import { deriveTeamTotals } from "@/lib/ops/validate";
import { SeasonNav } from "@/components/SeasonNav";

export const dynamic = "force-dynamic";

const OUTCOME: Record<string, [string, string]> = {
  win: ["win", "○"],
  loss: ["loss", "●"],
  tie: ["tie", "△"],
};

export default async function GamesPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season } = await searchParams;
  const all = await loadGames();
  const seasons = listSeasons(all.map((g) => g.game.date));
  const current = resolveSeason(seasons, season);
  const games = all
    .filter((g) => seasonOf(g.game.date) === current)
    .sort((a, b) => b.game.date.localeCompare(a.game.date));

  return (
    <div>
      <h1>試合一覧</h1>
      <SeasonNav seasons={seasons} current={current} basePath="/games" />
      <p className="muted">対戦は「先攻 - 後攻」（左が先攻・右が後攻）。キングスを太字表示。</p>
      <div className="scrollx"><table className="frz1 gamelist">
        <thead>
          <tr>
            <th>日付</th><th className="colleague">区分</th>
            <th colSpan={5}>対戦</th>
            <th>結果</th>
          </tr>
        </thead>
        <tbody>
          {games.map((g) => {
            // 申告スコア(game.result)が正。無い試合は記録から導出した総得点で表示する(得点の導出はサーバの仕事。
            // ノートに最終スコアの明記が無いとAIは result を設定しない=規約どおりなので、表示側が導出で補う)。
            // 打席ゼロの試合は導出も不能なので従来どおり空欄。
            const declared = g.game.result;
            const totals = !declared && g.plate_appearances.length > 0 ? deriveTeamTotals(g) : null;
            const r = declared ?? (totals
              ? { our_score: totals.own, their_score: totals.opp, outcome: totals.own > totals.opp ? "win" : totals.own < totals.opp ? "loss" : "tie", decided_by: null }
              : null);
            const [oCls, mark] = (r && OUTCOME[r.outcome ?? ""]) ?? ["", ""];
            const kingsLeft = g.game.home_away !== "home";
            const left = {
              kings: kingsLeft,
              name: kingsLeft ? "キングス" : g.game.opponent,
              score: r ? (kingsLeft ? r.our_score : r.their_score) : null,
            };
            const right = {
              kings: !kingsLeft,
              name: kingsLeft ? g.game.opponent : "キングス",
              score: r ? (kingsLeft ? r.their_score : r.our_score) : null,
            };
            const win = r?.outcome === "win";
            const scoreCls = (side: { kings: boolean }) => (side.kings && win ? "win" : "");
            const teamName = (side: { kings: boolean; name: string }) =>
              side.kings ? <b>{side.name}</b> : side.name;
            return (
              <tr key={g.game.id}>
                <td><Link href={`/games/${g.game.id}`}>{g.game.date}</Link></td>
                <td className="muted colleague">{g.game.league ?? ""}</td>
                <td className="teamL mtL">{teamName(left)}</td>
                <td className="sc mtM"><span className={scoreCls(left)}>{left.score ?? "-"}</span></td>
                <td className="dash mtM">-</td>
                <td className="sc teamR mtM"><span className={scoreCls(right)}>{right.score ?? "-"}</span></td>
                <td className="teamR mtR">{teamName(right)}</td>
                <td className={oCls}>{mark}{r?.decided_by === "forfeit" ? <span className="muted">不戦</span> : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </div>
  );
}
