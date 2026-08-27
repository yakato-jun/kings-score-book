"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useUnsavedGuard } from "@/components/useUnsavedGuard";
import { useDialog } from "@/components/DialogProvider";
import { createSegmenter } from "@/lib/voice-segmenter";

type Flag = { inning: number; half: "top" | "bottom"; order: number; detail: string };
type Status = { status?: string; flags?: Flag[]; clarification?: string | null; calls?: number; hasDraft?: boolean; error?: string };
type VoiceCorrection = { heard: string; corrected: string };
const POLL_MS = 2000;
const CAP_MS = 200_000;

export default function NoteClient({ gameId, initialNote, seedError, published }: { gameId: string; initialNote: string; seedError?: string | null; published?: boolean }) {
  const [note, setNote] = useState(initialNote);
  const [status, setStatus] = useState("idle");
  const [flags, setFlags] = useState<Flag[]>([]);
  const [clarification, setClarification] = useState<string | null>(null);
  const [calls, setCalls] = useState(0);
  const [hasDraft, setHasDraft] = useState(false);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const saveT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = status === "pending" || status === "running";
  const router = useRouter();
  const { confirm } = useDialog();
  // 未保存/保存失敗のままの離脱を警告(保存済み以外は dirty)。
  useUnsavedGuard(saveState !== "saved");

  // ---- 音声入力(逐次バッチ): 録音セッション中、無音(~1.8秒)を検知するたびに、そこまでの発話を
  // 1チャンクとして即 /api/voice(STT+辞書補正)へ送り、補正済みテキストをノートに逐次追記する。
  // 「見えている字=実際に入った字」を守るため、別エンジンのプレビューは使わない(本番と同じSTT+補正のみ)。
  // 集計(busy)とは独立に使える。 ----
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "processing">("idle");
  const [recSec, setRecSec] = useState(0);
  const [voiceMsg, setVoiceMsg] = useState(""); // エラー/聞き取り失敗の帯(×か次の録音開始で消える)
  const [voiceCorr, setVoiceCorr] = useState<VoiceCorrection[]>([]); // 補正一覧の帯(セッション中は累積・誤補正を人が一目で捕まえる)
  const [pendingCount, setPendingCount] = useState(0); // アップロード待ち行列の残件数(停止後の「残りN」表示用)
  const streamRef = useRef<MediaStream | null>(null);
  const recT = useRef<ReturnType<typeof setInterval> | null>(null);
  // getUserMedia 待ち(権限プロンプト)中は voiceState が "idle" のままなので、多重起動は ref で同期的に守る。
  // 破ると2本目のストリームが streamRef を上書きし、1本目が永久にマイク点灯のまま残る(実バグ指摘)。
  const voiceStartingRef = useRef(false);
  // 権限プロンプト中にアンマウントされると、クリーンアップ effect は空の streamRef に対して走り終えている。
  // 解決後に掴んだストリームは alive を見て即解放する(これもマイク残留の実バグ指摘への対処)。
  const aliveRef = useRef(true);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // カーソル挿入: セッション開始時のカーソル位置を挿入ストリームの起点として捕捉し、チャンクごとに進める。
  // 一度もカーソルを置いていない場合(未フォーカスの selectionStart=0 を「先頭に挿入したい」と誤読しない)は末尾追記。
  const noteAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const voicePosRef = useRef<number | null>(null); // null=末尾追記モード
  const cursorTouchedRef = useRef(false);
  // --- 逐次バッチ用の内部状態(全て ref: 100ms周期の解析ループから React 再レンダーを起こさないため) ---
  // 現セグメントの MediaRecorder と「停止時にアップロードするか」。timeslice は使わない(途中チャンクは単体で
  // 有効なコンテナにならない)ので、セグメント確定のたびに stop→同じ stream で新しい MediaRecorder を作る。
  const segRef = useRef<{ rec: MediaRecorder; upload: boolean } | null>(null);
  const mimeRef = useRef<string | undefined>(undefined); // セッションで選んだ録音形式(セグメント再作成時に使い回す)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null); // 音量解析用(セッション終了時に切断)
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null); // 解析バッファは使い回す(100ms毎の確保を避ける)。型引数は getByteTimeDomainData の要求(SharedArrayBuffer不可)に合わせる
  const meterT = useRef<ReturnType<typeof setInterval> | null>(null); // 解析ループ(~100ms)。メーター描画と区切り判定を兼ねる
  const lastTickRef = useRef(0); // 前回解析時刻。setInterval のドリフト/バックグラウンド節流でも実経過msを segmenter に渡す
  const segmenterRef = useRef(createSegmenter()); // 発話区切りの状態機械(純ロジック=lib/voice-segmenter.ts)
  const sessionRef = useRef(false); // 録音セッション中か(行列完了コールバックが idle へ落としてよいかの判定に使う)
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve()); // FIFO: promise 連結で逐次1件ずつ=発話順の追記を構造で保証
  const pendingRef = useRef(0); // 残件数の正本(state はその写し。コールバックの stale クロージャを避ける)
  const meterRef = useRef<HTMLSpanElement | null>(null); // 音量メーターのDOM。毎フレームの再レンダーでなく直接更新する

  // 録音状態の可聴フィードバック(レコーダー流のビープ)。音は補助なので失敗は握りつぶす。
  async function beep(freq: number, ms: number) {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = (audioCtxRef.current ??= new Ctx());
      if (ctx.state === "suspended") await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = freq; gain.gain.value = 0.08;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      await new Promise((r) => setTimeout(r, ms));
      osc.stop(); osc.disconnect(); gain.disconnect();
    } catch { /* 可聴フィードバックの失敗で録音を止めない */ }
  }

  // マイクを確実に解放する(停止時・録音中のページ離脱時)。
  function stopTracks() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }
  // 音量解析グラフの切断(セッション終了時)。AudioContext 自体はビープと共用なので閉じない(閉じるのはアンマウント時)。
  function teardownAudioGraph() {
    try { sourceRef.current?.disconnect(); } catch { /* 切断済みなら無害 */ }
    sourceRef.current = null;
    analyserRef.current = null;
    meterBufRef.current = null;
  }
  // 録音中のアンマウント: ハンドラを外してから止める(アンマウント後の追記/アップロードをしない)＋マイク解放。
  // 待ち行列の未処理分は破棄される(uploadOne 冒頭の aliveRef ガード=アンマウント後に setNote しない)。
  // mount 時に aliveRef を true へ戻す: StrictMode(devの mount→cleanup→再mount)で false が残ると
  // getUserMedia 成功直後の防御が誤発動し、音声入力が永久に始まらない(レビュー実バグ指摘)。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
    aliveRef.current = false;
    sessionRef.current = false;
    if (recT.current) clearInterval(recT.current);
    if (meterT.current) clearInterval(meterT.current); // メーター/区切り判定ループの停止
    const seg = segRef.current;
    segRef.current = null;
    if (seg && seg.rec.state !== "inactive") {
      seg.rec.onstop = null; seg.rec.ondataavailable = null; // 現セグメントの確定処理(アップロード)を走らせない
      try { seg.rec.stop(); } catch { /* 解放は下の stopTracks が担う */ }
    }
    teardownAudioGraph();
    stopTracks();
    void audioCtxRef.current?.close().catch(() => { /* 破棄失敗は無害 */ });
    };
  }, []);

  // 残件数の増減。正本は ref(解析ループ/行列コールバックから同期参照)、state は表示用の写し。
  function bumpPending(d: number) {
    pendingRef.current += d;
    if (aliveRef.current) setPendingCount(pendingRef.current);
  }

  // 新しいセグメントの MediaRecorder を作って録音開始(同じ stream を使い回す)。失敗時 false。
  // ハンドラは onstop 内で自分から外す=セグメント切替(stop→新規start)の隙間でリークしない。
  function startSegment(): boolean {
    const stream = streamRef.current;
    if (!stream) return false;
    let rec: MediaRecorder;
    try { rec = mimeRef.current ? new MediaRecorder(stream, { mimeType: mimeRef.current }) : new MediaRecorder(stream); }
    catch { return false; }
    const chunks: Blob[] = []; // セグメント局所のバッファ(共有 ref にしない=セグメント間の混入を構造で防ぐ)
    const seg = { rec, upload: false };
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    rec.onstop = () => {
      rec.ondataavailable = null; rec.onstop = null; // 使い終えたハンドラを自分で外す(リーク防止)
      if (seg.upload) enqueueUpload(new Blob(chunks, { type: rec.mimeType || mimeRef.current || "audio/webm" }));
      // upload=false(無声セグメント)は捨てるだけ。finalizeSegment がカウントも増やしていないので何もしない
    };
    try { rec.start(); } catch { return false; }
    segRef.current = seg;
    return true;
  }

  // 現セグメントを確定する(stop→onstop でアップロード行列へ)。upload=false は無声セグメントの捨て。
  // 残件カウントは stop() の前に増やす: onstop は非同期なので、停止直後の「残りN」表示と idle 判定を正確にするため。
  function finalizeSegment(upload: boolean) {
    const seg = segRef.current;
    segRef.current = null;
    if (!seg || seg.rec.state === "inactive") return;
    seg.upload = upload;
    if (upload) bumpPending(+1);
    try { seg.rec.stop(); } catch { if (upload) bumpPending(-1); /* stop できない=データも来ない。カウントを戻す */ }
  }

  // 解析ループ(~100ms): RMS計算→メーター直接更新→発話区切り判定。ここから React 再レンダーは起こさない
  // (毎tickの setState は既存UI全体を巻き込む再レンダー嵐になるため、メーターは DOM 直接更新)。
  function meterTick() {
    const an = analyserRef.current;
    if (!an) return;
    const buf = (meterBufRef.current ??= new Uint8Array(an.fftSize));
    an.getByteTimeDomainData(buf); // byte版は iOS Safari 含め広く対応(float版より互換が固い)
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    updateMeter(rms);
    // dt は実測: setInterval のドリフトやバックグラウンド節流でも無音時間を正しく積算する
    const now = performance.now();
    const dt = now - lastTickRef.current;
    lastTickRef.current = now;
    if (segmenterRef.current.push(rms, dt) === "cut") {
      finalizeSegment(true); // cut=有声が minVoiceMs 以上あった時のみ返る契約なので常にアップロード対象
      if (!startSegment()) {
        // まず起きないが、続きが録れないまま黙って回すのが最悪(話した内容が消える)のでセッションを閉じて伝える
        closeSession();
        setVoiceMsg("録音を継続できませんでした。再度お試しください");
      }
    }
  }

  // 音量メーター(5本バー)の直接更新。点灯本数は RMS の段階(threshold=0.03 を2本目に対応させ、下1本は「拾えている」表示)。
  function updateMeter(rms: number) {
    const el = meterRef.current;
    if (!el) return;
    const lit = rms >= 0.2 ? 5 : rms >= 0.12 ? 4 : rms >= 0.07 ? 3 : rms >= 0.03 ? 2 : rms >= 0.012 ? 1 : 0;
    const bars = el.children;
    for (let i = 0; i < bars.length; i++) (bars[i] as HTMLElement).classList.toggle("on", i < lit);
  }

  // 音声テキストの挿入: 挿入点(voicePosRef)へ流し込み、チャンクごとに挿入点を進める。
  // 挿入点はユーザーのカーソル移動に追従する(textareaのonSelect/onKeyUpがセッション中にvoicePosRefを更新)。
  // 一度もカーソルを置いていない(cursorTouchedRef=false)なら従来どおり末尾へ追記。
  // 挿入後はDOMのカーソルも挿入末尾へ進める(連続口述が自然に繋がる+制御コンポーネントの値更新で
  // キャレットが末尾へ飛ぶブラウザ挙動の抑止)。この programmatic な選択が発火させる onSelect は
  // 同じ位置を voicePosRef に書き戻すだけなので無害(フラグでの区別は不要)。
  // 挿入位置が見える所まで入力欄をスクロールする。末尾付近は最下部へ正確に、
  // 途中挿入は行番号×行高の近似で挿入行を可視域へ(折り返し分は近似=実用十分)。focusは奪わない(スマホでキーボードを出さない)。
  function scrollNoteToPos(ta: HTMLTextAreaElement, pos: number) {
    if (pos >= ta.value.length - 1) { ta.scrollTop = ta.scrollHeight; return; }
    const line = ta.value.slice(0, pos).split("\n").length;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, line * lh - ta.clientHeight * 0.6);
  }

  function insertVoiceText(text: string) {
    setNote((prev) => {
      const pos = voicePosRef.current == null ? prev.length : Math.min(voicePosRef.current, prev.length);
      const before = prev.slice(0, pos);
      const after = prev.slice(pos);
      const head = before === "" || before.endsWith("\n") ? "" : "\n"; // 行の途中に割り込まない
      const tail = after === "" || after.startsWith("\n") ? "" : "\n"; // 後続行と融合させない
      const follow = voicePosRef.current != null;
      const next = pos + head.length + text.length + tail.length;
      if (follow) voicePosRef.current = next;
      setTimeout(() => { // 再レンダー後にDOMへ反映(blur中でも選択位置は保持される。focusは奪わない)
        const ta = noteAreaRef.current;
        if (!ta) return;
        if (follow) { try { ta.setSelectionRange(next, next); } catch { /* 非対応環境は voicePosRef が正のまま動く */ } }
        scrollNoteToPos(ta, next); // 挿入結果を目で確認できるように追従スクロール
      }, 0);
      return before + head + text + tail + after;
    });
  }

  // セッション共通の後始末(タイマ停止・解析グラフ切断・マイク解放)。最終セグメントの確定は呼び出し側で済ませておく。
  // 残件があれば processing(行列が空になったら enqueueUpload 側で idle へ落とす)。
  function closeSession() {
    sessionRef.current = false;
    if (recT.current) { clearInterval(recT.current); recT.current = null; }
    if (meterT.current) { clearInterval(meterT.current); meterT.current = null; }
    teardownAudioGraph();
    stopTracks(); // 停止と同時にマイク解放(アップロード完了を待たない)
    setVoiceState(pendingRef.current > 0 ? "processing" : "idle");
  }

  async function startVoice() {
    if (voiceStartingRef.current || voiceState !== "idle") return; // 権限プロンプト中の連打防御(上の ref コメント参照)
    voiceStartingRef.current = true;
    setVoiceMsg(""); setVoiceCorr([]); // 前回の帯は次の録音開始で消える
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch { setVoiceMsg("マイクの使用が許可されていません"); voiceStartingRef.current = false; return; }
    if (!aliveRef.current) { stream.getTracks().forEach((t) => t.stop()); return; } // 待ち中に画面遷移→即解放
    streamRef.current = stream;
    // マイク切断・権限剥奪の監視(レビュー指摘): 黙って「録音中」を続けるのが最悪(発話が無記録で消え続ける)。
    // 「画面の状態=真実」= 異常は明示停止に落として伝える。※track.stop()(正常停止)では ended は発火しない。
    stream.getTracks().forEach((t) => {
      t.onended = () => {
        if (!sessionRef.current) return;
        finalizeSegment(segmenterRef.current.hadVoice()); // 直前までの発話を可能な範囲で救う(録音機が死んでいれば内部で無害に諦める)
        closeSession();
        setVoiceMsg("マイクが切断されたため録音を停止しました");
      };
    });
    // 対応形式を順に選ぶ(iOS Safari は webm 不可 → mp4)。セグメント再作成でも同じ形式を使う。
    mimeRef.current = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
    // 音量解析(AnalyserNode): メーター表示と発話区切りの両方に使う。ローカル解析のみ=APIコストゼロ。
    // これが無いと逐次方式が成立しない(区切れない)ので、失敗したらセッションを開始しない。
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) throw new Error("no AudioContext");
      const ctx = (audioCtxRef.current ??= new Ctx());
      if (ctx.state === "suspended") await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024; // 約21ms窓(48kHz)。RMS用途には十分で計算も軽い
      src.connect(an); // destination には繋がない=スピーカーへは出さない(ハウリング防止)
      sourceRef.current = src;
      analyserRef.current = an;
    } catch { teardownAudioGraph(); stopTracks(); setVoiceMsg("この端末では録音を利用できません"); voiceStartingRef.current = false; return; }
    await beep(880, 120); // 開始ビープは鳴り終えてから録音開始=ビープ自体をマイクに混入させない(セグメント切替では鳴らさない)
    if (!aliveRef.current) { teardownAudioGraph(); stopTracks(); voiceStartingRef.current = false; return; } // ビープ中の遷移にも防御
    segmenterRef.current.reset(); // 前セッションの状態を持ち越さない
    if (!startSegment()) { teardownAudioGraph(); stopTracks(); setVoiceMsg("この端末では録音を利用できません"); voiceStartingRef.current = false; return; }
    // 挿入ストリームの起点=このセッション開始時のカーソル位置(カーソル未使用なら末尾追記)
    voicePosRef.current = cursorTouchedRef.current && noteAreaRef.current ? noteAreaRef.current.selectionStart : null;
    sessionRef.current = true;
    setRecSec(0); // 録音経過タイマーはセッション通算(セグメント切替でリセットしない)
    recT.current = setInterval(() => setRecSec((s) => s + 1), 1000);
    lastTickRef.current = performance.now();
    meterT.current = setInterval(meterTick, 100); // segmenter の想定呼び出し間隔(~100ms)に合わせる
    setVoiceState("recording");
    voiceStartingRef.current = false;
  }

  function stopVoice() {
    if (!sessionRef.current) return; // 二重停止の防御(キー操作とタップの競合)
    // 最終セグメントの確定: 有声が実在した時だけアップロード(無声のみはSTTに投げない=コストと誤認識の抑制)。
    const upload = segmenterRef.current.hadVoice();
    segmenterRef.current.reset();
    finalizeSegment(upload);
    closeSession();
    void beep(440, 120); // 停止ビープ(録音停止後に鳴らす=混入しない)。開始/停止の各1回のみ
  }

  // ショートカット: R=録音の開始/停止トグル(テキスト入力中は発動しない)・Esc=停止。スマホは従来どおりタップ。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable);
      if (e.key === "Escape") {
        if (voiceState === "recording") { e.preventDefault(); stopVoice(); }
        return;
      }
      if ((e.key === "r" || e.key === "R") && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (voiceState === "idle") void startVoice();
        else if (voiceState === "recording") stopVoice();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceState]);

  // アップロード待ち行列: promise 連結の FIFO で逐次1件ずつ処理する。並列アップロードしない=
  // 完了順の入れ替わりが起きず、発話順にノートへ追記されることを構造で保証する(順序ガードのフラグ管理を持たない)。
  // 録音中も行列は流れる(=話すと数秒後に文字が生えるライブ感の本体)。
  function enqueueUpload(blob: Blob) {
    uploadChainRef.current = uploadChainRef.current
      .then(() => uploadOne(blob))
      .catch(() => { /* 1件の失敗(uploadOne 内で帯に表示済み)で行列を止めない */ })
      .finally(() => {
        bumpPending(-1);
        // 行列が空になり、かつ録音セッションも終わっていたら processing→idle(停止後の残件待ちの終端)。
        if (aliveRef.current && pendingRef.current === 0 && !sessionRef.current) setVoiceState("idle");
      });
  }

  // 1件(1セグメント)のアップロード→ノート末尾へ追記。失敗は帯に出すだけでセッションは止めない。
  async function uploadOne(blob: Blob) {
    if (!aliveRef.current) return; // アンマウント後の残件は破棄(setNote しない)
    try {
      // サーバ上限(20MB)の事前チェック=全量アップロードしてから弾かれる無駄を避ける
      if (blob.size > 20 * 1024 * 1024) { setVoiceMsg("録音が長すぎます（上限20MB）。分けて録音してください"); return; }
      const fd = new FormData();
      fd.append("audio", new File([blob], blob.type.includes("mp4") ? "voice.m4a" : "voice.webm", { type: blob.type }));
      fd.append("gameId", gameId);
      const res = await fetch("/api/voice", { method: "POST", body: fd });
      if (!aliveRef.current) return; // fetch 待ちの間にアンマウントされていたら破棄
      let r: { error?: string; text?: string; corrections?: VoiceCorrection[] };
      // プロキシ等が非JSON(413/502のHTML)を返しても生のパース例外を帯に出さない
      try { r = await res.json(); }
      catch { setVoiceMsg(res.status >= 500 ? "サーバーエラーが発生しました。少し待って再度お試しください" : `アップロードに失敗しました（HTTP ${res.status}）`); return; }
      if (!aliveRef.current) return;
      if (r.error) { setVoiceMsg(String(r.error)); return; }
      if (!r.text) { setVoiceMsg("音声を聞き取れませんでした"); return; }
      // カーソル位置(セッション開始時に捕捉した挿入ストリーム)へ挿入。既存の debounce 自動保存に乗る
      insertVoiceText(r.text);
      // 補正はセッション中に累積(セグメントごとに上書きすると前の補正が見えなくなる)。同一ペアは重複排除。
      if (Array.isArray(r.corrections) && r.corrections.length > 0) {
        const add = r.corrections;
        setVoiceCorr((prev) => {
          const seen = new Set(prev.map((c) => `${c.heard}\u0000${c.corrected}`));
          const fresh = add.filter((c) => {
            const k = `${c.heard}\u0000${c.corrected}`;
            if (seen.has(k)) return false;
            seen.add(k); // 同一レスポンス内の重複も1件に
            return true;
          });
          return fresh.length > 0 ? [...prev, ...fresh] : prev;
        });
      }
    } catch (e) { if (aliveRef.current) setVoiceMsg(String(e)); }
  }

  const mmss = `${String(Math.floor(recSec / 60)).padStart(2, "0")}:${String(recSec % 60).padStart(2, "0")}`;

  // ノートをサーバへ保存(AIは呼ばない)。res.ok を検査し成否を返す(通信例外は握って false)。
  async function saveNote(): Promise<boolean> {
    try {
      const res = await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId, text: note }) });
      return res.ok;
    } catch { return false; }
  }
  // 1回保存して結果を反映。失敗時は 4秒バックオフで自動リトライ(saveT を流用＝重複タイマなし。
  // 保存中に新しい入力＝新しい debounce タイマが積まれていたら、そちらに任せて再試行は積まない)。
  async function runSave() {
    if (saveT.current) { clearTimeout(saveT.current); saveT.current = null; }
    setSaveState("saving");
    const ok = await saveNote();
    setSaveState(ok ? "saved" : "error");
    if (!ok && saveT.current == null) saveT.current = setTimeout(() => void runSave(), 4000);
  }

  // ノートの自動保存(デバウンス 800ms)。AIは呼ばない。種付けの初期値は触るまで保存しない(note===initialNote)。
  useEffect(() => {
    if (note === initialNote && saveState === "saved") return;
    setSaveState("saving");
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(() => void runSave(), 800);
    return () => { if (saveT.current) clearTimeout(saveT.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);

  function stopPoll() { if (pollT.current) { clearTimeout(pollT.current); pollT.current = null; } }
  useEffect(() => { void refresh(); return stopPoll; /* eslint-disable-next-line */ }, []);

  async function refresh(): Promise<Status> {
    try {
      const s: Status = await fetch(`/api/aggregate/status?gameId=${gameId}`).then((x) => x.json());
      setStatus(s.status ?? "idle"); setFlags(s.flags ?? []); setClarification(s.clarification ?? null); setCalls(s.calls ?? 0); setHasDraft(!!s.hasDraft);
      if (s.error) setError(s.error);
      return s;
    } catch (e) { setError(String(e)); return { status: "error" }; }
  }

  function poll(startedAt: number) {
    pollT.current = setTimeout(async () => {
      if (Date.now() - startedAt > CAP_MS) { setError("集計がタイムアウトしました"); stopPoll(); return; }
      const s = await refresh();
      const st = s.status;
      if (st === "pending" || st === "running") { poll(startedAt); return; }
      stopPoll();
      // 集計完了: 下書きができ、追加入力(clarification)が不要なら、そのままプレビューへ遷移して確認・確定へ。
      if (st === "done" && s.hasDraft && !s.clarification) router.push(`/games/${gameId}?preview=1`);
    }, POLL_MS);
  }

  async function aggregate() {
    setError(""); setFlags([]); setClarification(null);
    // 未公開の下書きがある状態での再集計＝前の下書きを破棄し、今のノートから作り直す。
    // 黙って壊さない(記録の非破壊): 必ず確認を挟む。ノート(=ユーザー入力・正本)は破棄しても残るので直して作り直せる。
    if (hasDraft) {
      const go = await confirm({ title: "AI集計結果を作り直す", body: "AI集計結果（未確定）を破棄して、今のノートから作り直します。ノートの文章はそのまま残ります。よろしいですか？", confirmLabel: "作り直す", danger: true });
      if (!go) return; // キャンセル＝中止(AI集計結果はそのまま)
    }
    // 事前保存は res.ok を検査。保存できなければ集計へ進めない(未保存のノートで集計させない)。作り直しの正本を先に確実に永続化する。
    const ok = await saveNote();
    if (!ok) { setSaveState("error"); setError("ノートの保存に失敗しました。通信を確認して再度お試しください。"); return; }
    setSaveState("saved");
    // 既存下書きを破棄してから集計＝クリーンな土台(公開版/空)から作り直す。これで公開後の差分集計(ingestDelta)が
    // 下書きへ二重適用されるのを防ぎ、公開前の全置換(ingestWholeGame)ともども「作り直し」の体験を安全に統一する。
    // ノートは discard で消えない(黙って壊さない)。破棄に失敗したら集計へ進めない。
    if (hasDraft) {
      try {
        const dr = await fetch("/api/games/discard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId }) }).then((x) => x.json());
        if (dr?.error) { setError("前のAI集計結果（未確定）の破棄に失敗しました: " + dr.error); return; }
      } catch (e) { setError("前のAI集計結果（未確定）の破棄に失敗しました: " + String(e)); return; }
      setHasDraft(false); // 破棄済み＝以降はAI集計結果なしとして集計(サーバのstatusでも後追い確認される)
    }
    try {
      const r = await fetch("/api/aggregate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId, text: note }) }).then((x) => x.json());
      if (r.error) { setError(r.error); return; }
      setStatus("running"); stopPoll(); poll(Date.now());
    } catch (e) { setError(String(e)); }
  }

  const ih = (f: Flag) => `${f.inning}回${f.half === "top" ? "表" : "裏"}#${f.order}`;
  // 要確認はプレビューの該当打席へ。そこで「承認」するか、ノートを直して再集計する(打席単位の専用編集は廃止)。
  const previewAnchor = (f: Flag) => `/games/${gameId}/text?preview=1#pa-${f.inning}-${f.half}-${f.order}`;

  // 既に未確定のAI集計結果がある(＝前回の集計が未公開)時の通知。確定/破棄はプレビュー画面へ集約しつつ、
  // 「ノートを直して作り直す」導線(=AI集計ボタン)の理由もここに画面テキストで示す(title頼みにしない=スマホで見える)。
  // ノート本文(ユーザーの入力)とAI集計結果(未確定)を言葉で区別し、破棄でノートが消える誤解を避ける。
  const draftNotice = hasDraft && (
    <div className="draftnotice">
      <span className="dn-label">未確定のAI集計結果があります（ノートの文章は残っています）。プレビューで確認して確定するか、ノートを直して「AI集計（作り直す）」を押すと作り直せます（確認あり・ノートは消えません）。</span>
      <button className="dn-act" onClick={() => router.push(`/games/${gameId}?preview=1`)}>プレビューで確認 →</button>
    </div>
  );

  // 要確認の件数は「打席単位」で数える(確定バー DraftConfirmBar の flaggedAnchors.size と一致させる)。
  // flags は理由単位(1打席に複数理由が付く)なので inning/half/order でユニーク化する。
  const flaggedPA = new Set(flags.map((f) => `${f.inning}-${f.half}-${f.order}`)).size;
  // 下書きが無い(破棄/公開後)ときは要確認一覧を出さない。リンク先の打席が消えており stale になるため。
  const flagsList = hasDraft && flags.length > 0 && (
    <div className="proposals">
      <h2>要確認（不明瞭）{flaggedPA}打席</h2>
      <p className="muted">クリックでプレビューの該当打席へ（そこで「承認」するか、ノートを直して再集計）。</p>
      <ul>{flags.map((f, i) => (
        <li key={i}><a href={previewAnchor(f)} target="_blank" rel="noreferrer">{ih(f)}</a>：{f.detail}</li>
      ))}</ul>
    </div>
  );

  return (
    <div>
      {draftNotice}
      {seedError && <div className="flagbar">{seedError}</div>}
      <textarea className="notearea" ref={noteAreaRef} value={note} onChange={(e) => setNote(e.target.value)} rows={16}
        // カーソル追従: 録音セッション中(残件処理中含む)にカーソルを動かしたら、以後のチャンクはそこへ挿入する
        onSelect={() => { cursorTouchedRef.current = true; if ((sessionRef.current || pendingRef.current > 0) && noteAreaRef.current) voicePosRef.current = noteAreaRef.current.selectionStart; }}
        onFocus={() => { cursorTouchedRef.current = true; }}
        placeholder={"形式は自由。分かる範囲で書けばAIが解析します。例:\n○月○日 △△と練習試合、後攻。7-3で勝ち。\n1回裏 1番がヒットで出塁、2番がタイムリーで先制…\n\n（全部の打席を書かなくてもOK。自分の成績の断片や、最終スコアだけでも保存できます）"} />
      <div className="notebar">
        <button onClick={aggregate} disabled={busy}>{busy ? "集計中…" : hasDraft ? "AI集計（作り直す）" : "AI集計"}</button>
        {/* 音声入力は集計と独立(busy中でも録音できる)。発話区切りの逐次バッチ方式:
            録音中も無音を検知するたびに文字起こしが走り、ノートに逐次追記される。停止後は残件の完了待ちのみ。 */}
        <button
          className={"micbtn" + (voiceState === "recording" ? " rec" : "")}
          onClick={() => { if (voiceState === "idle") void startVoice(); else if (voiceState === "recording") stopVoice(); }}
          disabled={voiceState === "processing"}
          title="ショートカット: R で録音の開始/停止、Esc で停止"
        >
          {voiceState === "recording" ? `⏹ 録音中 ${mmss}（タップで停止）` : voiceState === "processing" ? `文字起こし中…${pendingCount > 0 ? `（残り${pendingCount}）` : ""}` : "🎤 音声入力"}
        </button>
        {/* 音量メーター(録音中のみ): ローカル解析(AnalyserNode)のみ=APIコストゼロ。
            バーの点灯は meterTick が DOM を直接更新する(ref)。React 再レンダーで駆動しない(再レンダー嵐の回避)。 */}
        {voiceState === "recording" && (
          <span className="vmeter" ref={meterRef} aria-hidden="true">
            <span className="vm-bar" /><span className="vm-bar" /><span className="vm-bar" /><span className="vm-bar" /><span className="vm-bar" />
          </span>
        )}
        <span className="muted">
          {saveState === "saved" ? "保存済み" : saveState === "saving" ? "保存中…" : "⚠ 保存に失敗（自動で再試行します）"}
          {saveState === "error" && <> <button onClick={() => void runSave()} style={{ padding: "1px 8px", fontSize: "0.78rem" }}>再試行</button></>}
          {busy ? "／集計しています（このまま開いておいてください）" : calls ? `／前回 ${calls} コール` : ""}
        </span>
      </div>
      {/* 音声入力の結果帯: 補正一覧(heard→corrected)かエラー/聞き取り失敗。×か次の録音開始で消える。 */}
      {(voiceMsg || voiceCorr.length > 0) && (
        <div className="voiceband">
          <span>{voiceMsg || `補正: ${voiceCorr.map((c) => `${c.heard}→${c.corrected}`).join("、")}`}</span>
          <button className="vb-close" onClick={() => { setVoiceMsg(""); setVoiceCorr([]); }} aria-label="閉じる">×</button>
        </div>
      )}
      {/* 公開後はノートがクリアされる(原文は版履歴に凍結)。空欄を見て「入力が消えた」と不安にならないよう一言添える。 */}
      {published && !hasDraft && note.trim() === "" && (
        <p className="muted">この試合は公開済みです。入力したノートは版管理（版履歴）に保存されており、この欄が空なのは正常です。</p>
      )}
      {error && <div className="loss">エラー: {error}</div>}
      {flagsList}
      {clarification && (
        <div className="proposals">
          <h2>AIからの確認</h2>
          <p className="muted">解析が確定できなかった点です。ノートを補って再度「AI集計」してください。</p>
          <p className="clarify">{clarification}</p>
        </div>
      )}
    </div>
  );
}
