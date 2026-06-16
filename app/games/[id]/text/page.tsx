import { notFound } from "next/navigation";
import Link from "next/link";
import { loadGame, loadWorking } from "@/lib/db/games";
import { loadPlayers } from "@/lib/db/players";
import { halfInnings, situationLabel, playLine, batterLabel, paAnchor, duringLines } from "@/lib/textlog";
import { POS_ABBR } from "@/lib/lineup";
import { BaseDiamond } from "@/components/BaseDiamond";
import { playerName } from "@/lib/names";

export const dynamic = "force-dynamic";

export default async function GameTextPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ preview?: string }> }) {
  const { id } = await params;
  const preview = (await searchParams).preview === "1";
  const work = preview ? await loadWorking(id) : null;
  const doc = preview ? work?.doc ?? null : await loadGame(id);
  if (!doc) notFound();
  const players = await loadPlayers();
  const g = doc.game;

  // 追加選手の名前(助っ人=guest / 相手=opponent)。無ければマスタ→助っ人N等にフォールバック
  const addl = new Map((doc.additional_players ?? []).map((a) => [a.id, a.name]));
  const oppNames = new Map(
    (doc.additional_players ?? []).filter((a) => a.type === "opponent").map((a) => [a.id, a.name])
  );
  const nameOf = (pid: string) => addl.get(pid) ?? playerName(pid, players);

  const away = g.home_away === "away";
  const firstName = away ? "キングス" : g.opponent; // 先攻(表)
  const secondName = away ? g.opponent : "キングス"; // 後攻(裏)

  // 先発ラインアップ(seq 0)
  const start = [...(doc.lineup_snapshots ?? [])].sort((a, b) => a.seq - b.seq)[0];
  const kingsStart = [...(start?.lineup ?? [])]
    .filter((e) => e.player_id)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const oppStart = [...oppNames.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const halves = halfInnings(doc);

  return (
    <div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        <Link href={`/games/${id}${preview ? "?preview=1" : ""}`}>← ボックススコア</Link>
      </p>
      {preview && (
        <p className="previewbar">下書きプレビュー（gen {work?.gen}・未公開）　<Link href={`/games/${id}/text`}>公開版へ</Link></p>
      )}
      <h1>{g.date}　テキスト速報</h1>
      <p className="muted">
        {firstName}（先攻） vs {secondName}（後攻）
        {g.result ? `　${g.result.our_score} - ${g.result.their_score}` : ""}
      </p>

      <h2>試合前情報</h2>
      <div className="pregame">
        <div>
          <p className="muted" style={{ margin: "0 0 0.25rem" }}>キングス スタメン</p>
          <table>
            <tbody>
              {kingsStart.map((e) => (
                <tr key={e.player_id}>
                  <td>{e.order ?? "－"}</td>
                  <td>{e.position_id ? POS_ABBR[e.position_id] ?? e.position_id : ""}</td>
                  <td className="tl">{nameOf(e.player_id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <p className="muted" style={{ margin: "0 0 0.25rem" }}>{g.opponent} スタメン</p>
          {oppStart.length > 0 ? (
            <table>
              <tbody>
                {oppStart.map(([oid, nm], i) => (
                  <tr key={oid}>
                    <td>{i + 1}</td>
                    <td className="tl">{nm}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">個別の打順記録なし</p>
          )}
        </div>
      </div>

      {halves.map((h) => {
        const offense = h.half === "top" ? firstName : secondName;
        return (
          <section className="pbp-half" key={`${h.inning}-${h.half}`}>
            <h2 className="ih">
              {h.inning}回{h.half === "top" ? "表" : "裏"}　{offense}の攻撃
            </h2>
            {h.pas.map((pa) => (
              <div className="pbp-pa" id={paAnchor(pa.inning, pa.half, pa.order)} key={pa.order}>
                <div>
                  <span className="pbp-num">{pa.order}：</span>
                  <span className="pbp-batter">{batterLabel(pa, nameOf)}</span>
                  <span className="pbp-sit">{situationLabel(pa)}</span>
                  <BaseDiamond
                    first={!!pa.runners.first}
                    second={!!pa.runners.second}
                    third={!!pa.runners.third}
                    outs={pa.outs}
                    label={situationLabel(pa)}
                  />
                </div>
                {duringLines(pa, nameOf).map((d, k) => (
                  <div className="pbp-during" key={k}>{d}</div>
                ))}
                <div className="pbp-play">{playLine(pa)}</div>
              </div>
            ))}
            <p className="pbp-sum">
              得点 {h.runs}　安打 {h.hits}　四死球 {h.walks}
            </p>
          </section>
        );
      })}
    </div>
  );
}
