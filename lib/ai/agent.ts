/**
 * 入力アシスタント(v2)。AIの役割は「自然言語 → スキーマ(操作の配列)」の変換だけ。会話はしない。
 *
 * 設計:
 *  - 出力は構造化(単一ツール submit を強制)。{ operations:[…], clarification }。自由文は主チャネルにしない。
 *  - 成功時はAIに喋らせず、UI側で定型文を出す。曖昧なときだけ clarification(AIの文言)を返す。
 *  - 入力は「最新のユーザー発言(＋直前のAI確認1つ)＋試合の流れ(現状サマリ・記録済み打席)」。
 *    過去のユーザー発言は再生しない＝二重登録が構造的に起きない。書き込みは即draft反映なので、
 *    積み上がった状態(=流れ)が文脈を引き継ぐ。配置(回/表裏/order/アウト/走者)はサーバが導出。
 *  - 形式ルール(3アウトで自動チェンジ等)は課さない。アウトは記録どおり(4・5も可)。
 */
import Anthropic from "@anthropic-ai/sdk";
import { applyOps, getGameSummary, type GameOpInput } from "@/lib/ops/games";
import { listPlayers } from "@/lib/ops/players";
import { loadPlayers } from "@/lib/db/players";
import { docNameResolver } from "@/lib/names";
import { loadWorking, loadVersion, listVersions, loadGame, currentGen, publicGen, GenConflictError } from "@/lib/db/games";
import { derivePAStates } from "@/lib/ops/gamestate";
import { renderPlayByPlay } from "@/lib/textlog";
import { isOpenAiModel, openaiSubmitOnce } from "./openai";
import type { SegType } from "./segment";
import type { Half, Runners, Annotation, GameDoc } from "@/lib/types/v2";

const client = new Anthropic();
/** 使用モデル。環境変数 AI_MODEL 1本で切替(既定は現行の fable)。接頭辞でプロバイダを自動判別(isOpenAiModel)。 */
export const AI_MODEL = process.env.AI_MODEL ?? "claude-fable-5";
const CALL_TIMEOUT_MS = 70_000;
// 解析の reasoning effort。env AI_EFFORT で切替(AI_MODEL と同じ運用ノブ)。既定 low=88ラン検証の採用構成
// (fable×low が全対象打席正答・構造崩れ0。effort はこのタスクの支配要因でない)。不正値は low に落とす。
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const APP_EFFORT: Effort = EFFORTS.includes(process.env.AI_EFFORT as Effort) ? (process.env.AI_EFFORT as Effort) : "low";

/** fable/mythos系は thinking 常時ON(disabled送信は400)。adaptive を送り、他モデルは従来どおり無効。 */
export const thinkingFor = (model: string): Anthropic.ThinkingConfigParam =>
  /fable|mythos/i.test(model) ? { type: "adaptive" } : { type: "disabled" };

export interface Applied { tool: string; summary: string }
export interface AgentResult { applied: Applied[]; clarification: string | null; gameId: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }
export interface Scene { game_id?: string; date?: string; inning?: number; half?: string; order?: number; player_id?: string }

// 打席の付随イベント(addPlateAppearance のサブスキーマ)。得点(runs)はAIが出さずエンジンが導出。
const fieldingSchema = {
  type: ["object", "null"], description: "打球がある時。三振/四死球はnull",
  properties: {
    hit_to: { type: ["string", "null"], enum: ["投", "捕", "一", "二", "三", "遊", "左", "中", "右", null], description: "打球が飛んだ守備位置の漢字(番号に直さない。一=ファースト 二=セカンド 三=サード)" }, hit_type: { type: ["string", "null"], description: "G=ゴロ F=飛 L=直" },
    sequence: { type: "array", items: { type: "string" } },
    outs: { type: "array", items: { type: "object", properties: { at: { type: "string" }, type: { type: "string", enum: ["force", "tag", "catch"] }, runner_id: { type: ["string", "null"] } } } },
    errors: { type: "array", items: { type: "object", properties: { pos: { type: "string" }, type: { type: "string" } } } },
  },
};
const baseAfterSchema = {
  type: "array", description: "打者の結果とは別に起きた走者の動き(他の走者の進塁/生還/走塁アウト、打者の結果を超える余分な進塁)。打者が結果どおりに到達する塁(単打→一塁、二塁打→二塁 等)は書かない=サーバが結果コードから自動配置する。to は 1/2/3 が進塁、home が生還、out が走塁アウト",
  items: { type: "object", properties: { from: { type: "string", enum: ["1", "2", "3", "batter", "unknown"], description: "移動元。1/2/3=塁、batter=打者走者(結果を超える進塁のみ)、unknown=本当に分からない時だけ" }, to: { type: "string", description: "1/2/3/home/out" }, runner_id: { type: "string", description: "省略してよい。サーバがfrom塁の走者で決める" }, reason: { type: ["string", "null"] } }, required: ["from", "to"] },
};
const baseDuringSchema = {
  type: "array", description: "打席中に起きた走塁。盗塁・暴投・牽制など、打者の結果とは別の事象",
  items: { type: "object", properties: { event: { type: "string", description: "SB盗塁 CS盗塁死 WP暴投 PB捕逸 PO牽制 BK" }, runners: { type: "array", items: { type: "object", properties: { from: { type: "string", enum: ["1", "2", "3", "unknown"], description: "移動元の塁。unknown=本当に分からない時だけ" }, to: { type: "string", description: "1/2/3/home/out" }, runner_id: { type: "string", description: "省略してよい。サーバがfrom塁で決める" } }, required: ["from", "to"] } }, note: { type: ["string", "null"] } }, required: ["event"] },
};

