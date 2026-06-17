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
import { loadWorking } from "@/lib/db/games";
import { derivePAStates } from "@/lib/ops/gamestate";
import type { SegType } from "./segment";
import type { Half, Runners } from "@/lib/types/v2";

const client = new Anthropic();
const MODEL = "claude-opus-4-8";
const CALL_TIMEOUT_MS = 70_000;
// 解析の既定 reasoning effort。1試合1コールなのでコスト増は僅少。複雑な試合で効く余地を残して medium。
export const APP_EFFORT = "medium" as const;

export interface Applied { tool: string; summary: string }
export interface AgentResult { applied: Applied[]; clarification: string | null; gameId: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }
export interface Scene { game_id?: string; date?: string; inning?: number; half?: string; order?: number; player_id?: string }

// 打席の付随イベント(addPlateAppearance のサブスキーマ)。得点(runs)はAIが出さずエンジンが導出。
const fieldingSchema = {
  type: ["object", "null"], description: "打球がある時。三振/四死球はnull",
  properties: {
    hit_to: { type: ["string", "null"], description: "1-9" }, hit_type: { type: ["string", "null"], description: "G=ゴロ F=飛 L=直" },
    sequence: { type: "array", items: { type: "string" } },
    outs: { type: "array", items: { type: "object", properties: { at: { type: "string" }, type: { type: "string", enum: ["force", "tag", "catch"] }, runner_id: { type: ["string", "null"] } } } },
    errors: { type: "array", items: { type: "object", properties: { pos: { type: "string" }, type: { type: "string" } } } },
  },
};
const baseAfterSchema = {
  type: "array", description: "テキストに書かれた走者の動きを入れる。from塁→to。to は 1/2/3 が進塁、home が生還、out が走塁アウト",
  items: { type: "object", properties: { from: { type: ["string", "null"], description: "移動元の塁 1/2/3" }, to: { type: "string", description: "1/2/3/home/out" }, runner_id: { type: "string", description: "省略してよい。サーバがfrom塁の走者で決める" }, reason: { type: ["string", "null"] } }, required: ["from", "to"] },
};
const baseDuringSchema = {
  type: "array", description: "打席中に起きた走塁。盗塁・暴投・牽制など、打者の結果とは別の事象",
  items: { type: "object", properties: { event: { type: "string", description: "SB盗塁 CS盗塁死 WP暴投 PB捕逸 PO牽制 BK" }, runners: { type: "array", items: { type: "object", properties: { from: { type: ["string", "null"] }, to: { type: "string", description: "1/2/3/home/out" }, runner_id: { type: "string", description: "省略してよい。サーバがfrom塁で決める" } }, required: ["from", "to"] } }, note: { type: ["string", "null"] } }, required: ["event"] },
};

// 守備位置変更(delta): 該当選手の位置だけ差し替える。打順・他の選手は不変。
const defenseChangeSchema = {
  type: "array", description: "守備位置変更。該当選手の位置だけ差し替える",
  items: { type: "object", properties: {
    player_id: { type: "string", description: "対象選手のP-id/助っ人名。from_positionで特定する場合は不要" },
    from_position: { type: ["string", "null"], description: "旧守備位置 1-9/DH。位置起点の表記『2->5』『ピッチャー→サード』で対象を指す時に使う" },
    to_position: { type: "string", description: "新守備位置 1投2捕3一4二5三6遊7左8中9右/DH" },
  }, required: ["to_position"] },
};

