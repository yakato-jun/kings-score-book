import Link from "next/link";
import { loadGames } from "@/lib/db/games";

export const dynamic = "force-dynamic";

const OUTCOME: Record<string, [string, string]> = {
  win: ["win", "○"],
  loss: ["loss", "●"],
  tie: ["tie", "△"],
};

export default async function GamesPage() {
  const games = (await loadGames()).sort((a, b) => b.game.date.localeCompare(a.game.date));
  return (
    <div>
      <h1>試合一覧</h1>
      <table>
        <thead>
          <tr><th>日付</th><th>対戦</th><th>区分</th><th>スコア</th><th>結果</th></tr>
        </thead>
        <tbody>
          {games.map((g) => {
            const r = g.game.result;
            const [cls, mark] = (r && OUTCOME[r.outcome]) ?? ["", ""];
            return (
              <tr key={g.game.id}>
                <td><Link href={`/games/${g.game.id}`}>{g.game.date}</Link></td>
                <td>{g.game.opponent}</td>
                <td className="muted">{g.game.league ?? ""}</td>
                <td>{r ? `${r.our_score} - ${r.their_score}` : "-"}</td>
                <td className={cls}>{mark}{r?.decided_by === "forfeit" ? "(不戦)" : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