// 守備位置変更(delta): 該当選手の位置だけ差し替える。打順・他の選手は不変。
const defenseChangeSchema = {
  type: "array", description: "守備位置変更。該当選手の位置だけ差し替える。参加している選手なら誰でも位置につけられる(初登場の選手もそのまま指定してよい)",
  items: { type: "object", properties: {
    player_id: { type: "string", description: "対象選手のP-id/助っ人名。from_positionで特定する場合は不要" },
    guest_name: { type: "string", description: "辞書に無い新しい助っ人の名前(P-idがある選手は player_id で)" },
    from_position: { type: ["string", "null"], description: "旧守備位置 1-9/DH。位置起点の表記『2->5』『ピッチャー→サード』で対象を指す時に使う" },
    to_position: { type: "string", description: "新守備位置 1投2捕3一4二5三6遊7左8中9右/DH" },
  }, required: ["to_position"] },
};

// 単一の操作(op で種別)。result の名前衝突を避け、打席結果は result_code、試合結果は game_result。
const operationSchema = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["setGameMeta", "setStartingLineup", "changeDefense", "changeBattingOrder", "addPlateAppearance", "editPlateAppearance", "removePlateAppearance"], description: "操作の種別" },
    changes: defenseChangeSchema,
    order: { type: "integer", description: "edit/removeの対象＝その半イニング内の打席番号(記録済みダイジェストの #N)" },
    // setGameMeta
    date: { type: "string", description: "YYYY-MM-DD" }, opponent: { type: "string" }, league: { type: ["string", "null"] },
    home_away: { type: ["string", "null"], enum: ["home", "away", null], description: "away=先攻 home=後攻" },
    game_result: { type: ["object", "null"], description: "最終スコアや勝敗がテキストに明記されている時だけ設定する。書かれていない合計を打席から自分で数えて埋めない(得点の導出はサーバの仕事。誤集計するとR4で矛盾になる)", properties: { our_score: { type: "integer" }, their_score: { type: "integer" }, outcome: { type: "string", enum: ["win", "loss", "tie"] }, decided_by: { type: "string", enum: ["regulation", "time_limit", "walkoff", "called", "forfeit", "tie"] } } },
    // setStartingLineup
    rows: { type: "array", items: { type: "object", properties: { order: { type: ["integer", "null"], description: "打順(1からの連番)。全員打ち等で10番以降も可。DH制で打順に入らない投手は null(例: スタメンにDHがあり投手が打席に立たない試合。後の記述から先発投手が分かる場合も投手行を入れる)" }, position: { type: ["string", "null"], description: "守備位置 1投2捕3一4二5三6遊7左8中9右/DH" }, player_id: { type: "string", description: "自軍正規選手のP-id" }, guest_name: { type: "string", description: "助っ人名(P-idが無い時)" } }, required: ["order", "position"] } },
    // changeBattingOrder（打順枠の変化。実在する事実は「参加/守備位置/打順枠」の3つだけで「選手交代」はこの複合＝
    //   枠の出入りはこれ、位置は changeDefense。タイミングは inning/half で指定）
    order_changes: { type: "array", description: "打順枠の変化。「AがBの打順(N番)に入った」は [{player:A, order:N}, {player:B, order:null}] の2件で表す。order:null=枠から外れる。変化のタイミングは inning/half で必ず指定する", items: { type: "object", properties: { player: { type: "string", description: "対象選手のP-id/名前" }, order: { type: ["integer", "null"] } }, required: ["player", "order"] } },
    // addPlateAppearance（order/打順/アウト/走者/投捕/得点はサーバが導出）
    inning: { type: "integer", description: "回" }, half: { type: "string", enum: ["top", "bottom"], description: "top/bottom" },
    batter_id: { type: "string", description: "打者。自軍の選手は P-id。相手チームは「相手N番」(N=打順)。不明なら省略" },
    result_code: { type: "string", enum: ["H1", "H2", "H3", "HR", "OUT", "K", "BB", "HBP", "FC", "E", "SH", "SF", "INC"], description: "H1単打 H2二塁打 H3三塁打 HR本塁打 OUT凡退 K三振 BB四球 HBP死球 FC野選 E失策 SH犠打 SF犠飛 INC未完了" },
    fielding: fieldingSchema, baserunning_after: baseAfterSchema, baserunning_during: baseDuringSchema,
    // [§14.1 研究A・見送り中] stated_outs/stated_runners(状態記載の転記)はスキーマ非公開=不活性。検証結果と再開手順は DESIGN §14.1
    note: { type: ["string", "null"], description: "実況" },
    unclear: { type: ["string", "null"], description: "この打席に確証が無い/曖昧な点があれば理由を書く(無ければnull)。打席は落とさずベスト推定で記録し、不明点をここに残す" },
  },
  required: ["op"],
};

// export は診断ハーネス(scripts/)用。本番の呼び口は ingest* のまま。
export const SUBMIT_TOOL: Anthropic.Tool = {
  name: "submit",
  description: "入力テキストから導いた操作の配列を提出する。述べられた出来事だけを操作にする。曖昧な打席も落とさずベスト推定で記録し、その打席の unclear に不明点(理由)を書く。試合全体として確定不能な時だけ operations を空にし clarification に質問。",
  input_schema: {
    type: "object",
    properties: {
      operations: { type: "array", items: operationSchema },
      clarification: { type: ["string", "null"], description: "曖昧な時の確認文。無ければ null" },
    },
    required: ["operations", "clarification"],
  },
};

