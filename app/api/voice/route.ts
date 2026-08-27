/**
 * 音声入力: 録音ファイル → STT(gpt-transcribe + keywords/languagesヒント) → 補正AI(誤認識の復元) → テキスト返却。
 * リアルタイムではなくバッチ。返したテキストはクライアントがノートへ挿入し、以降は既存フロー
 * (編集→AI集計→下書き→確定)に乗る=ノートが正本・レビュー面である構造は変えない。
 * STTモデルは gpt-transcribe(2026-08時点の推奨): keywords(選手名+野球用語の明示ヒント)と languages:["ja"] を
 * 渡せる=短い発話チャンクでも語彙が誘導され、言語ドリフト(中国語化)も抑止される。実測(2026-08-08)で
 * ヒント無し mini-transcribe は短チャンクの固有名詞・用語が崩壊したための対処。
 */
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { listPlayers } from "@/lib/ops/players";
import { loadGame } from "@/lib/db/games";
import { correctTranscript, BASEBALL_TERMS } from "@/lib/ai/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

// 録音は数分想定(20MBあれば十分)。巨大アップロードはSTT側のタイムアウト/失敗になるだけなので入口で弾く。
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

// クライアントは遅延シングルトン(キー未設定環境の import を壊さない。lib/ai/openai.ts と同じ理由)。
let client: OpenAI | null = null;
const getClient = (): OpenAI => (client ??= new OpenAI());

export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "音声入力にはOpenAI APIキーが必要です" }, { status: 400 });
    const form = await req.formData();
    const audio = form.get("audio");
    const gameId = form.get("gameId");
    if (!(audio instanceof File)) return NextResponse.json({ error: "音声ファイルがありません" }, { status: 400 });
    if (typeof gameId !== "string" || !gameId) return NextResponse.json({ error: "対象試合が指定されていません" }, { status: 400 });
    if (audio.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: "音声が大きすぎます（上限20MB）。短く区切って録音してください" }, { status: 400 });

    // 辞書: 全選手名(助っ人含む) + この試合の相手チーム名(あれば)。名前だけ渡す=本文にIDを混入させない。
    const players = await listPlayers();
    const dict = players.map((p) => p.name);
    const doc = await loadGame(gameId);
    if (doc?.game.opponent) dict.push(doc.game.opponent);

    // keywords ヒント: 選手のフルネーム+姓(口述は姓が主)+野球用語。制約(1語1行・<>や改行を含めない)に合わせて浄化。
    const keywords = [...new Set(
      [...dict, ...dict.map((n) => n.split(/\s+/)[0]), ...BASEBALL_TERMS]
        .map((k) => k.replace(/[<>\r\n]/g, "").trim())
        .filter((k) => k.length > 0),
    )];

    // STT。keywords/languages は gpt-transcribe の新パラメータでSDK型が未追随のため型を広げて渡す。
    // languages は旧 language と排他(両方送らない)。chunking_strategy は gpt-transcribe 非対応のため送らない。
    const stt = await getClient().audio.transcriptions.create({
      file: audio,
      model: process.env.STT_MODEL ?? "gpt-transcribe",
      prompt: "草野球チームN-KINGSの試合結果を口述したメモ。選手名、野球用語、「1回表」「ランナー一二塁」のような表現を含む日本語の独り言。",
      keywords,
      languages: ["ja"],
    } as unknown as OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming);
    const raw = (stt.text ?? "").trim();
    if (!raw) return NextResponse.json({ text: "", corrections: [], raw: "" });

    const { text, corrections } = await correctTranscript(raw, dict);
    return NextResponse.json({ text, corrections, raw });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
