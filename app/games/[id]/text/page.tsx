import { notFound } from "next/navigation";
import Link from "next/link";
import { loadForView } from "@/lib/db/games";
import { loadPlayers } from "@/lib/db/players";
import { halfInnings, situationLabel, playLine, batterLabel, paAnchor, duringLines, annotationLines, lineupChangeLine } from "@/lib/textlog";
import { POS_ABBR } from "@/lib/lineup";
import { BaseDiamond } from "@/components/BaseDiamond";
import { ResolveButton } from "./ResolveButton";
import { docNameResolver } from "@/lib/names";
import { derivePAStates } from "@/lib/ops/gamestate";
import { unresolvedUnclear } from "@/lib/ops/validate";
import { DraftConfirmBar } from "../DraftConfirmBar";

export const dynamic = "force-dynamic";

export default async function GameTextPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ preview?: string; gen?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const view = await loadForView(id, { preview: sp.preview === "1", gen: sp.gen ? Number(sp.gen) : undefined });
  if (!view) notFound();
  const doc = view.doc;
  const players = await loadPlayers();
  const g = doc.game;

  // §9: 人物解決は participants(=試合の人リスト)が正本(roster=マスタ名/guest=実名/相手=位置のみ)
  const nameOf = docNameResolver(doc, players);

  const away = g.home_away === "away";
  const firstName = away ? "キングス" : g.opponent; // 先攻(表)
  const secondName = away ? g.opponent : "キングス"; // 後攻(裏)

  // 先発ラインアップ(seq 0)
  const start = [...(doc.lineup_snapshots ?? [])].sort((a, b) => a.seq - b.seq)[0];
  const kingsStart = [...(start?.lineup ?? [])]
    .filter((e) => e.player_id)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  // 相手は身元非追跡(§9)＝スタメン表は出さない(打順位置は各打席の opponent_slot が持つ)

  const halves = halfInnings(doc);
  const states = derivePAStates(doc); // 開始時アウト/走者/order を結果から導出(保存値を使わない)

  // 得点の実況行: 得点が入った打席に「生還者」と「その時点のスコア」を添える(中継のように流れが読める)。
  // 累計は半イニング列を時系列に畳むだけ=保存値不要(導出はサーバの仕事)。得点者不明(null)は正直にそう出す。
  let topRuns = 0;
  let botRuns = 0;
  const runLines = new Map<(typeof halves)[number]["pas"][number], string>();
  for (const hh of halves) {
    for (const pa of hh.pas) {
      const n = pa.runs?.length ?? 0;
      if (n === 0) continue;
      if (hh.half === "top") topRuns += n; else botRuns += n;
      const names = (pa.runs ?? []).map((r) => (r.runner_id ? nameOf(r.runner_id) : "得点者不明")).join("・");
      runLines.set(pa, `得点: ${names}が生還（${firstName} ${topRuns} - ${botRuns} ${secondName}）`);
    }
  }

  // 選手交代・守備変更の表示行: スナップショット差分を effective_from(回/表裏/どの打席の前か)の位置へ差し込む
  const snaps = [...(doc.lineup_snapshots ?? [])].sort((a, b) => a.seq - b.seq);
  const changeEvents = new Map<string, { before: number; line: string }[]>();
  for (let i = 1; i < snaps.length; i++) {
    const line = lineupChangeLine(snaps[i - 1], snaps[i], nameOf);
    if (!line) continue;
    const ef = snaps[i].effective_from;
    const k = `${ef.inning}-${ef.half}`;
    const arr = changeEvents.get(k) ?? [];
    arr.push({ before: ef.before_order ?? 0, line });
    changeEvents.set(k, arr);
  }
  // 未解決の要確認(unclear)を持つ打席数。確定バーの件数表示に渡す(⚠ は各打席に出る)。
  const flagsCount = doc.plate_appearances.filter((p) => unresolvedUnclear(p).length > 0).length;

  return (
    <div>
      {/* 未公開の下書きをプレビュー中: 確定/破棄の導線をこの画面に集約(§非破壊フロー) */}
      {view.draft && <DraftConfirmBar id={id} flagsCount={flagsCount} />}
      {view.mode !== "public" && (
        <p className="previewbar">
          {view.mode === "version"
            ? "以前の版を表示中"
            : view.draft
              ? "未確定の集計結果（未公開）を表示中"
              : "プレビュー（公開版）"}
          　<Link href={`/games/${id}/text`}>公開版へ</Link>
          　<Link href={`/admin/games/${id}`}>編集に戻る</Link>
        </p>
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
          <p className="muted">個別の打順記録なし</p>
        </div>
      </div>

      {halves.map((h) => {
        const offense = h.half === "top" ? firstName : secondName;
        // この半イニングの交代/守備変更を「どの打席の前か(before_order)」で打席列に差し込む
        const evs = [...(changeEvents.get(`${h.inning}-${h.half}`) ?? [])].sort((a, b) => a.before - b.before);
        let evIdx = 0;
        const rows: ({ kind: "pa"; pa: (typeof h.pas)[number] } | { kind: "chg"; line: string })[] = [];
        for (const pa of h.pas) {
          const ord = states.get(pa)?.order ?? pa.order;
          while (evIdx < evs.length && evs[evIdx].before <= ord) rows.push({ kind: "chg", line: evs[evIdx++].line });
          rows.push({ kind: "pa", pa });
        }
        while (evIdx < evs.length) rows.push({ kind: "chg", line: evs[evIdx++].line }); // 半イニング末尾扱いの変更
        return (
          <section className="pbp-half" key={`${h.inning}-${h.half}`}>
            <h2 className="ih">
              {h.inning}回{h.half === "top" ? "表" : "裏"}　{offense}の攻撃
            </h2>
            {rows.map((row, ri) => {
              if (row.kind === "chg") return (
                <div className="pbp-change" key={`chg-${ri}`}>⇄ {row.line}</div>
              );
              const pa = row.pa;
              const st = states.get(pa) ?? { outs: pa.outs ?? 0, runners: { first: null, second: null, third: null }, order: pa.order }; // 走者は導出が正本(保存走者スナップは§9で廃止)
              const sit = situationLabel(st.outs, st.runners);
              return (
                <div className="pbp-pa" id={paAnchor(pa.inning, pa.half, st.order)} key={st.order}>
                  <div>
                    <span className="pbp-num">{st.order}：</span>
                    <span className="pbp-batter">{batterLabel(pa, nameOf)}</span>
                    <span className="pbp-sit">{sit}</span>
                    <BaseDiamond
                      first={!!st.runners.first}
                      second={!!st.runners.second}
                      third={!!st.runners.third}
                      outs={st.outs}
                      label={sit}
                    />
                    {view.mode === "preview" && !view.draft && (
                      // 公開版プレビュー中のみ「修正」=ノートに打席を頭出し。下書き中は出さない(直すならノートを直して再集計)。
                      <Link className="pbp-edit" href={`/admin/games/${id}/note?edit=${pa.inning}-${pa.half}-${st.order}`}>修正</Link>
                    )}
                  </div>
                  {duringLines(pa, nameOf).map((d, k) => (
                    <div className="pbp-during" key={k}>{d}</div>
                  ))}
                  <div className="pbp-play">{playLine(pa, st.outs)}</div>
                  {runLines.has(pa) && <div className="pbp-runs">⚾ {runLines.get(pa)}</div>}
                  {annotationLines(pa).map((a, k) => (
                    <div className={`pbp-anno ${a.kind}`} key={k}>
                      ※ {a.text}
                      {view.mode === "preview" && a.kind === "unclear" && (
                        <ResolveButton gameId={id} inning={pa.inning} half={pa.half} order={st.order} rule={a.rule} />
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
            <p className="pbp-sum">
              得点 {h.runs}　安打 {h.hits}　四死球 {h.walks}
            </p>
          </section>
        );
      })}
    </div>
  );
}
