/**
 * Live 音声入力のセッション発行: 一時クライアントシークレットを発行し、プロバイダ別の接続情報(LiveSessionInfo)を返す。
 * APIキーはブラウザへ出さない。セッション設定(モデル・語彙ヒント・言語・遅延)はここで焼き込む。
 * 補正AIは通さない(Live は生テキスト運用。補正の要否は voice_transcripts の記録を見て後で判断する)。
 * env: LIVE_STT_MODEL(既定 gpt-live-transcribe) / LIVE_STT_DELAY(minimal|low|medium|high|xhigh・既定 low) /
 *      LIVE_STT_KEYWORDS=off で keywords ヒントを送らない(ヒント有無の比較用)。
 */
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { voiceHints, STT_PROMPT } from "@/lib/ai/voice-hints";
import type { LiveSessionInfo } from "@/lib/live-stt/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SAMPLE_RATE = 24000; // OpenAI Realtime の audio/pcm は 24kHz
const DELAYS = ["minimal", "low", "medium", "high", "xhigh"] as const;
type Delay = (typeof DELAYS)[number];

let client: OpenAI | null = null;
const getClient = (): OpenAI => (client ??= new OpenAI());

export async function POST(req: Request) {
  try {
    if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "音声入力にはOpenAI APIキーが必要です" }, { status: 400 });
    const body = (await req.json().catch(() => ({}))) as { gameId?: unknown };
    const gameId = body.gameId;
    if (typeof gameId !== "string" || !gameId) return NextResponse.json({ error: "対象試合が指定されていません" }, { status: 400 });

    const { keywords } = await voiceHints(gameId);
    const useKeywords = process.env.LIVE_STT_KEYWORDS !== "off";
    const model = process.env.LIVE_STT_MODEL ?? "gpt-live-transcribe";
    const delay: Delay = DELAYS.includes(process.env.LIVE_STT_DELAY as Delay) ? (process.env.LIVE_STT_DELAY as Delay) : "low";

    // turn_detection は null 必須(gpt-live-transcribe は非対応=指定すると 400)。区切りはクライアントの commit。
    const secret = await getClient().realtime.clientSecrets.create({
      expires_after: { anchor: "created_at", seconds: 60 }, // 接続開始にだけ使う(実測: 期限後も接続済みセッションは継続)
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: SAMPLE_RATE },
            transcription: { model, prompt: STT_PROMPT, languages: ["ja"], delay, ...(useKeywords ? { keywords } : {}) },
            turn_detection: null,
          },
        },
      },
    } as OpenAI.Realtime.ClientSecretCreateParams);

    const info: LiveSessionInfo = {
      provider: "openai",
      token: secret.value,
      url: "wss://api.openai.com/v1/realtime?intent=transcription",
      sampleRate: SAMPLE_RATE,
      model,
    };
    return NextResponse.json({ ...info, keywordsCount: useKeywords ? keywords.length : 0 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
