/**
 * OpenAI Realtime 文字起こし(gpt-live-transcribe)の LiveTranscriber 実装。ブラウザ専用。
 * 接続: WebSocket + 一時クライアントシークレット(subprotocol 認証)。セッション設定は発行時にサーバが焼き込む。
 * 実測(2026-10-02): gpt-live-transcribe は turn_detection 非対応(server_vad 指定は 400)=区切りは手動 commit。
 *   delta は commit 前から item_id 単位で届き、completed は commit 後に届く。
 */
import type { LiveSessionInfo, LiveTranscriber, LiveTranscriberEvents } from "./types";
import { resample, floatToPcm16, bytesToBase64 } from "./pcm";
import { createLiveOrdering } from "./ordering";

/** 送信の粒度(~100ms)。細かすぎると WS メッセージが増え、粗いと途中表示が遅れる */
const SEND_MS = 100;
/** 空バッファの commit はエラーになるが無害(区切り判定と音声送信のタイミング差で起こりうる)ので無視する */
const IGNORABLE_ERRORS = new Set(["input_audio_buffer_commit_empty"]);

export function createOpenAiTranscriber(info: Extract<LiveSessionInfo, { provider: "openai" }>, ev: LiveTranscriberEvents): LiveTranscriber {
  const order = createLiveOrdering();
  let ws: WebSocket | null = null;
  let dead = false; // abort/致命エラー後はイベントを出さない
  let closing = false; // close() 中の切断は正常終了扱い
  let awaitingCommits = 0; // commit 送信済み・committed 未受信の数(close 時の待ち合わせ用)
  let buf: Float32Array[] = [];
  let bufLen = 0;
  let onSettled: (() => void) | null = null;

  const settled = () => awaitingCommits === 0 && !order.pending();
  const emitFinals = (texts: string[]) => { if (!dead) for (const t of texts) ev.onFinal(t); };
  const emitPartial = () => { if (!dead) ev.onPartial(order.partial()); };
  const fail = (msg: string) => {
    if (dead) return;
    dead = true;
    ev.onError(msg);
    try { ws?.close(); } catch { /* 切断済みなら無害 */ }
  };

  function flush() {
    if (!ws || ws.readyState !== WebSocket.OPEN || bufLen === 0) return;
    const all = new Float32Array(bufLen);
    let o = 0;
    for (const b of buf) { all.set(b, o); o += b.length; }
    buf = []; bufLen = 0;
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bytesToBase64(floatToPcm16(all)) }));
  }

  function onMessage(raw: string) {
    let e: { type?: string; item_id?: string; delta?: string; transcript?: string; error?: { code?: string; message?: string } };
    try { e = JSON.parse(raw); } catch { return; }
    switch (e.type) {
      case "conversation.item.input_audio_transcription.delta":
        if (e.item_id) { order.delta(e.item_id, e.delta ?? ""); emitPartial(); }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (e.item_id) { emitFinals(order.completed(e.item_id, e.transcript ?? "")); emitPartial(); }
        break;
      case "conversation.item.input_audio_transcription.failed":
        if (e.item_id) { emitFinals(order.failed(e.item_id)); emitPartial(); }
        break;
      case "input_audio_buffer.committed":
        awaitingCommits = Math.max(0, awaitingCommits - 1);
        if (e.item_id) order.delta(e.item_id, ""); // delta が来ない(無音)item も並びに登録して確定待ちにする
        break;
      case "error":
        if (e.error?.code && IGNORABLE_ERRORS.has(e.error.code)) { awaitingCommits = Math.max(0, awaitingCommits - 1); break; }
        fail(`文字起こしエラー: ${e.error?.message ?? "不明なエラー"}`);
        break;
    }
    if (onSettled && settled()) onSettled();
  }

  return {
    connect() {
      return new Promise<void>((resolve, reject) => {
        const sock = new WebSocket(info.url, ["realtime", `openai-insecure-api-key.${info.token}`]);
        ws = sock;
        let opened = false;
        sock.onopen = () => { opened = true; resolve(); };
        sock.onmessage = (m) => onMessage(typeof m.data === "string" ? m.data : "");
        sock.onclose = () => {
          if (!opened) { reject(new Error("文字起こしサーバに接続できませんでした")); return; }
          if (!closing) fail("文字起こしの接続が切れました");
          onSettled?.();
        };
      });
    },
    pushAudio(samples, inputRate) {
      if (dead) return;
      const s = resample(samples, inputRate, info.sampleRate);
      buf.push(s); bufLen += s.length;
      if (bufLen >= (info.sampleRate * SEND_MS) / 1000) flush();
    },
    commit() {
      if (dead || !ws || ws.readyState !== WebSocket.OPEN) return;
      flush();
      awaitingCommits++;
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    },
    close(timeoutMs = 10_000) {
      closing = true;
      return new Promise<void>((resolve) => {
        const done = () => { onSettled = null; clearTimeout(t); try { ws?.close(); } catch { /* 無害 */ } resolve(); };
        const t = setTimeout(done, timeoutMs);
        if (dead || !ws || ws.readyState !== WebSocket.OPEN || settled()) { done(); return; }
        onSettled = () => { if (settled() || !ws || ws.readyState !== WebSocket.OPEN) done(); };
      });
    },
    abort() {
      dead = true; closing = true;
      try { ws?.close(); } catch { /* 無害 */ }
    },
  };
}