// ===== 型別の狭スキーマ(Q2): セグメント種別ごとに最小スキーマで解釈 → トークン減・op種別の取り違え防止 =====
// 打席だけのアイテム(op/メタ/スタメン/edit フィールドを持たない＝プロンプトが小さい)
const atbatItem = {
  type: "object",
  properties: {
    result_code: { type: "string", enum: ["H1", "H2", "H3", "HR", "OUT", "K", "BB", "HBP", "FC", "E", "SH", "SF", "INC"], description: "H1単打 H2二塁打 H3三塁打 HR本塁打 OUT凡退 K三振 BB四球 HBP死球 FC野選 E失策 SH犠打 SF犠飛 INC未完了" },
    batter_id: { type: "string", description: "打者。自軍の選手は P-id。相手チームは「相手N番」(N=打順)。不明なら省略" },
    inning: { type: "integer", description: "回" },
    half: { type: "string", enum: ["top", "bottom"], description: "top/bottom" },
    baserunning_after: baseAfterSchema, baserunning_during: baseDuringSchema, fielding: fieldingSchema,
    // [§14.1 研究A・見送り中] stated_* はスキーマ非公開=不活性(DESIGN §14.1)
    note: { type: ["string", "null"], description: "実況" },
    unclear: { type: ["string", "null"], description: "この打席に確証が無い/曖昧な点があれば理由を書く(無ければnull)。打席は落とさずベスト推定で記録し、不明点をここに残す" },
  },
  required: ["result_code"],
};
const ATBAT_TOOL: Anthropic.Tool = {
  name: "atbat",
  description: "入力テキストにある全打席を、1打席=operations の1要素として順に出す。得点・得点者・打点・投捕はサーバが導くので入れない。曖昧な打席も落とさず記録し、その打席の unclear に不明点(理由)を書く。全体が確定不能な時だけ clarification に質問。",
  input_schema: { type: "object", properties: { operations: { type: "array", items: atbatItem }, clarification: { type: ["string", "null"] } }, required: ["operations", "clarification"] },
};

// 守備位置変更だけの狭スキーマ(他フィールドを持たない＝プロンプト小)
const defenseItem = {
  type: "object",
  properties: {
    inning: { type: "integer", description: "守備変更が有効になる回。例『7回表』" },
    half: { type: "string", enum: ["top", "bottom"], description: "守備側。相手の攻撃half。自軍が後攻ならtop" },
    changes: defenseChangeSchema,
  },
  required: ["changes"],
};
const DEFENSE_TOOL: Anthropic.Tool = {
  name: "defense",
  description: "試合途中の守備位置変更を operations で出す。該当選手の位置だけ差し替える。打順・他の選手・スタメンは消さない。曖昧なら operations を空にし clarification に質問。",
  input_schema: { type: "object", properties: { operations: { type: "array", items: defenseItem }, clarification: { type: ["string", "null"] } }, required: ["operations", "clarification"] },
};

const ROUTE: Record<SegType, { tool: Anthropic.Tool; op?: string }> = {
  atbat: { tool: ATBAT_TOOL, op: "addPlateAppearance" },
  defense: { tool: DEFENSE_TOOL, op: "changeDefense" },
  meta: { tool: SUBMIT_TOOL }, lineup: { tool: SUBMIT_TOOL }, edit: { tool: SUBMIT_TOOL }, other: { tool: SUBMIT_TOOL },
};

/** 不変の指示(キャッシュ対象)。制約はスキーマ(各フィールドのdescription/enum)が持つ。ここは役割だけ。export は診断ハーネス用。 */
export function instructions(): string {
  return "草野球チーム N-KINGS のスコア係。メンバーが自由に書いた試合メモ（断片的・曖昧でもよく、記法も自由で凡例が付くこともある）を試合記録に起こす。メモは打席の並びとして前後がつながっているので、各打席はその流れ（アウト数・走者の増減）の中で読む。書かれた出来事だけを記録し、書かれていないことは埋めない。不確かな打席は unclear に理由を添えて記録し、試合全体が読み取れない時だけ clarification で質問する。走者の同定・塁の配置・得点の計算は、記録された打席結果と走者の移動（どの塁からどの塁へ）を入力にサーバが行う。だから移動は元の塁が分かる形で記録する。";
}

/** 可変コンテキスト(キャッシュ対象外)。判定に要る入力データ＝いまの盤面だけ。指示や記録の再掲はしない。 */
function context(summary: unknown, scene?: Scene): string {
  const s = summary as { state?: { inning: number; half: Half; outs: number; runners?: Runners } } | null;
  if (!s) return `新規作成の試合。${scene?.date ? `日付=${scene.date}。` : ""}`;
  const st = s.state;
  if (!st) return "";
  const r = st.runners ?? { first: null, second: null, third: null };
  const runners = [r.first && "一", r.second && "二", r.third && "三"].filter(Boolean).join("・") || "なし";
  return `盤面: ${st.inning}回${st.half === "top" ? "表" : "裏"} ${st.outs}死 走者${runners}`;
}

/** system を組む: [役割] [辞書(キャッシュ境界＝役割＋辞書が安定プレフィックス)] [盤面]。 */
function buildSystem(dict: string, summary: unknown, scene?: Scene): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: instructions() },
    { type: "text", text: `選手名→ID:\n${dict}`, cache_control: { type: "ephemeral", ttl: "5m" } },
    { type: "text", text: context(summary, scene) },
  ];
}

