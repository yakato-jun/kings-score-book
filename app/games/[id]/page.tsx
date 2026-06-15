import { notFound } from "next/navigation";
import { loadGame } from "@/lib/db/games";
import { loadPlayers } from "@/lib/db/players";
import { aggregateGame } from "@/lib/agg";
import { ipStr, era } from "@/lib/agg/types";

export const dynamic = "force-dynamic";

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await loadGame(id);
  if (!doc) notFound();
  const players = await loadPlayers();
  const box = aggregateGame(doc);
  const name = (pid: string) => players.get(pid) ?? pid;
  const g = doc.game;
  const r = g.result;

  return (
    <div>
      <h1>{g.date}　vs {g.opponent}</h1>
      <p className="muted">
        {g.league ?? ""}　{r ? `${r.our_score} - ${r.their_score}（${{ win: "勝", loss: "負", tie: "分" }[r.outcome]}${r.decided_by === "forfeit" ? "・不戦" : ""}）` : ""}
      </p>

      {box.batting.length > 0 && (
        <>
          <h2>打撃</h2>
          <table>
            <thead>
              <tr><th>選手</th><th>打席</th><th>打数</th><th>安打</th><th>二</th><th>三</th><th>本</th><th>打点</th><th>得点</th><th>四球</th><th>三振</th><th>盗塁</th></tr>
            </thead>
            <tbody>
              {box.batting.map((b) => (
                <tr key={b.player_id}>
                  <td>{name(b.player_id)}</td><td>{b.pa}</td><td>{b.ab}</td><td>{b.h}</td>
                  <td>{b.b2}</td><td>{b.b3}</td><td>{b.hr}</td><td>{b.rbi}</td><td>{b.r}</td><td>{b.bb}</td><td>{b.k}</td><td>{b.sb}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {box.pitching.length > 0 && (
        <>
          <h2>投手</h2>
          <table>
            <thead>
              <tr><th>選手</th><th>投球回</th><th>対打者</th><th>被安打</th><th>奪三振</th><th>与四球</th><th>与死球</th><th>失点</th><th>自責</th><th>防御率</th></tr>
            </thead>
            <tbody>
              {box.pitching.map((p) => (
                <tr key={p.player_id}>
                  <td>{name(p.player_id)}</td><td>{ipStr(p.outs)}</td><td>{p.bf}</td><td>{p.h}</td>
                  <td>{p.k}</td><td>{p.bb}</td><td>{p.hbp}</td><td>{p.r}</td><td>{p.er}</td><td>{era(p).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {box.fielding.length > 0 && (
        <>
          <h2>守備</h2>
          <table>
            <thead><tr><th>選手</th><th>刺殺</th><th>捕殺</th><th>失策</th><th>守備機会</th></tr></thead>
            <tbody>
              {box.fielding.map((f) => (
                <tr key={f.player_id}>
                  <td>{name(f.player_id)}</td><td>{f.po}</td><td>{f.a}</td><td>{f.e}</td><td>{f.tc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {box.batting.length === 0 && (
        <p className="muted">この試合はプレー記録がありません（不戦勝など）。</p>
      )}
    </div>
  );
}
