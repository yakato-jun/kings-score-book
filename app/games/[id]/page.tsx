import { notFound } from "next/navigation";
import Link from "next/link";
import { loadGame, loadWorking } from "@/lib/db/games";
import { loadPlayers } from "@/lib/db/players";
import { aggregateGame, gameLineScore } from "@/lib/agg";
import { ipStr, era } from "@/lib/agg/types";
import { displayLineup, roleLabel, battingGrid } from "@/lib/lineup";
import { paAnchor } from "@/lib/textlog";
import { playerName } from "@/lib/names";
import type { Half } from "@/lib/types/v2";

export const dynamic = "force-dynamic";

export default async function GamePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ preview?: string }> }) {
  const { id } = await params;
  const preview = (await searchParams).preview === "1";
  const work = preview ? await loadWorking(id) : null;
  const doc = preview ? work?.doc ?? null : await loadGame(id);
  if (!doc) notFound();
  const players = await loadPlayers();
  // 助っ人/相手の名前は試合docの additional_players から解決(無ければマスタ→助っ人N)
  const addl = new Map((doc.additional_players ?? []).map((a) => [a.id, a.name]));
  const box = aggregateGame(doc);
  const name = (pid: string) => addl.get(pid) ?? playerName(pid, players);
  const g = doc.game;
  const r = g.result;

  // 完全ラインアップ(打順チェーン+投手+代打/代走の役割)
  const pinchRunners = new Set<string>();
  for (const pa of doc.plate_appearances) {
    if (pa.pinch_runner?.runner_id) pinchRunners.add(pa.pinch_runner.runner_id);
  }
  const battingByPlayer = new Map(box.batting.map((b) => [b.player_id, b]));
  const rows = displayLineup(doc.lineup_snapshots, pinchRunners, new Set(battingByPlayer.keys()));
  const rowByPlayer = new Map(rows.map((r) => [r.player_id, r]));

  const ls = gameLineScore(doc);
  const away = g.home_away === "away";
  const topName = away ? "キングス" : g.opponent;
  const botName = away ? g.opponent : "キングス";
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

  // イニング別 打席結果グリッド(batter_id×回でキー=打順入れ替えに非依存)
  const batHalf: Half = away ? "top" : "bottom";
  const grid = battingGrid(doc.plate_appearances, batHalf);
  const ZERO = { ab: 0, h: 0, rbi: 0, r: 0, bb: 0, k: 0, sb: 0 };
  const innList = Array.from({ length: ls.innings }, (_, i) => i + 1);
  const tot = box.batting.reduce(
    (t, b) => ({ ab: t.ab + b.ab, h: t.h + b.h, rbi: t.rbi + b.rbi, r: t.r + b.r, bb: t.bb + b.bb, k: t.k + b.k, sb: t.sb + b.sb }),
    { ab: 0, h: 0, rbi: 0, r: 0, bb: 0, k: 0, sb: 0 }
  );
  const hasBatting = box.batting.length > 0;

  return (
    <div>
      <h1>{g.date}　vs {g.opponent}</h1>
      <p className="muted">
        {g.league ?? ""}　{r ? `${r.our_score} - ${r.their_score}（${{ win: "勝", loss: "負", tie: "分" }[r.outcome]}${r.decided_by === "forfeit" ? "・不戦" : ""}）` : ""}
      </p>
      {preview && (
        <p className="previewbar">下書きプレビュー（gen {work?.gen}・未公開）　<Link href={`/games/${id}`}>公開版へ</Link></p>
      )}
      {hasBatting && (
        <p className="muted" style={{ margin: "0 0 0.5rem" }}>
          <Link href={`/games/${id}/text${preview ? "?preview=1" : ""}`}>テキスト速報 →</Link>
        </p>
      )}

      {ls.innings > 0 && (
        <div className="scrollx"><table className="linescore">
          <thead>
            <tr>
              <th className="tl"></th>
              {innList.map((i) => <th key={i}>{i}</th>)}
              <th>計</th><th>安</th><th>失</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="tl tm">{topName}</td>
              {ls.topRuns.map((v, i) => <td key={i}>{v}</td>)}
              <td><b>{sum(ls.topRuns)}</b></td><td>{ls.topHits}</td><td>{ls.bottomErrors}</td>
            </tr>
            <tr>
              <td className="tl tm">{botName}</td>
              {ls.bottomRuns.map((v, i) => <td key={i}>{v}</td>)}
              <td><b>{sum(ls.bottomRuns)}</b></td><td>{ls.bottomHits}</td><td>{ls.topErrors}</td>
            </tr>
          </tbody>
        </table></div>
      )}

      {hasBatting && (
        <>
          <h2>打撃</h2>
          <p className="muted">() = 先発守備位置 / 打=代打 / 走=代走 / <span className="hit">安打は赤</span> / <span className="rbi">打点は太字</span></p>
          <div className="scrollx"><table className="frz1">
            <thead>
              <tr>
                <th className="tl">選手</th><th>位置</th>
                <th>打数</th><th>安</th><th>点</th><th>得</th><th>球</th><th>振</th><th>盗</th>
                {innList.map((i) => <th key={i} className="grid">{i}回</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const b = battingByPlayer.get(row.player_id);
                // 打順に入った投手(DH解除等)は打席ゼロでも0埋め。打順なしの純投手は空欄。
                const z = b ?? (row.slot != null ? ZERO : null);
                return (
                  <tr key={row.player_id}>
                    <td className="tl">{name(row.player_id)}</td>
                    <td className="muted">{roleLabel(row)}</td>
                    {z ? (
                      <>
                        <td>{z.ab}</td><td>{z.h}</td><td>{z.rbi}</td><td>{z.r}</td><td>{z.bb}</td><td>{z.k}</td><td>{z.sb}</td>
                        {innList.map((i) => {
                          const cell = grid.get(row.player_id)?.get(i) ?? [];
                          return (
                            <td key={i} className="grid">
                              {cell.map((l, j) => (
                                <span key={j}>{j > 0 ? " " : ""}<Link href={`/games/${id}/text#${paAnchor(l.inning, l.half, l.order)}`} className={["gridlink", l.hit ? "hit" : "", l.rbi ? "rbi" : ""].filter(Boolean).join(" ")}>{l.text}</Link></span>
                              ))}
                            </td>
                          );
                        })}
                      </>
                    ) : (
                      <>
                        {Array.from({ length: 7 }, (_, i) => <td key={i}></td>)}
                        {innList.map((i) => <td key={i} className="grid"></td>)}
                      </>
                    )}
                  </tr>
                );
              })}
              <tr>
                <td className="tl">合計</td><td></td>
                <td>{tot.ab}</td><td>{tot.h}</td><td>{tot.rbi}</td><td>{tot.r}</td><td>{tot.bb}</td><td>{tot.k}</td><td>{tot.sb}</td>
                <td colSpan={innList.length}></td>
              </tr>
            </tbody>
          </table></div>
        </>
      )}

      {box.pitching.length > 0 && (
        <>
          <h2>投手</h2>
          <div className="scrollx"><table className="frz1">
            <thead>
              <tr><th className="tl">選手</th><th>投球回</th><th>対打者</th><th>被安打</th><th>奪三振</th><th>与四球</th><th>与死球</th><th>失点</th><th>自責</th><th>防御率</th></tr>
            </thead>
            <tbody>
              {box.pitching.map((p) => (
                <tr key={p.player_id}>
                  <td className="tl">{name(p.player_id)}</td><td>{ipStr(p.outs)}</td><td>{p.bf}</td><td>{p.h}</td>
                  <td>{p.k}</td><td>{p.bb}</td><td>{p.hbp}</td><td>{p.r}</td><td>{p.er}</td><td>{era(p).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}

      {box.fielding.length > 0 && (
        <>
          <h2>守備</h2>
          <div className="scrollx"><table className="frz1">
            <thead><tr><th className="tl">選手</th><th>位置</th><th>刺殺</th><th>捕殺</th><th>失策</th><th>守備機会</th></tr></thead>
            <tbody>
              {box.fielding.map((f) => (
                <tr key={f.player_id}>
                  <td className="tl">{name(f.player_id)}</td>
                  <td className="muted">{roleLabel(rowByPlayer.get(f.player_id))}</td><td>{f.po}</td><td>{f.a}</td><td>{f.e}</td><td>{f.tc}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}

      {!hasBatting && (
        <p className="muted">この試合はプレー記録がありません（不戦勝など）。</p>
      )}
    </div>
  );
}