async function dictionary(): Promise<string> {
  return (await listPlayers()).map((p) => `${p.id}=${p.name}`).join(", ");
}

type Op = Record<string, unknown> & { op: string };

/** モデルが operations をJSON文字列で二重エンコードする稀ケース(実測~12%)の防御。parse成功なら配列に、失敗なら null(=リトライ判断)。 */
export function normalizeOperations(raw: unknown): Op[] | null {
  if (Array.isArray(raw)) return raw as Op[];
  if (typeof raw === "string") { try { const p = JSON.parse(raw); return Array.isArray(p) ? (p as Op[]) : null; } catch { return null; } }
  if (raw == null) return [];
  return null;
}

// 形式崩れ(operations 復元不能)がリトライ後も続いた時のユーザー向け文言。例外にしない=集計フローは clarification で完結させる。
const BROKEN_OUTPUT_CLARIFICATION = "AIの出力形式が崩れました。もう一度AI集計を実行してください。";

interface SubmitOut { operations: Op[]; clarification: string | null; usage: NonNullable<AgentResult["usage"]> }
/** provider 中立の「1回の submit 呼び出し」の結果。toolInput undefined = 構造化出力を復元できなかった(→リトライ対象)。 */
export interface SubmitOnceOut { toolInput: unknown; usage: NonNullable<AgentResult["usage"]> }

/** リクエスト実行→応答取り出しの共通処理。operations が復元不能なら同一リクエストをもう1回だけ再実行し、再度不能なら operations 空＋定型 clarification で終える(例外は投げない)。usage は試行の合算。 */
async function requestSubmit(run: () => Promise<SubmitOnceOut>): Promise<SubmitOut> {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await run();
    usage.input += res.usage.input; usage.output += res.usage.output;
    usage.cacheRead += res.usage.cacheRead; usage.cacheWrite += res.usage.cacheWrite;
    // toolInput が「プレーンなオブジェクト」でない時は operations 復元不能と同義に扱う。
    // undefined(arguments JSON 壊れ)だけでなく、"null"/"[]"/プリミティブ等の有効JSONも弾く
    // (null は .operations 参照で例外＝「例外を投げない」契約が破れ、配列/プリミティブは空成功に化けて
    //  リトライ・定型clarificationの防御チャネルから漏れるため。Anthropic経路の tool_use.input は常にオブジェクト)。
    const raw = res.toolInput;
    const out = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { operations?: unknown; clarification?: string | null }) : undefined;
    const ops = out === undefined ? null : normalizeOperations(out.operations);
    if (ops !== null && out !== undefined) return { operations: ops, clarification: out.clarification ?? null, usage };
  }
  return { operations: [], clarification: BROKEN_OUTPUT_CLARIFICATION, usage };
}

/** Anthropic での「1回の submit 呼び出し」(create/stream)→ provider中立の { toolInput, usage } へ変換。tool_use 不在は従来どおり「operations 無し」として扱う(=リトライさせない)。 */
async function anthropicSubmitOnce(params: Anthropic.MessageCreateParamsNonStreaming, stream: boolean): Promise<SubmitOnceOut> {
  const res = stream
    ? await client.messages.stream(params).finalMessage()
    : await client.messages.create(params, { timeout: CALL_TIMEOUT_MS });
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return {
    toolInput: tu?.input ?? { operations: [], clarification: null },
    usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 },
  };
}

/** OpenAI 経路用: MessageParam 列を1つのテキストへ畳む(実運用の入力は「最新のユーザー発言(＋直前のAI確認1つ)」の短い列)。 */
function flattenMessages(messages: Anthropic.MessageParam[]): string {
  return messages
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("\n")))
    .join("\n\n");
}

/**
 * 「1回の submit 呼び出し」の provider seam。モデルIDの接頭辞で Anthropic/OpenAI を選ぶ。
 * 契約(SUBMIT_TOOL スキーマ・ロール文・submit 強制・effort)は共有し、差はAPI形状の変換だけ。
 *  - Anthropic: thinkingFor(model) はこの経路のみ。effort は output_config.effort(Haiku非対応分岐は現行どおり)。system は3ブロック(cache_control付き)。
 *  - OpenAI: effort は reasoning_effort。system はブロックの text を "\n\n" 連結した1文字列
 *    (cache_control は Anthropic 固有 → OpenAI は自動プロンプトキャッシュに委ねる)。
 * export は検証ハーネス(scripts/)用。本番の呼び口は makeApiParser / ingest* のまま。
 */
export function submitOnceFor(model: string, args: { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[]; maxTokens: number; stream?: boolean }): Promise<SubmitOnceOut> {
  if (isOpenAiModel(model)) {
    return openaiSubmitOnce({
      model, effort: APP_EFFORT,
      systemText: args.system.map((b) => b.text).join("\n\n"),
      userText: flattenMessages(args.messages),
      maxTokens: args.maxTokens,
      toolName: SUBMIT_TOOL.name, toolDescription: SUBMIT_TOOL.description ?? "", toolSchema: SUBMIT_TOOL.input_schema,
    });
  }
  return anthropicSubmitOnce(
    {
      model, max_tokens: args.maxTokens, thinking: thinkingFor(model),
      ...(/haiku/i.test(model) ? {} : { output_config: { effort: APP_EFFORT } }), // Haikuはeffort非対応
      system: args.system, tools: [SUBMIT_TOOL], tool_choice: { type: "tool", name: "submit" }, messages: args.messages,
    },
    args.stream ?? false,
  );
}

