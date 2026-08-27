/**
 * 入力テキストを「1イベント単位」に分割し、種別だけ付ける分割器(状態不要・原文保持)。
 * 解釈/補完/正規化はしない＝後段の per-event 解釈(盤面フィードバックあり)に渡すための前処理。
 * 種別を付けておくと、後段で型別の狭いスキーマにルーティングできる(トークン減・誤り減)。
 */
import Anthropic from "@anthropic-ai/sdk";
import { thinkingFor, AI_MODEL } from "./agent";

const client = new Anthropic();

export type SegType = "meta" | "lineup" | "defense" | "atbat" | "edit" | "other";
export interface Segment { type: SegType; text: string }
export interface SegmentResult { segments: Segment[]; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }

const SEG_TOOL: Anthropic.Tool = {
  name: "segment",
  description: "入力テキストを野球の『1イベント単位』に分割し、種別を付ける。内容の解釈・補完・正規化はしない(原文のまま)。",
  input_schema: {
    type: "object",
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["meta", "lineup", "defense", "atbat", "edit", "other"], description: "meta=試合情報(日付/相手/先後/区分/結果) lineup=試合開始のスタメン・打順表(全体で1つ) defense=試合途中の守備位置変更 atbat=1打者の打席(盗塁/暴投が絡んでも1打席は1つ) edit=既存記録の修正/削除 other=それ以外" },
            text: { type: "string", description: "そのイベントの原文(分割しただけ・改変しない)" },
          },
          required: ["type", "text"],
        },
      },
    },
    required: ["segments"],
  },
};

const SYS = [
  "あなたは野球スコアの入力テキストを『1イベント単位』に分割し、種別を付ける分割器です。",
  "解釈・補完・正規化はしない。原文の語を保ったまま分割するだけ(意味の追加・省略をしない)。必ず segment ツールを1回だけ呼ぶ。",
  "1打席に複数の事象(盗塁→四球、パスボール→四球 等)が含まれても、それは1つの atbat セグメントにまとめる(打者単位)。",
  "回マーカー(例『1回表』)は、続く打席に付随する文脈として、その後の atbat セグメントの text 先頭に残してよい。単独で other に切り出さない。",
  "試合開始のスタメン/打順表は、行ごとに分割せず全体を1つの lineup セグメントにまとめる(後段の全置換登録が1回で済むように)。",
  "試合途中の守備位置変更(例『守備位置変更 山本 1→5』『ピッチャー→サード』『2->5』)は lineup ではなく defense セグメントにする(スタメン全置換と区別する)。",
].join("\n");

export async function segment(text: string, model = AI_MODEL, maxTokens = 4000): Promise<SegmentResult> {
  const res = await client.messages.create({
    model, max_tokens: maxTokens, thinking: thinkingFor(model),
    ...(/haiku/i.test(model) ? {} : { output_config: { effort: "medium" as const } }),
    system: SYS, tools: [SEG_TOOL], tool_choice: { type: "tool", name: "segment" },
    messages: [{ role: "user", content: text }],
  });
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const out = (tu?.input ?? { segments: [] }) as { segments?: Segment[] };
  const segments = (out.segments ?? [])
    .map((s) => ({ type: s.type, text: (s.text ?? "").trim() }))
    .filter((s) => s.text); // 衛生レベルの整形(trim/空除去)のみ。内容のルール検査はしない
  return {
    segments,
    usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 },
  };
}
