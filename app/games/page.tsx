import Link from "next/link";
import { loadGames } from "@/lib/db/games";
import { listSeasons, resolveSeason, seasonOf } from "@/lib/season";
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
      <table>
        <thead>
          <tr>
            <th>日付</th><th>区分</th>
            <th colSpan={5}>対戦</th>
            <th>結果</th>
          </tr>
        </thead>
        <tbody>
          {games.map((g) => {
            const r = g.game.result;
            const [oCls, mark] = (r && OUTCOME[r.outcome]) ?? ["", ""];
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
                <td className="muted">{g.game.league ?? ""}</td>
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
      </table>
    </div>
  );
}
