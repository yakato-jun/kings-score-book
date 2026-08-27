/**
 * OpenAI アダプタ: プロバイダ切替(AI_MODEL)のうち「1回の submit 呼び出し」だけを差し替える薄い層。
 * 契約(SUBMIT_TOOLスキーマ・ロール文・requestSubmit の文字列防御+1回リトライ)は agent.ts 側で共有し、
 * ここはプロバイダ固有のAPI形状(Responses API + function tool 強制)への変換のみを持つ。
 * ※ chat.completions ではない: gpt-5.6系は「function tools + reasoning_effort」を chat.completions で
 *   併用できない(実測400: "use /v1/responses or set reasoning_effort to 'none'")。推論を保った公平な
 *   比較・運用のため Responses API を使う。
 */
import OpenAI from "openai";

/** モデルIDの接頭辞でプロバイダを自動判別: gpt-* / o+数字 → OpenAI、それ以外 → Anthropic(現行)。 */
export function isOpenAiModel(model: string): boolean {
  return /^(gpt-|o[0-9])/.test(model);
}

/**
 * tool_calls の function.arguments(常にJSON文字列) → toolInput 復元。
 * 壊れた文字列は {} でなく undefined を返す: {} だと operations 未指定=空成功に化けてしまうため、
 * undefined で「復元不能」を表し、呼び出し元 requestSubmit の同一リクエスト1回リトライ経路に乗せる。
 */
export function parseToolArguments(raw: string | null | undefined): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// クライアントは1回だけ生成(APIキーは SDK 既定=環境変数 OPENAI_API_KEY を読む)。
// OpenAI SDK はキー未設定だとコンストラクタで throw するため、Anthropic のみで運用する環境(テスト含む)の
// import を壊さないよう初回呼び出しまで生成を遅延する(生成が1回である点は不変)。
let client: OpenAI | null = null;
const getClient = (): OpenAI => (client ??= new OpenAI());

export interface OpenAiSubmitArgs {
  model: string;
  effort: string;
  systemText: string;
  userText: string;
  maxTokens: number;
  toolName: string;
  toolDescription: string;
  toolSchema: unknown;
}

/**
 * OpenAI での「1回の submit 呼び出し」(Responses API)。tool_choice で submit を強制=Anthropic側と同じ構造保証。
 * ストリーミングは使わない(create一発。128K出力上限に対し 32K で十分)。
 * strict:true は使わない: strict は全フィールドの required 化を要求し、スキーマの「省略可=部分入力を
 * 第一級で受ける」契約(曖昧・断片の保持)を壊すため。検証は従来どおり後段(normalize/ops層)が持つ。
 */
export async function openaiSubmitOnce(args: OpenAiSubmitArgs): Promise<{ toolInput: unknown; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }> {
  const res = await getClient().responses.create(
    {
      model: args.model,
      max_output_tokens: args.maxTokens,
      // GPT-5.6系は none/low/medium/high/xhigh/max 対応(Anthropicのeffortと同語彙なのでそのまま渡す)
      reasoning: { effort: args.effort as OpenAI.ReasoningEffort },
      instructions: args.systemText,
      input: args.userText,
      tools: [{ type: "function", name: args.toolName, description: args.toolDescription, parameters: args.toolSchema as Record<string, unknown>, strict: false }],
      tool_choice: { type: "function", name: args.toolName },
    },
    { timeout: 300_000 },
  );
  const fc = res.output?.find((i): i is Extract<typeof i, { type: "function_call" }> => i.type === "function_call");
  const u = res.usage;
  return {
    toolInput: parseToolArguments(fc?.arguments),
    // output_tokens は推論トークン込み。cacheWrite に相当する概念は無い(自動プロンプトキャッシュ)ので 0。
    usage: {
      input: u?.input_tokens ?? 0,
      output: u?.output_tokens ?? 0,
      cacheRead: u?.input_tokens_details?.cached_tokens ?? 0,
      cacheWrite: 0,
    },
  };
}