// 単一の操作(op で種別)。result の名前衝突を避け、打席結果は result_code、試合結果は game_result。
const operationSchema = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["setGameMeta", "setStartingLineup", "changeDefense", "addPlateAppearance", "editPlateAppearance", "removePlateAppearance"], description: "操作の種別" },
    changes: defenseChangeSchema,
    order: { type: "integer", description: "edit/removeの対象＝その半イニング内の打席番号(記録済みダイジェストの #N)" },
    // setGameMeta
    date: { type: "string", description: "YYYY-MM-DD" }, opponent: { type: "string" }, league: { type: ["string", "null"] },
    home_away: { type: ["string", "null"], enum: ["home", "away", null], description: "away=先攻 home=後攻" }, dh: { type: "boolean" },
    game_result: { type: ["object", "null"], properties: { our_score: { type: "integer" }, their_score: { type: "integer" }, outcome: { type: "string", enum: ["win", "loss", "tie"] }, decided_by: { type: "string", enum: ["regulation", "time_limit", "walkoff", "called", "forfeit", "tie"] } } },
    // setStartingLineup
    rows: { type: "array", items: { type: "object", properties: { order: { type: "integer", description: "打順1-9" }, position: { type: ["string", "null"], description: "守備位置 1投2捕3一4二5三6遊7左8中9右/DH" }, player_id: { type: "string", description: "自軍正規選手のP-id" }, guest_name: { type: "string", description: "助っ人名(P-idが無い時)" } }, required: ["order", "position"] } },
    // addPlateAppearance（order/打順/アウト/走者/投捕/得点はサーバが導出）
    inning: { type: "integer", description: "回" }, half: { type: "string", enum: ["top", "bottom"], description: "top/bottom" },
    batter_id: { type: "string", description: "打者名" },
    result_code: { type: "string", enum: ["H1", "H2", "H3", "HR", "OUT", "K", "BB", "HBP", "FC", "E", "SH", "SF", "INC"], description: "H1単打 H2二塁打 H3三塁打 HR本塁打 OUT凡退 K三振 BB四球 HBP死球 FC野選 E失策 SH犠打 SF犠飛 INC未完了" },
    fielding: fieldingSchema, baserunning_after: baseAfterSchema, baserunning_during: baseDuringSchema,
    note: { type: ["string", "null"], description: "実況" },
  },
  required: ["op"],
};