// 守備位置: AIは漢字で出す(一飛→一)。番号(守備位置ID)への変換はエンジンが持つ＝モデルに 一→3 の算術をさせない。
const POS_KANJI_TO_NUM: Record<string, string> = {
  投: "1", 捕: "2", 一: "3", 二: "4", 三: "5", 遊: "6", 左: "7", 中: "8", 右: "9",
  一塁: "3", 二塁: "4", 三塁: "5", 遊撃: "6", 左翼: "7", 中堅: "8", 右翼: "9",
};
/** op.fielding.hit_to を漢字→守備位置番号へ正規化(数字はそのまま通す)。fielding 以外の op は素通り。 */
function normFielding(op: Op): Op {
  const f = op.fielding as Record<string, unknown> | null | undefined;
  if (!f || typeof f !== "object" || f.hit_to == null) return op;
  const k = String(f.hit_to).trim();
  const num = /^[1-9]$/.test(k) ? k : POS_KANJI_TO_NUM[k] ?? POS_KANJI_TO_NUM[k.replace(/塁$/, "")] ?? k;
  return { ...op, fielding: { ...f, hit_to: num } };
}

/** AIが打席に付けた unclear(理由) を annotation(source:"ai") に変換。null/空なら付けない＝落とさず印だけ残す。 */
function aiUnclear(u: unknown): { annotations: Annotation[] } | Record<string, never> {
  return u ? { annotations: [{ type: "unclear", detail: String(u), source: "ai" }] } : {};
}

/** AIのフラットな op(op/result_code/game_result) を ops層の GameOpInput(type/result) へ写す。 */
export function toGameOp(rawOp: Op): GameOpInput { // export はテスト用(写像の契約を固定する)
  const op = normFielding(rawOp);
  if (op.op === "changeBattingOrder") {
    // AIのフラット表現(order_changes/inning/half) → ops層 ChangeOrderInput。
    // ※ substitutePlayer は AI の語彙から撤去(2026-08-18): 「選手交代」は独立概念でなく 参加/守備位置/打順枠 の複合。
    //   ops層 reduceSubstitutePlayer は UI/過去互換で残置。
    return { type: "changeBattingOrder", rows: op.order_changes, timing: { inning: op.inning, half: op.half } } as GameOpInput;
  }
  if (op.op === "setGameMeta") {
    const { op: _o, game_result, ...rest } = op; void _o;
    return { type: "setGameMeta", ...rest, result: game_result } as GameOpInput;
  }
  if (op.op === "setStartingLineup") {
    return { type: "setStartingLineup", rows: (op.rows ?? []) } as GameOpInput;
  }
  if (op.op === "changeDefense") {
    return { type: "changeDefense", changes: op.changes ?? [], inning: op.inning, half: op.half } as GameOpInput;
  }
  if (op.op === "addPlateAppearance") {
    const { op: _o, result_code, unclear, ...rest } = op; void _o;
    return { type: "addPlateAppearance", ...rest, result: result_code, ...aiUnclear(unclear) } as GameOpInput;
  }
  if (op.op === "editPlateAppearance") {
    const { op: _o, result_code, unclear, ...rest } = op; void _o;
    // AIの編集=打席の再解釈なので、既存の不明瞭は明示的に解決扱い(新たな不明瞭は aiUnclear で付き直す)。
    // 手修正(エディタ)の部分編集はこのフラグを送らない=注記が黙って消えない(§10.3 実バグ②)。
    return { type: "editPlateAppearance", ...rest, clear_unclear: true, ...(result_code !== undefined ? { result: result_code } : {}), ...aiUnclear(unclear) } as GameOpInput;
  }
  if (op.op === "removePlateAppearance") {
    return { type: "removePlateAppearance", inning: op.inning, half: op.half, order: op.order } as GameOpInput;
  }
  throw new Error(`未知の操作: ${op.op}`);
}

// ===== パーサ(自然言語→構造化op) を差し替え可能にする =====
// prod = Anthropic API(本番)。試行錯誤/テスト = フィクスチャ(API不要)。
// apply 以降(toGameOp→applyOps→検証)は決定論なので共通。

export interface ParseInput { messages: Anthropic.MessageParam[]; scene?: Scene; priorText?: string; dict: string; summary: unknown }
export interface ParseOutput { operations: Op[]; clarification: string | null; usage?: AgentResult["usage"] }
export type Parser = (input: ParseInput) => Promise<ParseOutput>;

/** モデル指定の本番パーサを作る(強制ツールで構造化出力・thinkingはモデル別切替・effort低・キャッシュ)。ここだけ実APIを叩く。 */
export function makeApiParser(model: string, maxTokens = 4000): Parser {
  return async ({ messages, scene, dict, summary }) => {
    const system = buildSystem(dict, summary, scene);
    const r = await requestSubmit(() => submitOnceFor(model, { system, messages, maxTokens }));
    return { operations: r.operations, clarification: r.clarification, usage: r.usage };
  };
}

/** 本番既定パーサ(AI_MODEL)。 */
export const apiParser: Parser = makeApiParser(AI_MODEL);

/** 試行錯誤/テスト用パーサ: 最新ユーザー発言→canned 構造化出力 のマップで代替(API不要)。 */
export function fixtureParser(map: Record<string, { operations?: Op[]; clarification?: string | null }>): Parser {
  return async ({ messages }) => {
    const last = [...messages].reverse().find((m) => m.role === "user");
    const key = typeof last?.content === "string" ? last.content : "";
    const f = map[key] ?? { operations: [] };
    return { operations: f.operations ?? [], clarification: f.clarification ?? null };
  };
}

