"use client";
import Link from "next/link";
import { useState } from "react";

type Msg = { role: "user" | "assistant"; content: string };
type Prop = { id: string; tool: string; input: Record<string, unknown>; applied?: boolean; appliedId?: string; published?: boolean };

function gameIdOf(p: Prop): string | null {
  if (p.tool === "upsertGameMeta") return String(p.input.id ?? "");
  if (p.tool === "setAttendance") return String(p.input.gameId ?? "");
  if (p.tool === "importGameDoc") {
    const doc = p.input.doc as { game?: { id?: string } } | undefined;
    return doc?.game?.id ?? null;
  }
  return null; // upsertPlayer は世代対象外(即適用)
}

export default function ChatAdmin() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [props, setProps] = useState<Prop[]>([]);
  const [error, setError] = useState("");

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next);
    setInput("");
    setProps([]);
    setError("");
    setLoading(true);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: next }) }).then((x) => x.json());
      if (r.error) setError(r.error);
      else {
        setMsgs([...next, { role: "assistant", content: r.reply || "(応答テキストなし)" }]);
        setProps((r.proposals ?? []).map((p: Prop) => ({ ...p })));
      }
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }

  async function apply(i: number) {
    const p = props[i];
    const r = await fetch("/api/chat/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: p.tool, input: p.input }) }).then((x) => x.json());
    if (r.error) { alert("適用失敗: " + r.error); return; }
    setProps((ps) => ps.map((x, j) => (j === i ? { ...x, applied: true, appliedId: r.id } : x)));
  }

  async function publish(i: number, gameId: string) {
    const r = await fetch("/api/chat/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId }) }).then((x) => x.json());
    if (r.error) { alert("確定失敗: " + r.error); return; }
    setProps((ps) => ps.map((x, j) => (j === i ? { ...x, published: true } : x)));
  }

  return (
    <div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}><Link href="/admin">← 管理</Link></p>
      <h1>AI入力（段階A・グローバル）</h1>
      <p className="muted">現状を読み、変更は「提案」で返します。<b>適用</b>＝AIの下書き(履歴に積むが公開は不変)、<b>確定</b>＝公開(games)へ反映。</p>

      <div className="chatlog">
        {msgs.map((m, i) => (
          <div key={i} className={`chatmsg ${m.role}`}>
            <span className="who">{m.role === "user" ? "あなた" : "AI"}</span>
            <div className="bubble">{m.content}</div>
          </div>
        ))}
        {loading && <div className="muted">AIが考えています…</div>}
        {error && <div className="loss">エラー: {error}</div>}
      </div>

      {props.length > 0 && (
        <div className="proposals">
          <h2>提案</h2>
          {props.map((p, i) => {
            const gid = gameIdOf(p);
            return (
              <div key={i} className="proposal">
                <div><b>{p.tool}</b>{gid ? `（${gid}）` : ""}</div>
                <details><summary>開発用JSON</summary><pre>{JSON.stringify(p.input, null, 2)}</pre></details>
                {!p.applied ? (
                  <button onClick={() => apply(i)}>適用（下書き）</button>
                ) : (
                  <div className="win">適用済（下書き）
                    {gid && <> ・ <a href={`/games/${gid}?preview=1`} target="_blank" rel="noreferrer">プレビュー（試合画面）</a></>}
                    {gid && !p.published && <button onClick={() => publish(i, gid)}>確定（公開）</button>}
                    {p.published && <b className="win"> 確定済</b>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="chatinput">
        <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} placeholder="例: G20260607 の出欠を教えて / 6/7の区分を東葛Bリーグにして"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); }} />
        <button onClick={send} disabled={loading}>送信 (Ctrl+Enter)</button>
      </div>
    </div>
  );
}
