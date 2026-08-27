/** [診断・一回きり] 音声パイプラインの閉ループ実測: 既知テキスト→TTS合成音声→STT(本番同一設定)→補正→期待文と比較。
 * 実機の誤認識事例(2026-08-08 ユーザー実測: 高橋→大島・中村→おりきり・中国語化 等)の再現条件に近い「短い発話クリップ」で検証する。
 * 実行: node --env-file=.env.local --import tsx scripts/check_voice_pipeline.ts */
import OpenAI from "openai";
import { listPlayers } from "../lib/ops/players";
import { correctTranscript, BASEBALL_TERMS } from "../lib/ai/voice";
import { getClient as getMongo } from "../lib/db/mongo";

const client = new OpenAI();

// ユーザーが実際に口述した内容(自然文)。3行目相当は実機で中国語化した断片の元とみられる独立フレーズも含む
const LINES = [
  "一番、山本、レフトツーベース、ランナー二塁。",
  "二番、高橋、フォアボール、ランナー一、二塁。",
  "三番、中村、センターフライ。ワンアウト、ランナー一、二塁。",
  "四番、西野、見逃し三振。ツーアウト、ランナー一、二塁。",
  "ツーアウト、ランナー一、二塁。",
  "五番、田村、ピッチャーフライ、スリーアウトチェンジ。",
];

async function main(): Promise<void> {
  const players = await listPlayers();
  const dict = players.map((p) => p.name);
  dict.push("相手チーム");
  // route と同じ keywords 組み立て(フルネーム+姓+野球用語)
  const keywords = [...new Set(
    [...dict, ...dict.map((n) => n.split(/\s+/)[0]), ...BASEBALL_TERMS]
      .map((k) => k.replace(/[<>\r\n]/g, "").trim())
      .filter((k) => k.length > 0),
  )];

  for (const line of LINES) {
    const speech = await client.audio.speech.create({ model: "gpt-4o-mini-tts", voice: "alloy", input: line, response_format: "mp3" });
    const buf = Buffer.from(await speech.arrayBuffer());
    const stt = await client.audio.transcriptions.create({
      file: new File([buf], "line.mp3", { type: "audio/mpeg" }),
      model: process.env.STT_MODEL ?? "gpt-transcribe",
      prompt: "草野球チームN-KINGSの試合結果を口述したメモ。選手名、野球用語、「1回表」「ランナー一二塁」のような表現を含む日本語の独り言。",
      keywords,
      languages: ["ja"],
    } as unknown as OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming);
    const raw = (stt.text ?? "").trim();
    const { text, corrections } = await correctTranscript(raw, dict);
    console.log("正 :", line);
    console.log("STT:", raw);
    console.log("補正:", text, corrections.length ? ` [${corrections.map((c) => `${c.heard}→${c.corrected}`).join("、")}]` : "");
    console.log("---");
  }
  await (await getMongo()).close();
}
main().catch((e) => { console.error(e); process.exit(1); });