/**
 * 1試合まるごと1コールで取り込む。ノート全文(メタ＋スタメン＋全打席＋守備変更)を SUBMIT_TOOL に渡し、
 * 返ってきた operations を1世代で適用する。得点・投捕・runner_id はエンジンが導出するので、モデルは事実だけ。
 * 出力が長くなるので streaming。盤面はサーバが畳むのでモデルは状態を追わない＝1コールでも崩れない。
 */
export async function ingestWholeGame(gameId: string, memo: string, model: string, date?: string): Promise<{ count: number; clarification: string | null; usage: AgentResult["usage"] }> {
  const dict = await dictionary();
  const system = buildSystem(dict, null, { game_id: gameId, date });
  // maxTokens は88ラン検証時の値(fable実測は最大7.4k)。出力が長いので Anthropic 経路は streaming(OpenAI 経路は create 一発)。
  const r = await requestSubmit(() => submitOnceFor(model, { system, messages: [{ role: "user", content: memo }], maxTokens: 32000, stream: true }));
  const usage = r.usage;
  let gameOps: GameOpInput[];
  try { gameOps = r.operations.map(toGameOp); }
  catch (e) { return { count: 0, clarification: `操作の解釈に失敗しました: ${(e as Error).message}`, usage }; }
  // AI集計＝全置換(replace)を1版で。input にノート全文を正本として刻む。
  if (gameOps.length) await applyOps(gameId, gameOps, { source: "ai", draft: true, replace: true, edit_source: "ai_aggregate", input: { kind: "note", text: memo } });
  return { count: gameOps.length, clarification: r.clarification, usage };
}

/**
 * 公開後の差分集計(#1)。ノート＝公開版への変化点。公開版を土台に、AIが「変えるぶんの ops だけ」生成→
 * 畳み込んで draft 化(全置換しない)。記録済み打席ダイジェストを文脈に渡し、既存打席を回/表裏/order で直せる。
 * 前提: 呼ぶ時は下書きが無い(集計は route が下書きありを弾く=案A)。だから自前で discardDrafts はしない。
 */
export async function ingestDelta(gameId: string, memo: string, model: string): Promise<{ count: number; clarification: string | null; usage: AgentResult["usage"] }> {
  const [dict, summary] = await Promise.all([dictionary(), getGameSummary(gameId)]);
  const recorded = ((summary as { recorded?: string[] } | null)?.recorded ?? []).join("\n") || "（記録なし）";
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: "公開済み試合への変化点を反映する変換器。ノートに書かれた変更だけを operations にする。既存打席を直すなら回/表裏/order で editPlateAppearance、足すなら addPlateAppearance、守備変更は changeDefense、メタは setGameMeta。変えない項目は出さない。会話しない。曖昧でも分かる範囲を出し、確証が無い打席は unclear に理由を書く。全く不能な時だけ operations を空にし clarification。走者の同定・打者の塁配置はサーバが from塁から導出する。from 不明時だけ unknown。" },
    { type: "text", text: `選手名→ID:\n${dict}`, cache_control: { type: "ephemeral", ttl: "5m" } },
    { type: "text", text: `記録済み打席:\n${recorded}\n${context(summary)}` },
  ];
  // maxTokens は88ラン検証時の値(fable実測は最大7.4k)。OpenAI 時は上記 system ブロックが連結される(submitOnceFor)。
  const r = await requestSubmit(() => submitOnceFor(model, { system, messages: [{ role: "user", content: memo }], maxTokens: 32000, stream: true }));
  const usage = r.usage;
  let gameOps: GameOpInput[];
  try { gameOps = r.operations.map(toGameOp); }
  catch (e) { return { count: 0, clarification: `操作の解釈に失敗しました: ${(e as Error).message}`, usage }; }
  // 公開後差分: 公開版(discard後の working)を土台に ops を畳んで draft 化(replaceしない)。input にノート(変化点)を正本として刻む。
  if (gameOps.length) await applyOps(gameId, gameOps, { source: "ai", draft: true, edit_source: "ai_aggregate", input: { kind: "note", text: memo } });
  return { count: gameOps.length, clarification: r.clarification, usage };
}

/**
 * 版の取り消し(revert)。版N と その前版N-1 のプレーバイプレーを比べさせ、N が加えた変化点だけを
 * 現在の公開版に対して取り消す ops を AI に出させて draft 化する(#1=ingestDelta の仕組みの流用)。
 * N以降の他の変更は保持(触らない)。ロールバック(丸ごと巻き戻し)と違い「Nの差分だけ」を消すのが狙い。
 * 下書き中は不可＝クリーンな公開版を土台にする(手修正/ロールバックと同じ前提)。下書き＋レビューで確定。
 */
