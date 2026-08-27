/**
 * 音声入力の補正レイヤ: STT結果に対し、「誤認識の復元」だけを行う。対象は
 *   (a) 辞書にある実体(選手名・相手チーム名)への復元 — 音の近い揺らぎ(山下→山田、なかむら→中村)も含む
 *   (b) 野球用語の復元(センターくらい→センターフライ、見逃したし→見逃し三振 等)
 * 文の言い換え・要約・整形・句読点の追加は一切しない(ノートが正本・レビュー面である構造を崩さないため)。
 * 辞書に無い名前(新しい助っ人等)は聞き取りのまま残す=勝手に既存選手へ同定しない。
 * 復元の確信が持てない断片(別言語化などSTTの破綻)はそのまま残す=文脈からの捏造をしない。
 * 補正一覧(heard→corrected)を必ず返し、UI側で人が誤補正を一目で捕まえられるようにする。
 */
import OpenAI from "openai";
import { parseToolArguments } from "./openai";

// 補正モデル: 実測(2026-08-08)でLunaは「山下→山田」「なかむら→中村」級の近似復元を取り逃した。
// ルミナス知見「抽出級の判断はTerra・下位の劣化は沈黙の質に出る」に一致→Terraを既定に。envで差し替え可(集計用 AI_MODEL とは独立)。
const DEFAULT_MODEL = "gpt-5.6-terra";

/** 野球の口述で頻出する用語。STTのkeywordsヒント(route)と補正の用語辞書で共用する。 */
export const BASEBALL_TERMS: string[] = [
  "ヒット", "ツーベース", "スリーベース", "ホームラン", "ランニングホームラン", "内野安打", "ポテンヒット",
  "フォアボール", "デッドボール", "三振", "見逃し三振", "空振り三振", "振り逃げ",
  "ゴロ", "フライ", "ライナー", "ファールフライ", "犠打", "犠飛", "送りバント", "スクイズ",
  "エラー", "捕球エラー", "送球エラー", "悪送球", "野選", "落球",
  "ランナー", "満塁", "盗塁", "重盗", "牽制", "タッチアップ", "ゲッツー", "ダブルプレー", "フォースアウト", "タッチアウト", "挟殺",
  "ワンアウト", "ツーアウト", "スリーアウト", "チェンジ", "アウトカウント", "無死", "一死", "二死",
  "ピッチャー", "キャッチャー", "ファースト", "セカンド", "サード", "ショート", "レフト", "センター", "ライト",
  "一塁", "二塁", "三塁", "本塁", "ホームイン", "生還", "押し出し", "ワイルドピッチ", "パスボール", "ボーク",
  "一回", "二回", "三回", "四回", "五回", "六回", "七回", "表", "裏", "先攻", "後攻", "練習試合", "リーグ戦",
];

export interface VoiceCorrection {
  heard: string;
  corrected: string;
}

// クライアントは遅延シングルトン(openai.ts と同じ理由: キー未設定環境=テスト等の import を壊さない)。
let client: OpenAI | null = null;
const getClient = (): OpenAI => (client ??= new OpenAI());

const TOOL_NAME = "correct";
// ★構造で縛る: モデルが出せるのは「置換ペアの列挙」だけ。本文への適用はコード(applyCorrections)が行うので、
//   言い換え・要約・作文は構造的に不可能(プロンプトで「一字も変えるな」と頼む方式は崩壊するため採らない)。
//   出力も全文再生成→ペア列挙になり数十トークンに縮む(コスト/レイテンシ副次効果)。
const TOOL_DESCRIPTION =
  "文字起こしの誤認識箇所の置換リストを提出する。対象: (1)辞書の選手名・チーム名への復元(音の近い揺らぎを含む) " +
  "(2)野球用語への復元(例: センターくらい→センターフライ)。辞書に無い名前・復元に確信が持てない断片(別言語化等)は挙げない。" +
  "heard は本文に実際に現れる表記をそのまま書く(現れない heard は無効になる)。補正が無ければ空配列。";
const TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    corrections: {
      type: "array",
      description: "誤認識→復元の置換ペア一覧(補正なしなら空配列)",
      items: {
        type: "object",
        properties: {
          heard: { type: "string", description: "聞き取られていた表記(本文に現れるとおりに)" },
          corrected: { type: "string", description: "復元後の表記" },
        },
        required: ["heard", "corrected"],
      },
    },
  },
  required: ["corrections"],
};

/**
 * 置換ペアを本文へ適用する(コード側=決定的)。実際に本文に現れ、適用されたペアだけを返す
 * (UIの補正一覧に「実際に起きたこと」だけを表示するため)。heard が空/corrected と同一のペアは無効。
 * 同じ heard の複数指定は先勝ち。置換は全出現に適用(STTの同じ誤認識は繰り返されるため)。
 */
