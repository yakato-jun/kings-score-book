"use client";
import { useEffect, useRef, useState } from "react";

type Flag = { inning: number; half: "top" | "bottom"; order: number; detail: string };
export type EditTarget = { inning: number; half: "top" | "bottom"; order: number; label: string; batter: string; play: string };
const POLL_MS = 2000;
const CAP_MS = 200_000;

export default function NoteClient({ gameId, initialNote, editTarget }: { gameId: string; initialNote: string; editTarget?: EditTarget | null }) {
  const [note, setNote] = useState(initialNote);
  const [status, setStatus] = useState("idle");
  const [flags, setFlags] = useState<Flag[]>([]);
  const [clarification, setClarification] = useState<string | null>(null);
  const [calls, setCalls] = useState(0);
  const [hasDraft, setHasDraft] = useState(false);
  const [error, setError] = useState("");
  const [published, setPublished] = useState(false);
  const [saved, setSaved] = useState(true);
  // AI修正(差分)
  const [instruction, setInstruction] = useState("");
  const [editing, setEditing] = useState(false);
  const [editMsg, setEditMsg] = useState("");
  const saveT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = status === "pending" || status === "running";

  // ノートの自動保存(デバウンス)。AIは呼ばない。編集モードでは textarea を出さないので発火しない。
  useEffect(() => {
    if (note === initialNote && saved) return;
    setSaved(false);
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(async () => {
      try { await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId, text: note }) }); setSaved(true); } catch {}
    }, 800);
    return () => { if (saveT.current) clearTimeout(saveT.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);

  function stopPoll() { if (pollT.current) { clearTimeout(pollT.current); pollT.current = null; } }
  useEffect(() => { void refresh(); return stopPoll; /* eslint-disable-next-line */ }, []);

  async function refresh() {
    try {
      const s = await fetch(`/api/aggregate/status?gameId=${gameId}`).then((x) => x.json());
      setStatus(s.status ?? "idle"); setFlags(s.flags ?? []); setClarification(s.clarification ?? null); setCalls(s.calls ?? 0); setHasDraft(!!s.hasDraft);
      if (s.error) setError(s.error);
      return s.status as string;
    } catch (e) { setError(String(e)); return "error"; }
  }

  function poll(startedAt: number) {
    pollT.current = setTimeout(async () => {
      if (Date.now() - startedAt > CAP_MS) { setError("集計がタイムアウトしました"); stopPoll(); return; }
      const st = await refresh();
      if (st === "pending" || st === "running") poll(startedAt); else stopPoll();
    }, POLL_MS);
  }

  async function aggregate() {
    setError(""); setPublished(false); setFlags([]); setClarification(null);
    try {
      await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId, text: note }) });
      const r = await fetch("/api/aggregate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId, text: note }) }).then((x) => x.json());
      if (r.error) { setError(r.error); return; }
      setStatus("running"); stopPoll(); poll(Date.now());
    } catch (e) { setError(String(e)); }
  }

  async function publish() {
    const r = await fetch("/api/games/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId }) }).then((x) => x.json());
    if (r.error) { setError("確定失敗: " + r.error); return; }
    setPublished(true); setHasDraft(false); setFlags([]); setClarification(null);
  }
  async function discard() {
    if (!confirm("下書きを破棄して、最後に公開した状態へ戻します。よろしいですか？")) return;
    const r = await fetch("/api/games/discard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId }) }).then((x) => x.json());
    if (r.error) { setError("破棄失敗: " + r.error); return; }
    setHasDraft(false); setFlags([]); setClarification(null); setError("");
  }

  async function submitEdit() {
    if (!editTarget || !instruction.trim()) return;
    setEditing(true); setEditMsg(""); setError("");
    try {
      const r = await fetch("/api/edit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId, inning: editTarget.inning, half: editTarget.half, order: editTarget.order, instruction }),
      }).then((x) => x.json());
      if (r.error) setError(r.error);
      else { setEditMsg(r.message ?? "修正しました"); setInstruction(""); await refresh(); }
    } catch (e) { setError(String(e)); }
    setEditing(false);
  }

  const ih = (f: Flag) => `${f.inning}回${f.half === "top" ? "表" : "裏"}#${f.order}`;
  const editHref = (f: Flag) => `/admin/games/${gameId}/note?edit=${f.inning}-${f.half}-${f.order}`;

  const draftBar = (
    <div className={`draftbar ${hasDraft ? "" : "disabled"}`}>
      <span className="db-label">{hasDraft ? "未公開の下書きがあります" : "下書きはありません"}</span>
      <a className="db-act" aria-disabled={!hasDraft} href={hasDraft ? `/games/${gameId}?preview=1` : undefined} target="_blank" rel="noreferrer">プレビュー（ボックス）</a>
      <a className="db-act" aria-disabled={!hasDraft} href={hasDraft ? `/games/${gameId}/text?preview=1` : undefined} target="_blank" rel="noreferrer">プレビュー（テキスト）</a>
      <button className="db-act" disabled={!hasDraft} onClick={publish}>確定（公開）</button>
      <button className="db-act" disabled={!hasDraft} onClick={discard}>下書きを破棄</button>
      {published && <b className="win"> 公開しました</b>}
    </div>
  );

  const flagsList = flags.length > 0 && (
    <div className="proposals">
      <h2>要確認（不明瞭）{flags.length}件</h2>
      <p className="muted">クリックでその打席の<b>AI修正</b>へ。</p>
      <ul>{flags.map((f, i) => (
        <li key={i}><a href={editHref(f)}>{ih(f)}</a>：{f.detail}</li>
      ))}</ul>
    </div>
  );

  // ===== AI修正モード(?edit=...) =====
  if (editTarget) {
    return (
      <div>
        {draftBar}
        <div className="editpanel">
          <h2>AI修正　<span className="muted">{editTarget.label}</span></h2>
          <p className="muted">現在の記録：<b>{editTarget.batter}</b> — {editTarget.play}</p>
          <textarea className="notearea" value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={4}
            placeholder={"どう直すか自然言語で。\n例: 単打にして、打者は二塁でタッチアウト。得点は無し。\n例: 2点目はエラーでの生還、打点なしに。"} />
          <div className="notebar">
            <button onClick={submitEdit} disabled={editing || !instruction.trim()}>{editing ? "AI修正中…" : "この打席をAI修正"}</button>
            <a href={`/admin/games/${gameId}/note`}>← ノート入力に戻る</a>
          </div>
          {editMsg && <div className="win">{editMsg}。プレビューで確認 → 上の「確定（公開）」で確定してください。</div>}
          {error && <div className="loss">エラー: {error}</div>}
          <p className="muted">※ AI修正は整合性を強制しません（あなたの指示どおり差分反映）。結果はプレビューで確認してください。</p>
        </div>
        {flagsList}
      </div>
    );
  }

  // ===== ノート入力モード =====
  return (
    <div>
      {draftBar}
      <textarea className="notearea" value={note} onChange={(e) => setNote(e.target.value)} rows={16}
        placeholder={"例:\n2026年6月14日 対ホーネッツ 練習試合 後攻\nスタメン 5 野村(助っ人) 2 田中 …\n1回表 1番 空振り三振\n…"} />
      <div className="notebar">
        <button onClick={aggregate} disabled={busy}>{busy ? "集計中…" : "AI集計"}</button>
        <span className="muted">{saved ? "保存済み" : "保存中…"}{busy ? "／集計しています（このまま開いておいてください）" : calls ? `／前回 ${calls} コール` : ""}</span>
      </div>
      {error && <div className="loss">エラー: {error}</div>}
      {flagsList}
      {clarification && (
        <div className="proposals">
          <h2>AIからの確認</h2>
          <p className="muted">解析が確定できなかった点です。ノートを補って再度「AI集計」するか、テキストスコアの「修正」から直してください。</p>
          <p className="clarify">{clarification}</p>
        </div>
      )}
      {!busy && status === "done" && flags.length === 0 && !clarification && hasDraft && <div className="win">集計しました（不明瞭なし）。プレビューで確認して確定してください。</div>}
    </div>
  );
}