export async function ingestRevert(gameId: string, gen: number, model: string): Promise<{ count: number; clarification: string | null; usage: AgentResult["usage"] }> {
  const [cur, versions, tip, pub] = await Promise.all([
    loadVersion(gameId, gen), listVersions(gameId), currentGen(gameId), publicGen(gameId),
  ]);
  if (!cur) throw new Error(`版 gen ${gen} が見つかりません`);
  if (cur.draft) throw new Error("未確定の集計結果は取り消せません（公開版を選んでください）");
  if (tip !== pub) throw new GenConflictError(pub, tip); // 軸2: 下書き割り込み→route が draftRaceMsg へ翻訳

  // 「一つ前の版」＝直前gen(=このpublishが確定したdraft等)ではなく、直前の【公開版】。
  //   AI集計/差分の内容変化はdraft版に入り、後続のpublish版は同内容→直前genと比べると差0になるため。
  //   公開系譜での前版と比べる＝この公開サイクルがネットで加えた変化点を正しく取る。
  const prevGen = versions.find((v) => v.gen < gen && !v.draft)?.gen; // versions は gen 降順
  const prevDoc: GameDoc | null = prevGen ? (await loadVersion(gameId, prevGen))?.snapshot ?? null : null;
  const prevLabel = prevGen ? `gen ${prevGen}` : "なし";

  const [dict, summary, pubDoc, playersMap] = await Promise.all([dictionary(), getGameSummary(gameId), loadGame(gameId), loadPlayers()]);
  const recorded = ((summary as { recorded?: string[] } | null)?.recorded ?? []).join("\n") || "（記録なし）";
  const metaLine = (d: GameDoc | null) =>
    d ? `${d.game.date} vs ${d.game.opponent} ${d.game.home_away ?? "?"} スコア ${d.game.result ? `${d.game.result.our_score}-${d.game.result.their_score}` : "未設定"}` : "（無し＝この版が試合を作成）";
  // §9: 参加者IDは不透明でAIの辞書に無い→PBPは名前でレンダリング(AIは名前→マスタIDで発話し、reducerが参加者へ解決)
  const prevPBP = prevDoc ? renderPlayByPlay(prevDoc, docNameResolver(prevDoc, playersMap)) : "（記録なし＝この版が最初の記録）";
  const curPBP = renderPlayByPlay(cur.snapshot, docNameResolver(cur.snapshot, playersMap));
  const hint = cur.input?.text ? `\n版gen${gen}を生んだ入力(参考): ${cur.input.text}` : "";

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: "公開済み試合の『ある版が加えた変更』を取り消す変換器。『変更前(=直前の公開版)』と『変更後(=対象版)』を比べて対象版が加えた変化点を特定し、その変化点だけを取り消す operations を『現在の公開版』に対して出す。対象版より後の他の変更は保持する(触らない)。打席を直すなら回/表裏/order で editPlateAppearance、対象版が足した打席なら removePlateAppearance、対象版が消した打席なら addPlateAppearance、守備変更・メタも同様に元へ戻す。変えない項目は出さない。会話しない。曖昧でも分かる範囲を出し、確証が無い打席は unclear に理由を書く。全く不能な時だけ operations を空にし clarification。走者の同定・打者の塁配置はサーバが from塁から導出する。from 不明時だけ unknown。" },
    { type: "text", text: `選手名→ID:\n${dict}`, cache_control: { type: "ephemeral", ttl: "5m" } },
    { type: "text", text: `■変更前(${prevLabel}) メタ:${metaLine(prevDoc)}\n${prevPBP}\n\n■変更後(gen ${gen}) メタ:${metaLine(cur.snapshot)}\n${curPBP}${hint}\n\n■現在の公開版(これに対して取り消しを反映する) メタ:${metaLine(pubDoc)}\n記録済み打席:\n${recorded}\n${context(summary)}` },
  ];
  const userMsg = `gen ${gen} が加えた変更だけを取り消してください。変更前(${prevLabel})と変更後(gen ${gen})の差を特定し、それを現在の公開版に対して元に戻す operations を出してください。gen ${gen} より後の他の変更には触れないでください。`;
  // maxTokens は88ラン検証時の値(fable実測は最大7.4k)。OpenAI 時は上記 system ブロックが連結される(submitOnceFor)。
  const r = await requestSubmit(() => submitOnceFor(model, { system, messages: [{ role: "user", content: userMsg }], maxTokens: 32000, stream: true }));
  const usage = r.usage;
  let gameOps: GameOpInput[];
  try { gameOps = r.operations.map(toGameOp); }
  catch (e) { return { count: 0, clarification: `操作の解釈に失敗しました: ${(e as Error).message}`, usage }; }
  // 公開版を土台に「取り消しops」を畳んで draft 化(replaceしない)。出自は edit_source:"revert" + input に対象genを刻む。
  if (gameOps.length) await applyOps(gameId, gameOps, { source: "ai", draft: true, edit_source: "revert", input: { kind: "manual", text: `gen ${gen} の変更を取り消し` } });
  return { count: gameOps.length, clarification: r.clarification, usage };
}

export async function runAgent(messages: Anthropic.MessageParam[], scene?: Scene, priorText?: string, parser: Parser = apiParser): Promise<AgentResult> {
  const gameId = scene?.game_id;
  if (!gameId) throw new Error("対象試合(scene.game_id)が指定されていません");

  const [dict, summary] = await Promise.all([dictionary(), getGameSummary(gameId)]);
  const out = await parser({ messages, scene, priorText, dict, summary });
  const usage = out.usage;

  let gameOps: GameOpInput[];
  try {
    gameOps = (out.operations ?? []).map(toGameOp);
  } catch (e) {
    return { applied: [], clarification: `操作の解釈に失敗しました: ${(e as Error).message}`, gameId, usage };
  }

  // 1返却＝1世代で原子的に反映(途中失敗なら何も入らない)
  let summaries: string[] = [];
  if (gameOps.length) {
    try {
      summaries = await applyOps(gameId, gameOps, { source: "ai", draft: true });
    } catch (e) {
      return { applied: [], clarification: `反映できませんでした: ${(e as Error).message}`, gameId, usage };
    }
  }
  const applied: Applied[] = summaries.map((s, i) => ({ tool: gameOps[i]?.type ?? "op", summary: s }));
  return { applied, clarification: out.clarification ?? null, gameId, usage };
}

