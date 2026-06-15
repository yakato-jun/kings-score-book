import Link from "next/link";
import { loadGames } from "@/lib/db/games";

export const dynamic = "force-dynamic";

const OUTCOME: Record<string, [string, string]> = {
  win: ["win", "○"],
  loss: ["loss", "●"],
  tie: ["tie", "△"],
};

// 先攻(away)=キングスが先に攻撃 / 後攻(home)
function battingOrder(ha: "home" | "away" | null): [string, string] {
  if (ha === "away") return ["first", "先攻"];
  if (ha === "home") return ["last", "後攻"];
  return ["none", "—"];
}

export default async function GamesPage() {
  const games = (await loadGames()).sort((a, b) => b.game.date.localeCompare(a.game.date));
  return (
    <div>
      <h1>試合一覧</h1>
      <table>
        <thead>
          <tr><th>日付</th><th>区分</th><th>先後</th><th className="l">対戦</th><th>結果</th></tr>
        </thead>
        <tbody>
          {games.map((g) => {
            const r = g.game.result;
            const [oCls, mark] = (r && OUTCOME[r.outcome]) ?? ["", ""];
            const [bCls, bLabel] = battingOrder(g.game.home_away);
            const ourWin = r?.outcome === "win";
            return (
              <tr key={g.game.id}>
                <td><Link href={`/games/${g.game.id}`}>{g.game.date}</Link></td>
                <td className="muted">{g.game.league ?? ""}</td>
                <td><span className={`badge ${bCls}`}>{bLabel}</span></td>
                <td className="score">
                  キングス{" "}
                  {r ? (
                    <>
                      <b className={ourWin ? "win" : ""}>{r.our_score}</b> - <b>{r.their_score}</b>
                    </>
                  ) : "- - -"}{" "}
                  {g.game.opponent}
                  {r?.decided_by === "forfeit" ? <span className="muted">（不戦）</span> : null}
                </td>
                <td className={oCls}>{mark}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
