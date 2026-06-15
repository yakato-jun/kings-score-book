import { loadGames } from "@/lib/db/games";
import { loadPlayers } from "@/lib/db/players";
import { aggregateSeason } from "@/lib/agg";
import { avg, obp, slg, ops, era, fpct, ipStr, rate3 } from "@/lib/agg/types";

// Atlas を実行時に読むため動的レンダリング（ビルド時にDB接続しない）
export const dynamic = "force-dynamic";

const SEASON = "2026";

export default async function SeasonPage() {
  const allGames = await loadGames();
  const games = allGames.filter((g) => g.game.date.startsWith(SEASON));
  const players = await loadPlayers();
  const s = aggregateSeason(games);
  const name = (id: string) => players.get(id) ?? id;

  const batting = [...s.batting].filter((b) => b.scope === "own").sort((a, b) => b.pa - a.pa);
  const pitching = [...s.pitching].sort((a, b) => b.outs - a.outs);
  const fielding = [...s.fielding].sort((a, b) => b.tc - a.tc);
  const attendance = [...s.attendance].filter((a) => a.scope === "own").sort((a, b) => b.games - a.games);

  return (
    <div>
      <h1>{SEASON} シーズン成績</h1>
      <p className="muted">{games.length} 試合（{games.filter((g) => g.game.result?.outcome === "win").length} 勝）</p>

      <h2>打撃</h2>
      <table>
        <thead>
          <tr>
            <th>選手</th><th>試</th><th>打席</th><th>打数</th><th>安打</th><th>二</th><th>三</th><th>本</th>
            <th>打点</th><th>得点</th><th>四球</th><th>死球</th><th>三振</th><th>盗塁</th>
            <th>打率</th><th>出塁</th><th>長打</th><th>OPS</th>
          </tr>
        </thead>
        <tbody>
          {batting.map((b) => (
            <tr key={b.player_id}>
              <td>{name(b.player_id)}</td><td>{b.g}</td><td>{b.pa}</td><td>{b.ab}</td><td>{b.h}</td>
              <td>{b.b2}</td><td>{b.b3}</td><td>{b.hr}</td><td>{b.rbi}</td><td>{b.r}</td>
              <td>{b.bb}</td><td>{b.hbp}</td><td>{b.k}</td><td>{b.sb}</td>
              <td>{rate3(avg(b))}</td><td>{rate3(obp(b))}</td><td>{rate3(slg(b))}</td><td>{rate3(ops(b))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>投手</h2>
      <table>
        <thead>
          <tr>
            <th>選手</th><th>登板</th><th>投球回</th><th>対打者</th><th>被安打</th><th>被本</th>
            <th>奪三振</th><th>与四球</th><th>与死球</th><th>失点</th><th>自責</th><th>防御率</th>
          </tr>
        </thead>
        <tbody>
          {pitching.map((p) => (
            <tr key={p.player_id}>
              <td>{name(p.player_id)}</td><td>{p.g}</td><td>{ipStr(p.outs)}</td><td>{p.bf}</td>
              <td>{p.h}</td><td>{p.hr}</td><td>{p.k}</td><td>{p.bb}</td><td>{p.hbp}</td>
              <td>{p.r}</td><td>{p.er}</td><td>{era(p).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>守備</h2>
      <table>
        <thead>
          <tr><th>選手</th><th>試</th><th>刺殺</th><th>捕殺</th><th>失策</th><th>守備機会</th><th>守備率</th></tr>
        </thead>
        <tbody>
          {fielding.map((f) => (
            <tr key={f.player_id}>
              <td>{name(f.player_id)}</td><td>{f.g}</td><td>{f.po}</td><td>{f.a}</td>
              <td>{f.e}</td><td>{f.tc}</td><td>{rate3(fpct(f))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>出欠</h2>
      <table>
        <thead><tr><th>選手</th><th>参加</th><th>出場</th><th>ベンチ</th></tr></thead>
        <tbody>
          {attendance.map((a) => (
            <tr key={a.player_id}>
              <td>{name(a.player_id)}</td><td>{a.games}</td><td>{a.played}</td><td>{a.bench}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