/**
 * セグメント1件を型別の狭スキーマで解釈→適用(segment→loop の per-event)。
 * 狭スキーマで op が出ず content がある(型取り違えの疑い)なら、フルスキーマで再解釈してから諦める(=フォールバック層2)。
 */
export async function runSegment(seg: { type: SegType; text: string }, scene: Scene, model: string): Promise<AgentResult> {
  const gameId = scene?.game_id;
  if (!gameId) throw new Error("対象試合(scene.game_id)が指定されていません");
  const [dict, summary] = await Promise.all([dictionary(), getGameSummary(gameId)]);
  const system = buildSystem(dict, summary, scene);
  const callTool = async (tool: Anthropic.Tool, opInject?: string) => {
    const res = await client.messages.create(
      { model, max_tokens: 4000, thinking: thinkingFor(model), ...(/haiku/i.test(model) ? {} : { output_config: { effort: APP_EFFORT } }), system, tools: [tool], tool_choice: { type: "tool", name: tool.name }, messages: [{ role: "user", content: seg.text }] },
      { timeout: CALL_TIMEOUT_MS }
    );
    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const o = (tu?.input ?? { operations: [], clarification: null }) as { operations?: Op[]; clarification?: string | null };
    return {
      ops: (o.operations ?? []).map((x) => (opInject ? ({ ...x, op: opInject } as Op) : x)),
      clarification: o.clarification ?? null,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 },
    };
  };
  const route = ROUTE[seg.type] ?? ROUTE.other;
  let { ops, clarification, usage } = await callTool(route.tool, route.op);
  if (ops.length === 0 && !clarification && route.tool !== SUBMIT_TOOL && seg.text.trim()) {
    const f = await callTool(SUBMIT_TOOL); // 型取り違え救済: フルスキーマで再解釈
    ops = f.ops; clarification = f.clarification;
    usage = { input: usage.input + f.usage.input, output: usage.output + f.usage.output, cacheRead: usage.cacheRead + f.usage.cacheRead, cacheWrite: usage.cacheWrite + f.usage.cacheWrite };
  }
  let gameOps: GameOpInput[];
  try { gameOps = ops.map(toGameOp); } catch (e) { return { applied: [], clarification: `解釈失敗: ${(e as Error).message}`, gameId, usage }; }
  let summaries: string[] = [];
  if (gameOps.length) {
    try { summaries = await applyOps(gameId, gameOps, { source: "ai", draft: true }); } catch (e) { return { applied: [], clarification: `反映失敗: ${(e as Error).message}`, gameId, usage }; }
  }
  return { applied: summaries.map((s, i) => ({ tool: gameOps[i]?.type ?? "op", summary: s })), clarification, gameId, usage };
}

/**
 * flag が付いた打席を「元テキストを盤面付きで再パース → その打席を edit で差し替え」する(選択ループの1コール)。
 * 盤面(現状state)が context に入るので、bulk が取りこぼした走塁の細部を loop 品質で直せる。
 */
export async function reloopPA(gameId: string, text: string, inning: number, half: Half, order: number, model: string): Promise<{ usage: AgentResult["usage"] }> {
  const [dict, full, w] = await Promise.all([dictionary(), getGameSummary(gameId), loadWorking(gameId)]);
  // 重要: 注入する盤面は「この打席の開始時」(現在地=試合末尾ではない)。記録もこの打席より前だけ。
  let summary: unknown = full;
  if (full && w) {
    const r = (h: Half) => (h === "top" ? 0 : 1);
    const before = (p: { inning: number; half: Half; order: number }) =>
      p.inning < inning || (p.inning === inning && r(p.half) < r(half)) || (p.inning === inning && p.half === half && p.order < order);
    const target = w.doc.plate_appearances.find((p) => p.inning === inning && p.half === half && p.order === order);
    const st = target ? derivePAStates(w.doc).get(target) : undefined;
    const recorded = w.doc.plate_appearances.filter(before)
      .sort((a, b) => a.inning - b.inning || r(a.half) - r(b.half) || a.order - b.order)
      .map((p) => `${p.inning}${p.half === "top" ? "表" : "裏"}#${p.order} ${p.batter_id} ${p.result}${p.note ? `(${p.note})` : ""}`)
      .slice(-8);
    const fs = full as unknown as { state: Record<string, unknown> } & Record<string, unknown>;
    if (st) summary = { ...fs, state: { ...fs.state, inning, half, outs: st.outs, runners: st.runners }, recorded };
  }
  const system = buildSystem(dict, summary, { game_id: gameId });
  const res = await client.messages.create(
    { model, max_tokens: 4000, thinking: thinkingFor(model), ...(/haiku/i.test(model) ? {} : { output_config: { effort: APP_EFFORT } }), system, tools: [ATBAT_TOOL], tool_choice: { type: "tool", name: "atbat" }, messages: [{ role: "user", content: text }] },
    { timeout: CALL_TIMEOUT_MS }
  );
  const usage = { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 };
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const atbat = ((tu?.input ?? { operations: [] }) as { operations?: Op[] }).operations?.[0];
  if (!atbat) return { usage };
  try {
    await applyOps(gameId, [toGameOp({ ...atbat, op: "editPlateAppearance", inning, half, order } as Op)], { source: "ai", draft: true });
  } catch { /* 失敗は flag のまま残す(上位で残差扱い) */ }
  return { usage };
}
