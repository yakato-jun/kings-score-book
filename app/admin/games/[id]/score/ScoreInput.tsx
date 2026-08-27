"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/components/DialogProvider";
import type { PARowView, LineupSlotView, PitcherRowView, DirectStatRowView } from "@/lib/ops/score-view";
import { RESULT_CHOICES } from "@/lib/ops/score-view";
import { AtBatList, LineupEditor, PitchingRecords, GameInfoSection, DirectStatsSection, PersonSelect, type Person, type PostFn } from "./editor-parts";

// ─── page.tsx から渡る serializable な盤面導出＋ビュー ───
type Half = "top" | "bottom";
type Sit = { inning: number; half: Half; outs: number; kings: number; opp: number; kingsBatHalf: Half };
type NextInfo = { inning: number; batterName: string | null; opponentSlot: number | null };
type Runner = { from: string; name: string };
type LineupRow = { order: number | null; position_id: string | null; player_id: string; name: string };

const DEST: [string, string][] = [["", "（自動）"], ["2", "二塁へ"], ["3", "三塁へ"], ["home", "生還"], ["out", "アウト"]];
const HALF_JP = (h: Half) => (h === "top" ? "表" : "裏");

export function ScoreInput(props: {
  gameId: string; gen: number; hasDraft: boolean; hasLineup: boolean;
  situation: Sit; nextByHalf: { top: NextInfo; bottom: NextInfo }; runners: Runner[]; lineup: LineupRow[];
  rows: PARowView[]; currentLineup: LineupSlotView[]; pitchers: PitcherRowView[]; directStats: DirectStatRowView[];
  meta: { home_away: "home" | "away" | null; our_score: number | null; their_score: number | null; outcome: string | null; decided_by: string | null; line_score: { ours: (number | null)[]; theirs: (number | null)[] } | null };
  participants: Person[]; masters: Person[];
}) {
  const { gameId, hasDraft, hasLineup, situation: st, nextByHalf, runners, rows, currentLineup, pitchers, directStats, meta, participants, masters } = props;
  const router = useRouter();
  const { confirm } = useDialog();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gen, setGen] = useState(props.gen); // 楽観ロック基準。op成功のたびサーバ返却の新genへ更新=連続入力の自己競合を防ぐ

  // 末尾の打席追加フォーム
  const [half, setHalf] = useState<Half>(st.half);
  const [inningOverride, setInningOverride] = useState<number | null>(null);
  const inning = inningOverride ?? nextByHalf[half].inning;
  const [batterOverride, setBatterOverride] = useState("");
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");

  const post: PostFn = (op, onOk) => {
    setBusy(true); setErr(null);
    fetch("/api/score/op", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId, op, baseGen: gen }) })
      .then((x) => x.json())
      .then((r) => {
        if (r.error) { setErr(r.error); setBusy(false); return; }
        if (typeof r.gen === "number") setGen(r.gen);
        onOk?.(); setBusy(false); router.refresh();
      })
      .catch((e) => { setErr((e as Error).message); setBusy(false); });
  };
  async function postApi(url: string, body: object) {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      if (r.error) { setErr(r.error); setBusy(false); return; }
      setBusy(false); router.refresh();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  function submitPA(result: string) {
    const baserunning_after = runners.filter((r) => moves[r.from]).map((r) => ({ from: r.from, to: moves[r.from] }));
    const op: Record<string, unknown> = { type: "addPlateAppearance", inning, half, result };
    if (batterOverride) op.batter_id = batterOverride;
    if (baserunning_after.length) op.baserunning_after = baserunning_after;
    if (note.trim()) op.note = note.trim();
    post(op, () => { setBatterOverride(""); setMoves({}); setNote(""); setInningOverride(null); });
  }

  const next = nextByHalf[half];
  const isKingsHalf = half === st.kingsBatHalf;

  return (
    <div className="scoreinput">
      {/* 現状況(導出・入力不可) */}
      <div className="sc-sit">
        <b>{st.inning}回{HALF_JP(st.half)}</b>　{st.outs}アウト　走者: {runners.length ? runners.map((r) => `${r.from}塁=${r.name}`).join(" / ") : "なし"}
        　／　N-KINGS {st.kings} - {st.opp} 相手
      </div>
      {err && <div className="loss">エラー: {err}</div>}

      {/* D-2 スタメン・交代 */}
      <section className="sc-box">
        <h2>スタメン・交代{hasLineup ? "" : "（未登録）"}</h2>
        <LineupEditor currentLineup={currentLineup} participants={participants} masters={masters} post={post} busy={busy} hasLineup={hasLineup} />
      </section>

      {/* D-1 打席リスト */}
      <section className="sc-box">
        <h2>打席（{rows.length}件）</h2>
        {rows.length === 0 ? <p className="muted">まだありません。下の「打席を記録」から追加してください。</p>
          : <AtBatList rows={rows} participants={participants} masters={masters} post={post} busy={busy} gameId={gameId} />}
      </section>

      {/* 末尾の打席追加フォーム */}
      <section className="sc-box">
        <h2>打席を記録（末尾に追加）</h2>
        <div className="sc-row">
          <label>攻撃 <select value={half} onChange={(e) => { setHalf(e.target.value as Half); setInningOverride(null); setBatterOverride(""); setMoves({}); }}>
            <option value={st.kingsBatHalf}>キングス（{HALF_JP(st.kingsBatHalf)}）</option>
            <option value={st.kingsBatHalf === "top" ? "bottom" : "top"}>相手（{HALF_JP(st.kingsBatHalf === "top" ? "bottom" : "top")}）</option>
          </select></label>
          <label>回 <input type="number" min={1} value={inning} onChange={(e) => setInningOverride(Number(e.target.value))} style={{ width: "3.5em" }} /></label>
          <span className="muted">次打者: {next.opponentSlot != null ? `相手${next.opponentSlot}番（自動）` : next.batterName ?? "（未登録）"}</span>
          {isKingsHalf && (
            <label>代打/明示 <PersonSelect value={batterOverride} onChange={setBatterOverride} participants={participants} masters={masters} autoLabel="（自動）" /></label>
          )}
        </div>

        {runners.length > 0 && (
          <div className="sc-row">
            <span className="muted">走者の追加進塁/アウト(任意・強制進塁は自動):</span>
            {runners.map((r) => (
              <label key={r.from}>{r.from}塁 {r.name} <select value={moves[r.from] ?? ""} onChange={(e) => setMoves((m) => ({ ...m, [r.from]: e.target.value }))}>
                {DEST.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select></label>
            ))}
          </div>
        )}

        <div className="sc-results">
          {RESULT_CHOICES.map(([code, label]) => (
            <button key={code} className="sc-rbtn" disabled={busy} onClick={() => submitPA(code)}>{label}</button>
          ))}
        </div>
        <div className="sc-row">
          <input className="notearea" style={{ minHeight: 0, height: "2.2em", flex: 1 }} placeholder="実況/メモ(任意)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <p className="muted">※ 得点/打点/自責/残塁/押し出し/投捕はエンジンが自動導出。詳細（守備/走塁）は追加後に打席の「編集」で。</p>
      </section>

      {/* D-3 投手記録 */}
      <section className="sc-box">
        <h2>投手記録</h2>
        <PitchingRecords pitchers={pitchers} post={post} busy={busy} />
      </section>

      {/* §0/§11 個人成績(断片) */}
      <section className="sc-box">
        <h2>個人成績（断片）</h2>
        <DirectStatsSection existing={directStats} participants={participants} post={post} busy={busy} />
      </section>

      {/* D-4 試合情報 */}
      <section className="sc-box">
        <h2>試合情報（最終スコア・先攻後攻）</h2>
        <GameInfoSection meta={meta} post={post} busy={busy} />
      </section>

      {/* draftBar */}
      <div className={`draftbar ${hasDraft ? "" : "disabled"}`}>
        <span className="db-label">{hasDraft ? "未確定の集計結果があります" : "未確定の集計結果はありません"}</span>
        <a className="db-act" aria-disabled={!hasDraft} href={hasDraft ? `/games/${gameId}/text?preview=1` : undefined} target="_blank" rel="noreferrer">プレビュー（テキスト）</a>
        <button className="db-act" disabled={!hasDraft || busy} onClick={() => postApi("/api/games/publish", { gameId })}>確定（公開）</button>
        <button className="db-act" disabled={!hasDraft || busy} onClick={async () => { if (await confirm({ title: "未確定の集計結果を破棄", body: "入力したスコア（未確定の集計結果）が消えます。", confirmLabel: "破棄", danger: true })) postApi("/api/games/discard", { gameId }); }}>破棄</button>
      </div>
    </div>
  );
}
