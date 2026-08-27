import { notFound } from "next/navigation";
import Link from "next/link";
import { loadForView, loadGames } from "@/lib/db/games";
import { loadPlayers, loadPlayerMap } from "@/lib/db/players";
import { gameLineScore, displayResult } from "@/lib/agg";
import { aggregateGameP, aggregateSeasonP } from "@/lib/agg/participants";
import { seasonOf } from "@/lib/season";
import { ipStr, era, avg, obp, slg, ops, rate3 } from "@/lib/agg/types";
import type { BattingLine } from "@/lib/agg/types";
import { displayLineup, roleLabel, battingGrid, type LineupRow } from "@/lib/lineup";
import { paAnchor } from "@/lib/textlog";
import { unresolvedUnclear } from "@/lib/ops/validate";
import { docNameResolver } from "@/lib/names";
import type { Half, Participant } from "@/lib/types/v2";
import { DraftConfirmBar } from "./DraftConfirmBar";

export const dynamic = "force-dynamic";

export default async function GamePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ preview?: string; gen?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const view = await loadForView(id, { preview: sp.preview === "1", gen: sp.gen ? Number(sp.gen) : undefined });
  if (!view) notFound();
  const doc = view.doc;
  const players = await loadPlayers();
  const masterMap = await loadPlayerMap(); // 種別(type)参照用: 出欠一覧の助っ人バッジ(roster link→マスタ種別 "guest")の判定に使う
  // §9: 人物解決は participants(=試合の人リスト)が正本。box行の助っ人キーは「試合ID:参加者ID」なので参加者部で解決。
  const nameOf = docNameResolver(doc, players);
  const box = aggregateGameP(doc);
  const name = (key: string) => {
    const i = key.indexOf(":");
    return nameOf(i >= 0 ? key.slice(i + 1) : key);
  };
  const g = doc.game;
  // 最終結果は「基本は記録スコアから導出・手入力は上書き」。displayResult が一元窓口。
  const dr = displayResult(doc);

  // §9: box行キー(roster=マスタID/guest=試合ID:参加者ID) ⇔ lineup行キー(参加者ID) の対応
  const parts = doc.participants ?? [];
  const boxKeyOf = (pid: string) => {
    const p = parts.find((x) => x.id === pid);
    return p ? (p.link.kind === "roster" ? p.link.player_id : `${g.id}:${pid}`) : pid; // 旧形式は恒等
  };
  const partOfKey = (key: string) => {
    const i = key.indexOf(":");
    if (i >= 0) return key.slice(i + 1);
    const p = parts.find((x) => x.link.kind === "roster" && x.link.player_id === key);
    return p ? p.id : key;
  };

  // 勝敗・セーブ: doc.pitching(記録員判断)の decision が正本。box行キーへ解決して投手表の名前横に併記する
  //   （doc.pitching が無い/decision 無しは従来どおり何も出さない。表示のみで集計・保存は触らない）。
  const decisionMark = new Map<string, string>();
  for (const rec of doc.pitching ?? []) {
    if (rec.decision) decisionMark.set(boxKeyOf(rec.pitcher_id), { W: "勝", L: "敗", S: "S" }[rec.decision]);
  }

  // 完全ラインアップ(打順チェーン+投手+代打/代走の役割)
  const pinchRunners = new Set<string>();
  for (const pa of doc.plate_appearances) {
    if (pa.pinch_runner?.runner_id) pinchRunners.add(pa.pinch_runner.runner_id);
  }
  const battingByPlayer = new Map(box.batting.map((b) => [b.player_id, b]));
  // [DH解除対応] 実際に打席に立った枠(batting_slot)の先取り: スナップショットに打順が現れない選手の枠フォールバックに使う
  const kingsHalfForSlots: Half = g.home_away === "away" ? "top" : "bottom";
  const paSlots = new Map<string, number>();
  for (const pa of doc.plate_appearances) {
    if (pa.half === kingsHalfForSlots && pa.batting_slot != null && !paSlots.has(pa.batter_id)) paSlots.set(pa.batter_id, pa.batting_slot);
  }
  const rows = displayLineup(doc.lineup_snapshots, pinchRunners, new Set(box.batting.map((b) => partOfKey(b.player_id))), paSlots);
  const rowByPlayer = new Map(rows.map((r) => [r.player_id, r]));
  // [§0/§11] 打撃表は lineup 由来の rows で描くため、lineup に居ない direct-only 打者(box.batting にはある)を末尾に追補
  //   ＝「数字は数字」で同テーブルに合算表示する(純§0=lineup無しの断片打者も出る)。
  const coveredBoxKeys = new Set(rows.map((r) => boxKeyOf(r.player_id)));
  const directOnlyRows: LineupRow[] = (doc.direct_stats ?? [])
    .filter((ds) => ds.batting && battingByPlayer.has(boxKeyOf(ds.participant_id)) && !coveredBoxKeys.has(boxKeyOf(ds.participant_id)))
    .map((ds) => ({ player_id: ds.participant_id, slot: null, slotSeq: Infinity, positions: [], role: "sub" }));
  const battingRows = [...rows, ...directOnlyRows];

  // [§9 参加者層=出欠] 出欠一覧: doc.participants(在籍=出席)が正本。並びは打順(lineup行順: 先発→交代→投手)→
  //   スタメン外(ベンチ)＝ベンチ参加も必ず出す(出欠の意味はそこにある)。旧形式doc(participants無し)は従来どおり非表示。
  const lineupIds = rows.map((r) => r.player_id);
  const inLineup = new Set(lineupIds);
  const attParts = [
    ...lineupIds.flatMap((pid) => parts.filter((x) => x.id === pid)),
    ...parts.filter((p) => !inLineup.has(p.id)),
  ];
  // 助っ人判定はマスタ種別 type==="guest" の一本(§12)。過去版プレビュー(?gen=N)の旧 guest link も助っ人表記。
  const isGuestPart = (p: Participant) =>
    p.link.kind === "roster" ? masterMap.get(p.link.player_id)?.type === "guest" : true;

  const ls = gameLineScore(doc);
  const away = g.home_away === "away";
  const topName = away ? "キングス" : g.opponent;
  const botName = away ? g.opponent : "キングス";
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

  // イニング別 打席結果グリッド(batter_id×回でキー=打順入れ替えに非依存)
  const batHalf: Half = away ? "top" : "bottom";
  const grid = battingGrid(doc.plate_appearances, batHalf);
  // 要確認(unclear)が付いた打席のアンカー集合。グリッドで ⚠ を出す。
  const flaggedAnchors = new Set(
    doc.plate_appearances
      .filter((p) => unresolvedUnclear(p).length > 0)
      .map((p) => paAnchor(p.inning, p.half, p.order))
  );
  const ZERO: BattingLine = { player_id: "", scope: "own", g: 0, pa: 0, ab: 0, r: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, rbi: 0, bb: 0, hbp: 0, k: 0, sh: 0, sf: 0, sb: 0 };
  const innList = Array.from({ length: ls.innings }, (_, i) => i + 1);
  // 打撃合計(レート計算にも使う完全なline)
  const teamBat: BattingLine = box.batting.reduce((t, b) => {
    (Object.keys(t) as (keyof BattingLine)[]).forEach((k) => { if (typeof t[k] === "number") (t[k] as number) += b[k] as number; });
    return t;
  }, { ...ZERO });
  const hasBatting = box.batting.length > 0;
  // [§0/§11] 個人成績(断片=direct_stats)由来を含む box 行/試合に『記録断片』バッジを出す。
  const directKeys = new Set((doc.direct_stats ?? []).map((ds) => boxKeyOf(ds.participant_id)));
  const hasFragments = (doc.direct_stats?.length ?? 0) > 0;
  const fragBadge = (on: boolean) => (on ? <span className="fragchip" title="盤面(打席)を伴わない個人成績の直接記録を含みます">記録断片</span> : null);
  // [この日時点のシーズン累計] 率列(打率/出塁/長打/OPS)は試合単体でなく、同一シーズンのこの試合日までの累計で出す。
  //   他試合は公開スナップショット / この試合は表示中の版(preview/公開)を反映。roster=クロス試合累計・guest=単試合(横断合算しない)。
  const seasonGames = (await loadGames())
    .filter((gd) => seasonOf(gd.game.date) === seasonOf(g.date) && gd.game.date <= g.date)
    .map((gd) => (gd.game.id === g.id ? doc : gd));
  if (!seasonGames.some((gd) => gd.game.id === g.id)) seasonGames.push(doc);
  const seasonBat = new Map(aggregateSeasonP(seasonGames).batting.map((sb) => [sb.player_id, sb]));
  // 投手も同型: 防御率は季通算・カウント列は試合単体。キーは box.pitching の player_id と一致(roster=P-id / guest=game:pid)。
  const seasonPitch = new Map(aggregateSeasonP(seasonGames).pitching.map((sp) => [sp.player_id, sp]));
  const rateLineOf = (key: string, fallback: BattingLine) => seasonBat.get(key) ?? fallback;
  // レート列: 分母0(ab=0/出塁分母0/投球アウト0)の行は '—'(0の失敗と誤読させない)。
  const bAvg = (b: BattingLine) => (b.ab > 0 ? rate3(avg(b)) : "—");
  const bObp = (b: BattingLine) => (b.ab + b.bb + b.hbp + b.sf > 0 ? rate3(obp(b)) : "—");
  const bSlg = (b: BattingLine) => (b.ab > 0 ? rate3(slg(b)) : "—");
  const bOps = (b: BattingLine) => (b.ab > 0 ? rate3(ops(b)) : "—");

  return (
    <div>
      {/* 未公開の下書きをプレビュー中: 確定/破棄の導線をこの画面に集約(§非破壊フロー) */}
      {view.draft && <DraftConfirmBar id={id} flagsCount={flaggedAnchors.size} />}
      <h1>{g.date}　vs {g.opponent} {fragBadge(hasFragments)}</h1>
      <p className="muted">
        {g.league ?? ""}　{dr ? `${dr.our} - ${dr.their}（${{ win: "勝", loss: "負", tie: "分" }[dr.outcome]}${dr.manual && dr.decided_by === "forfeit" ? "・不戦" : ""}）` : ""}
      </p>
      {view.mode !== "public" && (
        <p className="previewbar">
          {view.mode === "version"
            ? "以前の版を表示中"
            : view.draft
              ? "未確定の集計結果（未公開）を表示中"
              : "プレビュー（公開版）"}
          　<Link href={`/games/${id}`}>公開版へ</Link>
          　<Link href={`/admin/games/${id}`}>編集に戻る</Link>
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
          <p className="muted">() = 先発守備位置 / 打=代打 / 走=代走 / <span className="hit">安打は赤</span> / <span className="rbi">打点は太字</span> / 打率・出塁・長打・OPS はこの日時点のシーズン累計</p>
          <div className="scrollx"><table className="frz1 bat-frz">
            <thead>
              <tr>
                <th className="ord">打順</th><th className="tl">選手</th><th>位置</th>
                <th>打数</th><th>安</th><th>点</th><th>得</th><th>球</th><th>振</th><th>盗</th>
                <th>打率</th><th>出塁</th><th>長打</th><th>OPS</th>
                {innList.map((i) => <th key={i} className="grid">{i}回</th>)}
              </tr>
            </thead>
            <tbody>
              {battingRows.map((row, idx) => {
                const b = battingByPlayer.get(boxKeyOf(row.player_id));
                // 打順に入った投手(DH解除等)は打席ゼロでも0埋め。打順なしの純投手は空欄。
                const z = b ?? (row.slot != null ? ZERO : null);
                // 率列はこの日時点のシーズン累計(rl)、カウント列は試合単体(z)。
                const rl = rateLineOf(boxKeyOf(row.player_id), z ?? ZERO);
                // 打順(左端): スロット番号。同一スロットの連続(先発+代打/代走)は先頭行のみ番号・以降は空(繰り返し回避)。
                const slotCell = row.slot != null && (idx === 0 || battingRows[idx - 1].slot !== row.slot) ? row.slot : "";
                return (
                  <tr key={row.player_id}>
                    <td className="ord">{slotCell}</td>
                    <td className="tl">{nameOf(row.player_id)} {fragBadge(directKeys.has(boxKeyOf(row.player_id)))}</td>
                    <td className="muted">{roleLabel(row)}</td>
                    {z ? (
                      <>
                        <td>{z.ab}</td><td>{z.h}</td><td>{z.rbi}</td><td>{z.r}</td><td>{z.bb}</td><td>{z.k}</td><td>{z.sb}</td>
                        <td>{bAvg(rl)}</td><td>{bObp(rl)}</td><td>{bSlg(rl)}</td><td>{bOps(rl)}</td>
                        {innList.map((i) => {
                          const cell = grid.get(row.player_id)?.get(i) ?? [];
                          return (
                            <td key={i} className="grid">
                              {cell.map((l, j) => {
                                const anc = paAnchor(l.inning, l.half, l.order);
                                const flg = flaggedAnchors.has(anc);
                                return <span key={j}>{j > 0 ? " " : ""}<Link href={`/games/${id}/text#${anc}`} className={["gridlink", l.hit ? "hit" : "", l.rbi ? "rbi" : "", flg ? "flagged" : ""].filter(Boolean).join(" ")}>{l.text}{flg ? "⚠" : ""}</Link></span>;
                              })}
                            </td>
                          );
                        })}
                      </>
                    ) : (
                      <>
                        {Array.from({ length: 11 }, (_, i) => <td key={i}></td>)}
                        {innList.map((i) => <td key={i} className="grid"></td>)}
                      </>
                    )}
                  </tr>
                );
              })}
              <tr>
                <td className="ord"></td><td className="tl">合計</td><td></td>
                <td>{teamBat.ab}</td><td>{teamBat.h}</td><td>{teamBat.rbi}</td><td>{teamBat.r}</td><td>{teamBat.bb}</td><td>{teamBat.k}</td><td>{teamBat.sb}</td>
                <td></td><td></td><td></td><td></td>
                <td colSpan={innList.length}></td>
              </tr>
            </tbody>
          </table></div>
        </>
      )}

      {box.pitching.length > 0 && (
        <>
          <h2>投手</h2>
          <p className="muted">防御率はこの日時点のシーズン累計（自責が不明の試合を含む投手は「—」）</p>
          <div className="scrollx"><table className="frz1">
            <thead>
              <tr><th className="tl">選手</th><th>投球回</th><th>対打者</th><th>被安打</th><th>奪三振</th><th>与四球</th><th>与死球</th><th>失点</th><th>自責</th><th>防御率</th></tr>
            </thead>
            <tbody>
              {box.pitching.map((p) => (
                <tr key={p.player_id}>
                  <td className="tl">{name(p.player_id)} {decisionMark.has(p.player_id) && <span className="pbadge">{decisionMark.get(p.player_id)}</span>} {fragBadge(directKeys.has(p.player_id))}</td><td>{ipStr(p.outs)}</td><td>{p.bf}</td><td>{p.h}</td>
                  <td>{p.k}</td><td>{p.bb}</td><td>{p.hbp}</td><td>{p.r}</td><td>{p.er ?? "—"}</td><td>{era(seasonPitch.get(p.player_id) ?? p)?.toFixed(2) ?? "—"}</td>
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
                  <td className="tl">{name(f.player_id)} {fragBadge(directKeys.has(f.player_id))}</td>
                  <td className="muted">{roleLabel(rowByPlayer.get(partOfKey(f.player_id)))}</td><td>{f.po}</td><td>{f.a}</td><td>{f.e}</td><td>{f.tc}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>
      )}

      {hasFragments && (
        <div className="fragnote">
          <h2>記録断片 {fragBadge(true)}</h2>
          <p className="muted">以下は盤面（打席の経過）を伴わない個人成績の直接記録です。数字は上の表に合算しています（盤面の裏付けはありません）。</p>
          <ul>
            {(doc.direct_stats ?? []).map((ds, i) => {
              const kinds = [ds.batting ? "打撃" : null, ds.pitching ? "投手" : null, ds.fielding ? "守備" : null].filter(Boolean).join("・");
              return (
                <li key={i}>
                  <b>{nameOf(ds.participant_id)}</b>：{kinds || "個人成績"}の断片
                  {ds.note ? `／${ds.note}` : ""}
                  {(ds.annotations ?? []).map((a, j) => <span key={j} className="muted">　／{a.detail}</span>)}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!hasBatting && !hasFragments && (
        <p className="muted">この試合はプレー記録がありません（不戦勝など）。</p>
      )}

      {/* [§9 参加者層=出欠] 誰が来たかを公開ボックスでも見せる(編集画面だけでは一覧から辿れない実障害の解消)。
          内部ID(P-id/参加者ID)は出さず docNameResolver の名前のみ。助っ人は種別バッジで表記。 */}
      {attParts.length > 0 && (
        <>
          <h2>出欠（{attParts.length}人）</h2>
          <ul className="attlist">
            {attParts.map((p) => (
              <li key={p.id}>{nameOf(p.id)} {isGuestPart(p) && <span className="pbadge guest">助っ人</span>}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