const SUBMIT_TOOL: Anthropic.Tool = {
  name: "submit",
  description: "入力テキストから導いた操作の配列を提出する。述べられた出来事だけを操作にする。曖昧で確定できなければ operations を空にし clarification に質問を入れる。",
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
    batter_id: { type: "string", description: "打者名" },
    inning: { type: "integer", description: "回" },
    half: { type: "string", enum: ["top", "bottom"], description: "top/bottom" },
    baserunning_after: baseAfterSchema, baserunning_during: baseDuringSchema, fielding: fieldingSchema,
    note: { type: ["string", "null"], description: "実況" },
  },
  required: ["result_code"],
};
const ATBAT_TOOL: Anthropic.Tool = {
  name: "atbat",
  description: "入力テキストにある全打席を、1打席=operations の1要素として順に出す。得点・得点者・打点・投捕はサーバが導くので入れない。曖昧な打席だけ operations から落とし clarification に質問。",
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

/** 不変の指示(キャッシュ対象)。制約はスキーマ(各フィールドのdescription/enum)が持つ。ここは役割だけ。 */
function instructions(): string {
  return "N-KINGSのスコア入力の変換器。入力テキストの内容だけを、渡されたツールのスキーマに落とす。会話しない。推測で項目を埋めず、確定できなければ operations を空にして clarification に短い質問を入れる。";
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

/** AIのフラットな op(op/result_code/game_result) を ops層の GameOpInput(type/result) へ写す。 */
function toGameOp(op: Op): GameOpInput {
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
    const { op: _o, result_code, ...rest } = op; void _o;
    return { type: "addPlateAppearance", ...rest, result: result_code } as GameOpInput;
  }
  if (op.op === "editPlateAppearance") {
    const { op: _o, result_code, ...rest } = op; void _o;
    return { type: "editPlateAppearance", ...rest, ...(result_code !== undefined ? { result: result_code } : {}) } as GameOpInput;
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

/** モデル指定の本番パーサを作る(強制ツールで構造化出力・thinking無効・effort低・キャッシュ)。ここだけ実APIを叩く。 */
export function makeApiParser(model: string, maxTokens = 4000): Parser {
  return async ({ messages, scene, dict, summary }) => {
    const system = buildSystem(dict, summary, scene);
    const effort = /haiku/i.test(model) ? {} : { output_config: { effort: APP_EFFORT } }; // Haikuはeffort非対応
    const res = await client.messages.create(
      { model, max_tokens: maxTokens, thinking: { type: "disabled" }, ...effort, system, tools: [SUBMIT_TOOL], tool_choice: { type: "tool", name: "submit" }, messages },
      { timeout: CALL_TIMEOUT_MS }
    );
    const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const out = (tu?.input ?? { operations: [], clarification: null }) as { operations?: Op[]; clarification?: string | null };
    return {
      operations: out.operations ?? [], clarification: out.clarification ?? null,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 },
    };
  };
}

/** 本番既定パーサ(Opus 4.8)。 */
export const apiParser: Parser = makeApiParser(MODEL);

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
  const res = await client.messages.stream({
    model, max_tokens: 20000, thinking: { type: "disabled" },
    ...(/haiku/i.test(model) ? {} : { output_config: { effort: APP_EFFORT } }),
    system, tools: [SUBMIT_TOOL], tool_choice: { type: "tool", name: "submit" }, messages: [{ role: "user", content: memo }],
  }).finalMessage();
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const out = (tu?.input ?? { operations: [], clarification: null }) as { operations?: Op[]; clarification?: string | null };
  const usage = { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 };
  let gameOps: GameOpInput[];
  try { gameOps = (out.operations ?? []).map(toGameOp); }
  catch (e) { return { count: 0, clarification: `操作の解釈に失敗しました: ${(e as Error).message}`, usage }; }
  if (gameOps.length) await applyOps(gameId, gameOps, { source: "ai", draft: true });
  return { count: gameOps.length, clarification: out.clarification ?? null, usage };
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
      { model, max_tokens: 4000, thinking: { type: "disabled" }, ...(/haiku/i.test(model) ? {} : { output_config: { effort: APP_EFFORT } }), system, tools: [tool], tool_choice: { type: "tool", name: tool.name }, messages: [{ role: "user", content: seg.text }] },
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
    { model, max_tokens: 4000, thinking: { type: "disabled" }, ...(/haiku/i.test(model) ? {} : { output_config: { effort: APP_EFFORT } }), system, tools: [ATBAT_TOOL], tool_choice: { type: "tool", name: "atbat" }, messages: [{ role: "user", content: text }] },
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

/**
 * AI修正(差分): 1打席を自然言語の指示で直す。現在の記録＋開始盤面を文脈に与え、修正後の打席を ATBAT_TOOL で出させて
 * editPlateAppearance で1件だけ反映する(差分・全量再集計しない)。整合性は取らない(repair:false)＝ユーザーがプレビューで確認・確定。
 */
export async function editPA(gameId: string, inning: number, half: Half, order: number, instruction: string, model: string): Promise<{ ok: boolean; message: string; usage?: AgentResult["usage"] }> {
  const [dict, full, w] = await Promise.all([dictionary(), getGameSummary(gameId), loadWorking(gameId)]);
  if (!w) return { ok: false, message: "試合が見つかりません" };
  const target = w.doc.plate_appearances.find((p) => p.inning === inning && p.half === half && p.order === order);
  if (!target) return { ok: false, message: "対象の打席が見つかりません" };
  const st = derivePAStates(w.doc).get(target);
  const fs = full as unknown as { state: Record<string, unknown> } & Record<string, unknown>;
  const summary = st ? { ...fs, state: { ...fs.state, inning, half, outs: st.outs, runners: st.runners } } : full;
  const system = buildSystem(dict, summary, { game_id: gameId });
  const cur = `現在の記録: 打者=${target.batter_id} 結果=${target.result} 得点=${target.runs?.length ?? 0}${target.note ? ` 実況=${target.note}` : ""}`;
  const userMsg = `次の1打席を指示どおりに直し、修正後の打席(全体)を atbat で1件だけ出してください。\n${cur}\n指示: ${instruction}`;
  const res = await client.messages.create(
    { model, max_tokens: 4000, thinking: { type: "disabled" }, ...(/haiku/i.test(model) ? {} : { output_config: { effort: APP_EFFORT } }), system, tools: [ATBAT_TOOL], tool_choice: { type: "tool", name: "atbat" }, messages: [{ role: "user", content: userMsg }] },
    { timeout: CALL_TIMEOUT_MS }
  );
  const usage = { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 };
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const out = (tu?.input ?? { operations: [] }) as { operations?: Op[]; clarification?: string | null };
  const atbat = out.operations?.[0];
  if (!atbat) return { ok: false, message: out.clarification ?? "指示を解析できませんでした。具体的に書いてください。", usage };
  try {
    // repair:false=整合性を取らない(手動の特別対応)。差分のみ反映。
    await applyOps(gameId, [toGameOp({ ...atbat, op: "editPlateAppearance", inning, half, order } as Op)], { source: "ai", draft: true, repair: false });
  } catch (e) {
    return { ok: false, message: `反映できませんでした: ${(e as Error).message}`, usage };
  }
  return { ok: true, message: `${inning}回${half === "top" ? "表" : "裏"} ${order}番目の打席を修正しました`, usage };
}