export function applyCorrections(raw: string, pairs: VoiceCorrection[]): { text: string; applied: VoiceCorrection[] } {
  let text = raw;
  const applied: VoiceCorrection[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    if (!p.heard || p.heard === p.corrected || seen.has(p.heard)) continue;
    seen.add(p.heard);
    if (!text.includes(p.heard)) continue; // 本文に無い置換は無効(モデルの空振りを黙って捨てる)
    text = text.split(p.heard).join(p.corrected);
    applied.push(p);
  }
  return { text, applied };
}

/** 1回の補正API呼び出し。戻り値は tool 引数(復元済みオブジェクト)。テストからはこれを差し替える(transport注入)。 */
export type CorrectTransport = (args: { model: string; systemText: string; userText: string }) => Promise<unknown>;

/**
 * 既定transport: Responses API + function tool 強制(=構造保証。openai.ts の submit と同じ形)。
 * reasoning "none" は機械的な写し替えのため。max_output_tokens は全文写し替え=出力≒入力長なので余裕を持たせ固定 8000。
 */
export const defaultCorrectTransport: CorrectTransport = async ({ model, systemText, userText }) => {
  const res = await getClient().responses.create(
    {
      model,
      max_output_tokens: 2000, // 出力は置換ペアの列挙のみ(全文再生成をやめた=構造で言い換え不能にした)ため小さくてよい
      reasoning: { effort: "none" as OpenAI.ReasoningEffort },
      instructions: systemText,
      input: userText,
      tools: [{ type: "function", name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: TOOL_SCHEMA, strict: false }],
      tool_choice: { type: "function", name: TOOL_NAME },
    },
    { timeout: 120_000 },
  );
  const fc = res.output?.find((i): i is Extract<typeof i, { type: "function_call" }> => i.type === "function_call");
  return parseToolArguments(fc?.arguments);
};

/**
 * STT生テキストを選手辞書で補正する。失敗時は例外を投げず raw をそのまま返す
 * (補正はお助けであり、失敗しても音声入力自体を硬く失敗させない。誤りはノート上で人が直せる)。
 */
export async function correctTranscript(
  raw: string,
  dict: string[],
  transport: CorrectTransport = defaultCorrectTransport,
): Promise<{ text: string; corrections: VoiceCorrection[] }> {
  try {
    // システム文は役割+辞書リストのみ(名前だけ渡す。IDは渡さない=本文にID混入させない)。
    // 「本文を変えるな」はここでは頼まない=モデルは置換ペアしか出せず、適用はコードが行う(構造で保証)。
    const systemText =
      "あなたは草野球の試合記録の音声文字起こしの校正係です。本文中の誤認識箇所を見つけ、置換ペアとして列挙してください: " +
      "(1)次の辞書にある選手名・チーム名への復元(「山下」→「山田」のような音の近い揺らぎも対象) " +
      "(2)野球用語への復元(「センターくらい」→「センターフライ」のような、野球の口述として明らかな誤認識)。" +
      "辞書に無い名前や、復元に確信が持てない断片(別言語の文字列等)は挙げないでください。\n" +
      `選手辞書: ${dict.join("、")}\n` +
      `用語の例: ${BASEBALL_TERMS.join("、")}`;
    const out = await transport({ model: process.env.VOICE_CORRECT_MODEL ?? DEFAULT_MODEL, systemText, userText: raw });
    const o = out as { corrections?: unknown } | null | undefined;
    // 出力復元不能 → raw にフォールバック(補正なしと同義)
    if (!o || !Array.isArray(o.corrections)) {
      if (o != null && !Array.isArray((o as { corrections?: unknown }).corrections)) console.error("correctTranscript: 補正出力を復元できないため raw を返します", out);
      return { text: raw, corrections: [] };
    }
    // 不正形の要素は捨て、適用はコードで(実際に適用できたペアだけを corrections として返す=表示は事実のみ)
    const pairs: VoiceCorrection[] = (o.corrections as unknown[]).flatMap((c) => {
      const x = c as { heard?: unknown; corrected?: unknown } | null;
      return x && typeof x.heard === "string" && typeof x.corrected === "string" ? [{ heard: x.heard, corrected: x.corrected }] : [];
    });
    const { text, applied } = applyCorrections(raw, pairs);
    return { text, corrections: applied };
  } catch (e) {
    console.error("correctTranscript: 補正APIに失敗したため raw を返します", e);
    return { text: raw, corrections: [] };
  }
}
