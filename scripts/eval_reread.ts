/**
 * [評価ハーネス・読み取りのみ] 「AI集計→機械検算でフラグ→AIにノートを読み直させて切り分け」案の有効性を、
 * 過去の実フラグと「人の実際の処置」(後続の版履歴から導出)を正解ラベルにして測る。
 *
 * サブコマンド:
 *   --collect                 : 版履歴から検算フラグのケースを抽出(APIなし・DB読み取りのみ)→ private/eval_reread_cases.json
 *   --run [--limit N] [--game ID] [--model M] [--redo]
 *                             : 読み直し契約(reread ツール強制)を実APIで実行し、採用ゲート(G1/G2)をメモリ内で評価
 *                               → private/eval_reread_results.json に追記。★実行はユーザー承認後(実APIコール・課金あり)。DBへは書かない。
 *   --report                  : verdict × 人の処置 のクロス表・evidence有効率・G2採用率・作文候補・コスト概算
 *   --synth [--games id,id] [--model M]
 *                             : 正解付きコーパス。成績メモの行範囲をノートに AI集計を実APIで1試合1コール→ DB へ書かず
 *                               メモリ内で畳む(foldOpsInMemory)→検算フラグを1ケースずつ抽出。正解=loadGame(公開版・人が検証済み)。
 *                               ケースに truth_pa(正解の同打席)/ai_pa(集計時の打席)、試合ごとの集計 usage(cost_aggregate) を保存
 *                               → private/eval_reread_synth_cases.json。★実APIコール・課金あり(ユーザー承認後)。DB読み取りのみ。
 *   共通: --cases <path>      : --run/--report が読むケースファイル(既定=collect 出力)。結果は <同名>_results.json に対で保存。
 *                               synth ケースの --report は正解突合(verdict × truth_label / fix_correct / 作文候補)と料金(集計＋読み直し)を出す。
 *
 * 機密: 試合データ/ノート/成績メモはリポに含めない。出力は全て private/ 配下(gitignore済)。成績メモは行範囲で読むだけ。
 * 実行: node --env-file=.env.local --import tsx scripts/eval_reread.ts --collect
 *       node --env-file=.env.local --import tsx scripts/eval_reread.ts --synth
 *       node --env-file=.env.local --import tsx scripts/eval_reread.ts --run --cases private/eval_reread_synth_cases.json
 *       node --env-file=.env.local --import tsx scripts/eval_reread.ts --report --cases private/eval_reread_synth_cases.json
 */
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SUBMIT_TOOL, instructions, APP_EFFORT, thinkingFor, toGameOp, submitOnceFor, normalizeOperations } from "../lib/ai/agent";
import { isOpenAiModel, openaiSubmitOnce } from "../lib/ai/openai";
import { previewEditPA, foldOpsInMemory, resolveGuestNamesInOps, type EditPAInput, type GameOpInput } from "../lib/ops/games";
import { validateGame, type GameFlag } from "../lib/ops/validate";
import { derivePAStates, foldRunners, deriveScorers } from "../lib/ops/gamestate";
import { outsMade } from "../lib/agg";
import { batterLabel, playLine, duringLines } from "../lib/textlog";
import { docNameResolver } from "../lib/names";
import { listPlayers } from "../lib/ops/players";
import { loadPlayers } from "../lib/db/players";
import { loadGames, loadGame, draftGameIds, listVersions, loadVersion } from "../lib/db/games";
import { loadNote } from "../lib/db/notes";
import { getClient } from "../lib/db/mongo";
import type { GameDoc, GameVersion, Half, PlateAppearance } from "../lib/types/v2";

const OUT_DIR = "F:/kings/kings-score-book/private";
const CASES_PATH = `${OUT_DIR}/eval_reread_cases.json`;
const SYNTH_CASES_PATH = `${OUT_DIR}/eval_reread_synth_cases.json`;
/** ケースファイルと結果ファイルは対(同じ basename で _cases→_results)。--cases で差し替えても結果が混ざらない。 */
const resultsPathFor = (casesPath: string) => casesPath.replace(/_cases\.json$/, "_results.json");

// ===== データ形 =====

/** 打席の参照。id(不変ID)があれば id、無ければ回/表裏/order。後続版での同打席の追跡に使う。 */
interface PARef { id?: string; inning: number; half: Half; order: number }
type Disposition = "edited" | "approved" | "reaggregated" | "open";

interface EvalCase {
  case_id: string; // gameId:gen:paKey:rule
  game_id: string;
  gen: number; // フラグが付いた ai_aggregate 版
  pa: PARef;
  rule: string; // R1..R11 (validator) / "AI" (AI由来の unclear)
  detail: string; // フラグ文
  doc_ref: string; // versions[doc_ref].doc (同一版の doc をケース間で共有)
  note: string; // 現在のノート(loadNote)。公開後は空のことがある
  note_input: string | null; // その版を生んだ入力ノート(version.input.text)。読み直しの主入力(=AIが実際に読んだ文)
  disposition: Disposition;
  disposition_gen: number | null; // 処置を検出した版
  // --synth のみ: 正解突合用。truth_pa=公開版(人が検証済み)の同 inning/half/order の打席(無ければ null)、ai_pa=集計時の打席
  truth_pa?: PlateAppearance | null;
  ai_pa?: PlateAppearance;
}
/** --synth の試合ごとの集計コール記録(料金計測=cost_aggregate)。 */
interface AggregateRecord {
  game_id: string; model: string; effort: string; usage: Usage; ms: number;
  ops: number; pa_ai: number; pa_truth: number; flags: number; clarification: string | null;
  error: string | null; // 出力形式崩れ / toGameOp / 畳み込み(reducer)失敗。ケースは出ない
  ran_at: string;
}
interface CasesFile {
  collected_at: string;
  kind?: "collect" | "synth"; // 省略=collect(旧ファイル互換)
  versions: Record<string, { game_id: string; gen: number; doc: GameDoc }>;
  cases: EvalCase[];
  // --synth のみ: 集計コールの usage(試合別) と、畳み込み時の選手辞書(id→名前。助っ人仮ID GUEST:名前 を含む)。
  //   --report は DB を開かないので、名前解決/previewEditPA の masters をここから復元する。
  cost_aggregate?: Record<string, AggregateRecord>;
  masters?: Record<string, string>;
}

type Verdict = "transcription_fix" | "source_ambiguous" | "undecidable";
interface RereadOut { verdict?: Verdict; evidence?: string; explanation?: string; fix?: Record<string, unknown> | null }
interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
interface EvalResult {
  case_id: string;
  model: string;
  effort: string;
  verdict: Verdict | "invalid_output";
  evidence: string;
  explanation: string;
  fix: Record<string, unknown> | null;
  g1: "ok" | "evidence_invalid";
  // G2: transcription_fix のみ評価。それ以外は "n/a"
  g2: "accepted" | "gate_rejected" | "n/a";
  g2_reason: "still_flagged" | "new_flags" | "apply_error" | "no_fix" | "ai_rule_no_substantive_fix" | null;
  g2_detail: string | null; // apply_error のメッセージ / new_flags の内訳
  flags_before: number | null;
  flags_after: number | null;
  usage: Usage;
  ms: number;
  ran_at: string;
}

// ===== 共通ユーティリティ =====

const halfJp = (h: Half) => (h === "top" ? "表" : "裏");
const paKeyOf = (p: PlateAppearance): string => p.id ?? `${p.inning}-${p.half}-${p.order}`;
const refOf = (p: PlateAppearance): PARef => ({ ...(p.id ? { id: p.id } : {}), inning: p.inning, half: p.half, order: p.order });

/** 後続版で同じ打席を見つける。両方に id があれば id、さもなくば回/表裏/order(=削除で order がズレると別打席に化ける限界は承知)。 */
function findPA(doc: GameDoc, ref: PARef): PlateAppearance | undefined {
  if (ref.id) {
    const byId = doc.plate_appearances.find((p) => p.id === ref.id);
    if (byId) return byId;
  }
  return doc.plate_appearances.find((p) => p.inning === ref.inning && p.half === ref.half && p.order === ref.order);
}

/** 「内容が変わったか」の比較キー。人が直す対象=結果/打者/打球/走塁。
 *  走塁の runner_id は上流編集のスイープで機械的に再解決されうる(人の編集でなくても変わる)ので比較から外し、from/to/event だけ見る。 */
function contentKey(p: PlateAppearance): string {
  const after = (p.baserunning_after ?? []).map((m) => ({ from: m.from ?? null, to: m.to }));
  const during = (p.baserunning_during ?? []).map((d) => ({ event: d.event, runners: (d.runners ?? []).map((m) => ({ from: m.from ?? null, to: m.to })) }));
  return JSON.stringify({ result: p.result, batter: p.batter_id, fielding: p.fielding ?? null, after, during });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function writeJson(path: string, v: unknown): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 1), "utf8");
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

/** 集計表示用: Map<string, number> をキー順に1行ずつ */
function printCounts(title: string, m: Map<string, number>): void {
  console.log(`\n${title}`);
  for (const k of [...m.keys()].sort()) console.log(`  ${k.padEnd(16)} ${m.get(k)}`);
}
const inc = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

// ===== --collect =====

/** ケース1件の人の処置を、フラグ版より後の版から導出する。
 *  走査は「次の ai_aggregate 版」まで: 作り直し後の打席は別の転記なので、その先の編集/承認はこのケースの処置ではない。
 *  優先: edited > approved > reaggregated > open。 */
function deriveDisposition(flagDoc: GameDoc, later: GameVersion[], ref: PARef, rule: string): { disposition: Disposition; gen: number | null } {
  let edited: number | null = null, approved: number | null = null, reagg: number | null = null;
  // 比較の初期基準はフラグ版自身の打席(直後の manual 版で直された差分を見落とさない=レビュー指摘)
  let prevPA: PlateAppearance | undefined = findPA(flagDoc, ref);
  for (let i = 0; i < later.length; i++) {
    const v = later[i];
    if (v.edit_source === "ai_aggregate") { reagg = v.gen; break; }
    const cur = findPA(v.snapshot, ref);
    if (cur && prevPA && v.edit_source === "manual" && contentKey(cur) !== contentKey(prevPA)) edited ??= v.gen;
    if (cur && (cur.annotations ?? []).some((a) => a.type === "resolved" && (rule === "AI" ? !a.rule : a.rule === rule))) approved ??= v.gen;
    if (cur) prevPA = cur;
  }
  if (edited != null) return { disposition: "edited", gen: edited };
  if (approved != null) return { disposition: "approved", gen: approved };
  if (reagg != null) return { disposition: "reaggregated", gen: reagg };
  return { disposition: "open", gen: null };
}

async function collect(): Promise<void> {
  const games = await loadGames();
  const ids = [...new Set([...games.map((g) => g.game.id), ...(await draftGameIds())])].sort();
  const out: CasesFile = { collected_at: new Date().toISOString(), versions: {}, cases: [] };
  const seen = new Set<string>();
  let versionsScanned = 0;

  for (const gameId of ids) {
    const metas = (await listVersions(gameId)).sort((a, b) => a.gen - b.gen);
    if (!metas.some((m) => m.edit_source === "ai_aggregate")) continue;
    // 版を全部メモリに乗せる(処置の導出は連続する版の差分を見る)。読み取りのみ。
    const versions: GameVersion[] = [];
    for (const m of metas) { const v = await loadVersion(gameId, m.gen); if (v) versions.push(v); }
    versionsScanned += versions.length;
    const note = await loadNote(gameId);

    for (let i = 0; i < versions.length; i++) {
      const v = versions[i];
      if (v.edit_source !== "ai_aggregate") continue;
      const later = versions.slice(i + 1);
      const docRef = `${gameId}:${v.gen}`;
      for (const p of v.snapshot.plate_appearances) {
        for (const a of p.annotations ?? []) {
          if (a.type !== "unclear") continue;
          let rule: string | null = null;
          if (a.source === "validator" && a.rule && /^R\d+$/.test(a.rule)) rule = a.rule;
          else if (a.source === "ai") rule = "AI";
          if (!rule) continue;
          const paKey = paKeyOf(p);
          const dedupe = `${gameId}:${paKey}:${rule}`; // 同一打席・同一ruleは最初の出現のみ(後続の ai_aggregate 版でも再出現しうる)
          if (seen.has(dedupe)) continue;
          seen.add(dedupe);
          out.versions[docRef] ??= { game_id: gameId, gen: v.gen, doc: v.snapshot };
          const disp = deriveDisposition(v.snapshot, later, refOf(p), rule);
          out.cases.push({
            case_id: `${gameId}:${v.gen}:${paKey}:${rule}`,
            game_id: gameId, gen: v.gen, pa: refOf(p), rule, detail: a.detail, doc_ref: docRef,
            note, note_input: v.input?.kind === "note" ? v.input.text : null,
            disposition: disp.disposition, disposition_gen: disp.gen,
          });
        }
      }
    }
  }
  writeJson(CASES_PATH, out);

  // サマリ(件数・トークン見積り)。内容(ノート/名前)は出さない。
  const byRule = new Map<string, number>(), byDisp = new Map<string, number>();
  for (const c of out.cases) { inc(byRule, c.rule); inc(byDisp, c.disposition); }
  console.log(`試合 ${ids.length} 件 / 版 ${versionsScanned} 件を走査 → ケース ${out.cases.length} 件 (${Object.keys(out.versions).length} 版の doc を保持)`);
  printCounts("rule別", byRule);
  printCounts("disposition別", byDisp);
  // rule × disposition
  const cross = new Map<string, number>();
  for (const c of out.cases) inc(cross, `${c.rule.padEnd(4)} ${c.disposition}`);
  printCounts("rule × disposition", cross);

  // AIコール1回あたりの概算入力トークン: ノート文字数/2 + 記録分(該当半イニングPBP+打席JSON+フラグ文 ≒ 1,200字/2) + 辞書/役割文(≒ 800)
  const dictLen = (await listPlayers()).map((p) => `${p.id}=${p.name}`).join(", ").length;
  const est = out.cases.map((c) => Math.round((c.note_input ?? c.note).length / 2 + 600 + dictLen / 2 + 400));
  const total = est.reduce((a, b) => a + b, 0);
  console.log(`\n入力トークン概算: 1コール平均 ${Math.round(total / Math.max(1, est.length))} / 全 ${est.length} ケース合計 ${total} (出力は別途 ~300/コール見込み)`);
  console.log(`保存: ${CASES_PATH}`);
}

// ===== --run =====

/** 読み直し専用ツール。fix のサブスキーマは既存 operationSchema(SUBMIT_TOOL 内)から取り出して再利用＝本番と同じ語彙で直させる。 */
function buildRereadTool(): Anthropic.Tool {
  const opProps = ((SUBMIT_TOOL.input_schema as { properties: { operations: { items: { properties: Record<string, unknown> } } } }).properties.operations.items.properties);
  const pick = (k: string) => opProps[k];
  return {
    name: "reread",
    description: "検算の指摘を受けた打席について、ノート全文を読み直して判定を提出する。",
    input_schema: {
      type: "object",
      properties: {
        verdict: {
          type: "string", enum: ["transcription_fix", "source_ambiguous", "undecidable"],
          description: "transcription_fix=ノートには明確に書いてあり記録がそれと違う(転記ミス→fix で直す) / source_ambiguous=ノート自身が曖昧・矛盾・欠落で確定できない / undecidable=どちらとも判断できない",
        },
        evidence: { type: "string", description: "判定の根拠となるノート原文の引用(必須・1文でよい)。ノートの文字列をそのまま抜き出す(改変・要約・補完をしない)" },
        explanation: { type: "string", description: "判定理由。人向けに1-2文" },
        fix: {
          type: ["object", "null"],
          description: "verdict=transcription_fix の時だけ。直すフィールドだけ入れる(他は省略=現記録を保持)",
          properties: {
            result_code: pick("result_code"), batter_id: pick("batter_id"), fielding: pick("fielding"),
            baserunning_after: pick("baserunning_after"), baserunning_during: pick("baserunning_during"), note: pick("note"),
          },
        },
      },
      required: ["verdict", "evidence", "explanation"],
    },
  };
}

/** システム文 = 本番の役割文 + 読み直しの追加指示。 */
function rereadSystem(): string {
  return instructions() +
    "\n\n今回の仕事: 検算の指摘を受けた打席について、ノート全文を読み直す。記録がノートの記述と違うなら転記ミスとして直す(transcription_fix)。" +
    "ノート自身が曖昧・矛盾・欠落で確定できないなら source_ambiguous。evidence にはノート原文をそのまま引用する(改変しない)。";
}

/** ユーザー入力 = ノート全文 + 該当打席の現記録(半イニングのPBPと打席JSON) + フラグ文 + 選手辞書。 */
function rereadUser(c: EvalCase, doc: GameDoc, masters: Map<string, string>, dict: string): string {
  const nameOf = docNameResolver(doc, masters);
  const states = derivePAStates(doc);
  const target = findPA(doc, c.pa);
  const halfPAs = doc.plate_appearances.filter((p) => p.inning === c.pa.inning && p.half === c.pa.half).sort((a, b) => a.order - b.order);
  const pbp = halfPAs.map((p) => {
    const st = states.get(p) ?? { outs: p.outs ?? 0, order: p.order };
    const during = duringLines(p, nameOf).map((d) => ` / ${d}`).join("");
    return `${p === target ? "★" : "  "}#${st.order} ${batterLabel(p, nameOf)}: ${playLine(p, st.outs)}${during}`;
  }).join("\n");
  const rec = target ? {
    batter: nameOf(target.batter_id), result: target.result, fielding: target.fielding ?? null,
    baserunning_during: (target.baserunning_during ?? []).map((d) => ({ event: d.event, runners: (d.runners ?? []).map((m) => ({ who: nameOf(m.runner_id), from: m.from, to: m.to })) })),
    baserunning_after: target.baserunning_after.map((m) => ({ who: nameOf(m.runner_id), from: m.from, to: m.to })),
    runs: target.runs.map((r) => ({ who: nameOf(r.runner_id), rbi: r.rbi })), note: target.note ?? null,
  } : null;
  const note = c.note_input ?? c.note;
  return [
    `■ノート全文\n${note}`,
    `■該当打席: ${c.pa.inning}回${halfJp(c.pa.half)} #${c.pa.order}\n${c.pa.inning}回${halfJp(c.pa.half)}の現記録(★が該当打席):\n${pbp}\n該当打席の記録(JSON):\n${JSON.stringify(rec)}`,
    `■検算の指摘(${c.rule}): ${c.detail}`,
    `■選手名→ID:\n${dict}`,
  ].join("\n\n");
}

let anthropic: Anthropic | null = null;
/** provider seam(本番 submitOnceFor と同じ切替規則)。reread ツールを強制し toolInput と usage を返す。 */
async function rereadOnce(model: string, system: string, user: string, tool: Anthropic.Tool): Promise<{ toolInput: unknown; usage: Usage }> {
  if (isOpenAiModel(model)) {
    return openaiSubmitOnce({ model, effort: APP_EFFORT, systemText: system, userText: user, maxTokens: 8000, toolName: tool.name, toolDescription: tool.description ?? "", toolSchema: tool.input_schema });
  }
  anthropic ??= new Anthropic();
  const res = await anthropic.messages.create(
    { model, max_tokens: 8000, thinking: thinkingFor(model), ...(/haiku/i.test(model) ? {} : { output_config: { effort: APP_EFFORT } }), system, tools: [tool], tool_choice: { type: "tool", name: tool.name }, messages: [{ role: "user", content: user }] },
    { timeout: 300_000 },
  );
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return { toolInput: tu?.input, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheRead: res.usage.cache_read_input_tokens ?? 0, cacheWrite: res.usage.cache_creation_input_tokens ?? 0 } };
}

// ----- 採用ゲート(本番案と同一ロジック) -----

/** G1: evidence がノート原文に部分一致するか。空白/改行(全角空白含む)を全て除いて比べる＝改行位置や字間の揺れは許し、字句の改変は許さない。 */
export function evidenceMatches(note: string, evidence: string): boolean {
  const norm = (s: string) => s.replace(/[\s\u3000]+/g, "");
  const e = norm(evidence);
  return e.length > 0 && norm(note).includes(e);
}

const flagKey = (f: GameFlag) => `${f.inning}-${f.half}-${f.order}:${f.rule}`;
/** G2: fix をメモリ内適用(previewEditPA=本番 reduceEditPA)→ validateGame。(i)対象フラグが消え (ii)unclear総数が増えないなら accepted。 */
function gateApply(c: EvalCase, doc: GameDoc, fix: Record<string, unknown>, masters: Map<string, string>): Pick<EvalResult, "g2" | "g2_reason" | "g2_detail" | "flags_before" | "flags_after"> {
  // AI由来(rule="AI")の unclear は validateGame の対象外=編集の clear_unclear で機械的に消える。result/fielding/走塁のどれも
  // 含まない fix(note だけ等)は「何も検証していない採用」になるため n/a とする(レビュー指摘)。
  if (c.rule === "AI" && !["result_code", "fielding", "baserunning_after", "baserunning_during", "batter_id"].some((k) => fix[k] !== undefined)) {
    return { g2: "n/a", g2_reason: "ai_rule_no_substantive_fix", g2_detail: null, flags_before: null, flags_after: null };
  }
  const nameOf = docNameResolver(doc, masters);
  const before = validateGame(doc, nameOf);
  const targetKey = `${c.pa.inning}-${c.pa.half}-${c.pa.order}:${c.rule}`;
  let next: GameDoc;
  try {
    // AIの語彙(result_code/漢字hit_to)→ops層の写像は本番と同じ toGameOp を通す(editPlateAppearance は clear_unclear:true が付く)
    const op = toGameOp({ ...fix, op: "editPlateAppearance", inning: c.pa.inning, half: c.pa.half, order: c.pa.order, ...(c.pa.id ? { pa_id: c.pa.id } : {}) }) as GameOpInput;
    const { type: _t, ...input } = op as { type: string } & EditPAInput; void _t;
    next = previewEditPA(doc, input, masters);
  } catch (e) {
    return { g2: "gate_rejected", g2_reason: "apply_error", g2_detail: (e as Error).message, flags_before: before.length, flags_after: null };
  }
  const after = validateGame(next, docNameResolver(next, masters));
  // 対象フラグ: validator 由来(R*)なら同打席・同rule が残っていないこと。AI由来("AI")は validateGame の対象外=編集(clear_unclear)で消える扱い
  const stillFlagged = c.rule !== "AI" && after.some((f) => flagKey(f) === targetKey);
  if (stillFlagged) return { g2: "gate_rejected", g2_reason: "still_flagged", g2_detail: null, flags_before: before.length, flags_after: after.length };
  if (after.length > before.length) {
    const beforeKeys = new Set(before.map(flagKey));
    const added = after.filter((f) => !beforeKeys.has(flagKey(f))).map((f) => `${flagKey(f)} ${f.detail}`);
    return { g2: "gate_rejected", g2_reason: "new_flags", g2_detail: added.join(" | "), flags_before: before.length, flags_after: after.length };
  }
  return { g2: "accepted", g2_reason: null, g2_detail: null, flags_before: before.length, flags_after: after.length };
}

async function run(): Promise<void> {
  const casesPath = arg("--cases") ?? CASES_PATH;
  if (!("/" + casesPath.split("\\").join("/")).includes("/private/")) throw new Error("--cases は private/ 配下のファイルのみ(結果にノート引用が含まれるため)");
  const resultsPath = resultsPathFor(casesPath);
  const cases = readJson<CasesFile | null>(casesPath, null);
  if (!cases) throw new Error(`ケースが無い: 先に --collect / --synth を実行 (${casesPath})`);
  const model = arg("--model") ?? process.env.AI_MODEL ?? "gpt-5.6-sol";
  const rawLimit = arg("--limit");
  if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) throw new Error(`--limit は正の整数で指定してください: ${rawLimit}`);
  const limit = rawLimit === undefined ? Infinity : Number(rawLimit);
  const gameFilter = arg("--game");
  const results = readJson<EvalResult[]>(resultsPath, []);
  const done = new Set(has("--redo") ? [] : results.map((r) => r.case_id));
  const targets = cases.cases.filter((c) => (!gameFilter || c.game_id === gameFilter) && !done.has(c.case_id)).slice(0, limit);
  console.log(`model=${model} effort=${APP_EFFORT} 対象 ${targets.length} 件 (全 ${cases.cases.length} 件・既実行 ${done.size} 件はスキップ)`);

  const [dbMasters, players] = await Promise.all([loadPlayers(), listPlayers()]);
  // synth ケースは助っ人を仮ID(GUEST:名前)で畳んでいる=DBマスタに無いので、保存した辞書を重ねて名前解決/編集の存在チェックを通す
  const masters = new Map([...dbMasters, ...Object.entries(cases.masters ?? {})]);
  const dict = players.map((p) => `${p.id}=${p.name}`).join(", ");
  const tool = buildRereadTool();
  const system = rereadSystem();
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const c of targets) {
    const doc = cases.versions[c.doc_ref].doc;
    const note = c.note_input ?? c.note;
    const t0 = Date.now();
    let out: RereadOut = {}, usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      const r = await rereadOnce(model, system, rereadUser(c, doc, masters, dict), tool);
      usage = r.usage;
      if (r.toolInput && typeof r.toolInput === "object" && !Array.isArray(r.toolInput)) out = r.toolInput as RereadOut;
    } catch (e) {
      console.log(`  ${c.case_id} ERROR ${(e as Error).message}`);
      continue; // API失敗は記録しない(再実行で拾う)
    }
    const ms = Date.now() - t0;
    const verdict: EvalResult["verdict"] = out.verdict === "transcription_fix" || out.verdict === "source_ambiguous" || out.verdict === "undecidable" ? out.verdict : "invalid_output";
    const evidence = typeof out.evidence === "string" ? out.evidence : "";
    const g1: EvalResult["g1"] = evidenceMatches(note, evidence) ? "ok" : "evidence_invalid";
    const fix = out.fix && typeof out.fix === "object" ? out.fix : null;
    let gate: Pick<EvalResult, "g2" | "g2_reason" | "g2_detail" | "flags_before" | "flags_after"> =
      { g2: "n/a", g2_reason: null, g2_detail: null, flags_before: validateGame(doc, docNameResolver(doc, masters)).length, flags_after: null };
    if (verdict === "transcription_fix") {
      gate = fix && Object.keys(fix).length > 0 ? gateApply(c, doc, fix, masters) : { ...gate, g2: "gate_rejected", g2_reason: "no_fix" };
    }
    const rec: EvalResult = {
      case_id: c.case_id, model, effort: APP_EFFORT, verdict, evidence, explanation: String(out.explanation ?? ""), fix,
      g1, ...gate, usage, ms, ran_at: new Date().toISOString(),
    };
    const dup = results.findIndex((r) => r.case_id === rec.case_id);
    if (dup >= 0) results.splice(dup, 1); // --redo 時は同ケースを置換(重複集計を防ぐ)
    results.push(rec);
    writeJson(resultsPath, results); // 1件ごとに追記保存(途中中断でも失わない)
    for (const k of Object.keys(sum) as (keyof Usage)[]) sum[k] += usage[k];
    console.log(`  ${c.case_id} [${c.disposition}] → ${verdict} G1=${g1} G2=${gate.g2}${gate.g2_reason ? `(${gate.g2_reason})` : ""} in=${usage.input} out=${usage.output} ${ms}ms`);
  }
  console.log(`\n合計 usage: in=${sum.input} out=${sum.output} cacheRead=${sum.cacheRead}`);
  console.log(`保存: ${resultsPath}`);
}

// ===== --synth =====

/** 対象3試合: gameId → 成績メモ.txt の行範囲(1-indexed・両端含む)。ab_persona.ts の既知値と同じ。 */
const SYNTH_GAMES: Record<string, [number, number]> = {
  "8b731da77d": [341, 452], // BUZZ 2026-02-22
  "c24a6567ad": [784, 941], // ブレイブハーツ 2026-04-26
  "09932f169a": [217, 338], // ヤンキーズ 2026-02-15
};

/** 成績メモ.txt から行範囲で1試合分を切り出す(ab_persona.ts の memoSlice と同じ)。中身は機密=リポ/ログに出さない。
 *  ab_persona.ts は import すると main() が走る単発スクリプトなので、関数を import せず同じ3行を置く。 */
function memoSlice(from: number, to: number): string {
  const lines = readFileSync("F:/kings/成績メモ.txt", "utf8").split(/\r?\n/);
  return lines.slice(from - 1, to).join("\n");
}

/**
 * 1試合の AI集計をメモリ内で行う。契約は本番 ingestWholeGame と同一(instructions/辞書ブロック/SUBMIT_TOOL 強制/
 * submitOnceFor の provider seam/maxTokens 32000/streaming)。違いは「畳んだ結果を commit しない」ことだけ。
 * 助っ人名の解決は resolveGuestNamesInOps に純粋な createGuest(名前→GUEST:名前)を差し、マスタへは書かない。
 */
async function synth(): Promise<void> {
  const model = arg("--model") ?? process.env.AI_MODEL ?? "gpt-5.6-sol";
  const only = arg("--games")?.split(",").map((s) => s.trim()).filter(Boolean);
  const gameIds = Object.keys(SYNTH_GAMES).filter((id) => !only || only.includes(id));
  for (const id of only ?? []) if (!SYNTH_GAMES[id]) throw new Error(`--games: 未知の試合ID ${id}(対象は ${Object.keys(SYNTH_GAMES).join(",")})`);

  const [dbMasters, players] = await Promise.all([loadPlayers(), listPlayers()]);
  const dict = players.map((p) => `${p.id}=${p.name}`).join(", ");
  // 既存ファイルがあれば試合単位で置換(--games で一部だけやり直せる)。masters は全試合共通の辞書に仮IDを積む。
  const prev = readJson<CasesFile | null>(SYNTH_CASES_PATH, null);
  const out: CasesFile = {
    collected_at: new Date().toISOString(), kind: "synth",
    versions: { ...(prev?.versions ?? {}) }, cases: (prev?.cases ?? []).filter((c) => !gameIds.includes(c.game_id)),
    cost_aggregate: { ...(prev?.cost_aggregate ?? {}) }, masters: { ...(prev?.masters ?? {}) },
  };
  for (const id of gameIds) { delete out.versions[`${id}:synth`]; delete out.cost_aggregate![id]; }
  console.log(`model=${model} effort=${APP_EFFORT} 対象 ${gameIds.length} 試合`);

  for (const gameId of gameIds) {
    const truth = await loadGame(gameId); // 公開版=正解(人が検証済み)
    if (!truth) { console.log(`  ${gameId} 公開版が無い→スキップ`); continue; }
    const [from, to] = SYNTH_GAMES[gameId];
    const note = memoSlice(from, to);
    const masters = new Map(dbMasters); // 試合ごとに複製(GUEST 仮IDは試合内で閉じる)
    const rec: AggregateRecord = {
      game_id: gameId, model, effort: APP_EFFORT, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ms: 0,
      ops: 0, pa_ai: 0, pa_truth: truth.plate_appearances.length, flags: 0, clarification: null, error: null, ran_at: new Date().toISOString(),
    };
    // system は本番 buildSystem と同じ3ブロック(役割/辞書(キャッシュ境界)/盤面=新規作成＋日付)
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: instructions() },
      { type: "text", text: `選手名→ID:\n${dict}`, cache_control: { type: "ephemeral", ttl: "5m" } },
      { type: "text", text: `新規作成の試合。日付=${truth.game.date}。` },
    ];
    const t0 = Date.now();
    let doc: GameDoc | null = null;
    try {
      const r = await submitOnceFor(model, { system, messages: [{ role: "user", content: note }], maxTokens: 32000, stream: true });
      rec.usage = r.usage; rec.ms = Date.now() - t0;
      const raw = r.toolInput !== null && typeof r.toolInput === "object" && !Array.isArray(r.toolInput) ? (r.toolInput as { operations?: unknown; clarification?: string | null }) : undefined;
      const ops = raw ? normalizeOperations(raw.operations) : null;
      if (!ops) throw new Error("出力形式崩れ(operations を復元できない)"); // 本番はもう1回リトライするが、評価では1コール=1計測として失敗を記録
      rec.clarification = raw?.clarification ?? null;
      rec.ops = ops.length;
      const gameOps = ops.map(toGameOp);
      // 助っ人名→仮ID(GUEST:名前)。DBへは書かない。masters(複製)には載るので reducer の存在チェックを通る
      const resolved = await resolveGuestNamesInOps(gameOps, masters, undefined, async (nm) => ({ id: `GUEST:${nm}`, name: nm }));
      // baseDoc=公開版の game メタだけを持つ空doc。replace=true は本番 ingestWholeGame と同じ経路(空docへの regraft は無害)
      const baseDoc: GameDoc = { schema_version: "2.0", game: { ...truth.game, result: null }, participants: [], lineup_snapshots: [], plate_appearances: [] }; // result は持ち込まない(本番の新規集計と同条件・R4を本番より増やさない)
      doc = foldOpsInMemory(gameId, baseDoc, resolved, masters, true).doc; // applyValidation 済み(validator 注記が付いている)
    } catch (e) {
      rec.ms ||= Date.now() - t0;
      rec.error = (e as Error).message;
      out.cost_aggregate![gameId] = rec;
      writeJson(SYNTH_CASES_PATH, out);
      console.log(`  ${gameId} ERROR ${rec.error} in=${rec.usage.input} out=${rec.usage.output}`);
      continue;
    }
    rec.pa_ai = doc.plate_appearances.length;
    for (const [id, nm] of masters) out.masters![id] = nm; // 全マスタ(GUEST仮ID含む)=正解側の P-id も名前に解ける
    const docRef = `${gameId}:synth`;
    out.versions[docRef] = { game_id: gameId, gen: 0, doc };
    out.versions[`${gameId}:truth`] = { game_id: gameId, gen: -1, doc: truth }; // 正解doc(名前解決は必ずこちらの participants で)
    // フラグ抽出は --collect と同じ規則(validator R* / AI由来 unclear)。1フラグ=1ケース
    let flags = 0;
    for (const p of doc.plate_appearances) {
      for (const a of p.annotations ?? []) {
        if (a.type !== "unclear") continue;
        const rule = a.source === "validator" && a.rule && /^R\d+$/.test(a.rule) ? a.rule : a.source === "ai" ? "AI" : null;
        if (!rule) continue;
        flags++;
        const cnt = (d: GameDoc) => d.plate_appearances.filter((t) => t.inning === p.inning && t.half === p.half).length;
        // 半イニング内の打席数が違えば order がズレて別打席同士を比べてしまうので突合不能扱い(no_truth_pa)
        const truthPA = cnt(doc) === cnt(truth) ? (truth.plate_appearances.find((t) => t.inning === p.inning && t.half === p.half && t.order === p.order) ?? null) : null;
        out.cases.push({
          case_id: `${gameId}:synth:${paKeyOf(p)}:${rule}`,
          game_id: gameId, gen: 0, pa: refOf(p), rule, detail: a.detail, doc_ref: docRef,
          note, note_input: note, disposition: "open", disposition_gen: null,
          truth_pa: truthPA, ai_pa: p,
        });
      }
    }
    rec.flags = flags;
    out.cost_aggregate![gameId] = rec;
    writeJson(SYNTH_CASES_PATH, out); // 試合ごとに保存(途中中断でも失わない)
    console.log(`  ${gameId} ops=${rec.ops} PA ai=${rec.pa_ai}/truth=${rec.pa_truth} flags=${flags}${rec.clarification ? " clarification!" : ""} in=${rec.usage.input} out=${rec.usage.output} cached=${rec.usage.cacheRead} ${rec.ms}ms`);
  }
  console.log(`\nケース ${out.cases.length} 件 保存: ${SYNTH_CASES_PATH}`);
}

// ===== --report =====

// 単価(USD/Mトークン)。※要確認: gpt-5.6-sol の公表単価(in/out/cached in)を確認して更新すること(ここは仕様書の仮置き値)。
const PRICE: Record<string, { in: number; out: number; cached: number }> = { // USD per 1M tokens。公式 pricing 2026-09-06 確認
  "gpt-5.6-sol": { in: 4, out: 20, cached: 0.4 }, // プロモ価格(2026-11-21 まで)。cached は 10% 仮置き
  "gpt-6-astra": { in: 10, out: 50, cached: 1 }, // Flex 非対応(Flex は luna/5.5 以前/o系のみ)
};
const JPY_PER_USD = 150; // ※仮置き(為替)。要確認
/** usage→USD。OpenAI の input_tokens は cached を含む(cached 分を差し引いて cached 単価)。Anthropic は input が cache 外なので
 *  cacheRead を別建て・cacheWrite は in 単価で近似。単価未登録なら null。 */
function costUsd(model: string, u: Usage): number | null {
  const p = PRICE[model];
  if (!p) return null;
  const uncached = isOpenAiModel(model) ? Math.max(0, u.input - u.cacheRead) : u.input + u.cacheWrite;
  return (uncached * p.in + u.cacheRead * p.cached + u.output * p.out) / 1e6;
}
const yen = (usd: number) => `$${usd.toFixed(3)} (≒${Math.round(usd * JPY_PER_USD)}円)`;
const sumUsage = (us: Usage[]): Usage => us.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function report(): void {
  const casesPath = arg("--cases") ?? CASES_PATH;
  const cases = readJson<CasesFile | null>(casesPath, null);
  const results = readJson<EvalResult[]>(resultsPathFor(casesPath), []);
  if (!cases) throw new Error(`ケースが無い: 先に --collect / --synth (${casesPath})`);
  if (cases.kind === "synth") { reportSynth(cases, results); return; }
  if (results.length === 0) { console.log("結果なし(--run 未実行)"); return; }
  const caseById = new Map(cases.cases.map((c) => [c.case_id, c]));
  const rows = results.map((r) => ({ r, c: caseById.get(r.case_id) })).filter((x): x is { r: EvalResult; c: EvalCase } => !!x.c);
  console.log(`結果 ${rows.length} 件 (model: ${[...new Set(rows.map((x) => x.r.model))].join(", ")})`);

  // クロス表 verdict × disposition
  const verdicts: EvalResult["verdict"][] = ["transcription_fix", "source_ambiguous", "undecidable", "invalid_output"];
  const disps: Disposition[] = ["edited", "approved", "reaggregated", "open"];
  console.log(`\nverdict × 人の処置`);
  console.log(`  ${"".padEnd(18)}${disps.map((d) => d.padStart(13)).join("")}${"計".padStart(6)}`);
  for (const v of verdicts) {
    const line = disps.map((d) => rows.filter((x) => x.r.verdict === v && x.c.disposition === d).length);
    console.log(`  ${v.padEnd(18)}${line.map((n) => String(n).padStart(13)).join("")}${String(line.reduce((a, b) => a + b, 0)).padStart(6)}`);
  }
  const hitFix = rows.filter((x) => x.r.verdict === "transcription_fix" && x.c.disposition === "edited").length;
  const hitAmb = rows.filter((x) => x.r.verdict === "source_ambiguous" && (x.c.disposition === "approved" || x.c.disposition === "reaggregated")).length;
  const risky = rows.filter((x) => x.r.verdict === "transcription_fix" && (x.c.disposition === "approved" || x.c.disposition === "reaggregated"));
  const labeled = rows.filter((x) => x.c.disposition !== "open").length;
  console.log(`\n的中: transcription_fix∧edited=${hitFix} / source_ambiguous∧(approved|reaggregated)=${hitAmb} → ${hitFix + hitAmb}/${labeled} (open除く)`);
  console.log(`要注意(人が曖昧と見たものを直そうとした=作文候補): transcription_fix∧(approved|reaggregated)=${risky.length}`);

  // evidence 有効率 / G2
  const g1ok = rows.filter((x) => x.r.g1 === "ok").length;
  console.log(`\nevidence 原文一致(G1): ${g1ok}/${rows.length} (${Math.round((100 * g1ok) / rows.length)}%)`);
  const fixes = rows.filter((x) => x.r.verdict === "transcription_fix");
  const accepted = fixes.filter((x) => x.r.g2 === "accepted").length;
  console.log(`G2 採用率(transcription_fix のみ): ${accepted}/${fixes.length}`);
  const rej = new Map<string, number>();
  for (const x of fixes) if (x.r.g2 === "gate_rejected") inc(rej, x.r.g2_reason ?? "?");
  printCounts("gate_rejected 内訳", rej);

  // 作文候補: 引用不一致 or gate棄却の fix
  const fab = rows.filter((x) => x.r.g1 === "evidence_invalid" || (x.r.verdict === "transcription_fix" && x.r.g2 === "gate_rejected"));
  console.log(`\n作文候補 ${fab.length} 件 (引用不一致 or gate棄却)`);
  for (const x of fab) {
    console.log(`  ${x.r.case_id} [${x.c.disposition}] ${x.r.verdict} G1=${x.r.g1} G2=${x.r.g2}${x.r.g2_reason ? `(${x.r.g2_reason})` : ""}`);
    console.log(`     evidence: ${x.r.evidence.slice(0, 80)}`);
    if (x.r.fix) console.log(`     fix: ${JSON.stringify(x.r.fix).slice(0, 160)}`);
    if (x.r.g2_detail) console.log(`     detail: ${x.r.g2_detail.slice(0, 160)}`);
  }

  // per-rule 的中
  const byRule = new Map<string, { n: number; hit: number }>();
  for (const x of rows) {
    const e = byRule.get(x.c.rule) ?? { n: 0, hit: 0 };
    e.n++;
    if ((x.r.verdict === "transcription_fix" && x.c.disposition === "edited") || (x.r.verdict === "source_ambiguous" && (x.c.disposition === "approved" || x.c.disposition === "reaggregated"))) e.hit++;
    byRule.set(x.c.rule, e);
  }
  console.log(`\nrule別 的中/件数`);
  for (const k of [...byRule.keys()].sort()) console.log(`  ${k.padEnd(6)} ${byRule.get(k)!.hit}/${byRule.get(k)!.n}`);

  // トークン・コスト
  const inTok = rows.reduce((a, x) => a + x.r.usage.input, 0), outTok = rows.reduce((a, x) => a + x.r.usage.output, 0);
  const ms = rows.reduce((a, x) => a + x.r.ms, 0);
  console.log(`\nトークン合計: in=${inTok} out=${outTok} / 平均所要 ${Math.round(ms / rows.length)}ms`);
  for (const m of new Set(rows.map((x) => x.r.model))) {
    const p = PRICE[m];
    const usd = costUsd(m, sumUsage(rows.filter((x) => x.r.model === m).map((x) => x.r.usage)));
    if (p && usd != null) console.log(`コスト概算(${m}: in $${p.in}/M, out $${p.out}/M, cached $${p.cached}/M ※単価・為替は要確認): ${yen(usd)}`);
    else console.log(`コスト概算(${m}): 単価未登録(PRICE に追加してください)`);
  }
}

// ----- synth ケースの報告(正解突合＋料金) -----

/** AIの打席が正解と一致していたか。フラグ時点での分類=読み直しが「転記ミスを直す」場面か「ノート曖昧/他要因」の場面か。 */
type TruthLabel = "ai_differs_truth" | "ai_matched_truth" | "no_truth_pa";

/** 名前ベースの内容キー。AI側は助っ人を仮ID(GUEST:名前)、正解側はマスタID/参加者IDで持つので、batter を名前に解決してから比べる。
 *  走者の runner_id は既に contentKey が外している(from/to だけ)。 */
function contentKeyNamed(p: PlateAppearance, nameOf: (id: string | null | undefined) => string): string {
  return contentKey({ ...p, batter_id: nameOf(p.batter_id) });
}

/**
 * 意味比較キー: 正解doc(旧パイプライン移行版)とAI記録は表現規約が違う(正解は打者の一塁到達を after null→1 で明示・
 * hit_type 常設・fielding.outs を持つ / AIは打者到達が暗黙・hit_type 任意)。生フィールドの比較は全打席が不一致になる
 * (実測: 未フラグ打席でも一致 23/73)ため、両者を同じエンジンで導出した「意味」で比べる:
 * 結果コード・打者名・打球方向・生還者(名)・打席後の盤面(名)・アウト数。
 */
function semanticKey(doc: GameDoc, pa: PlateAppearance, masters: Map<string, string>): string {
  const nameOf = docNameResolver(doc, masters);
  const st = derivePAStates(doc).get(pa);
  const start = st?.runners ?? { first: null, second: null, third: null };
  const end = foldRunners(start, pa);
  const nm = (id: string | null | undefined) => (id ? nameOf(id) : null);
  return JSON.stringify({
    r: pa.result, b: nm(pa.batter_id), hit: pa.fielding?.hit_to ?? null,
    scorers: deriveScorers(start, pa).map(nm).sort(),
    board: [nm(end.first), nm(end.second), nm(end.third)],
    outs: outsMade(pa),
  });
}

function reportSynth(cases: CasesFile, results: EvalResult[]): void {
  const masters = new Map(Object.entries(cases.masters ?? {}));
  // 比較器の妥当性: フラグ有無に関係なく全打席の意味一致率を出す(低ければ物差し側の問題を疑う)
  for (const a of Object.values(cases.cost_aggregate ?? {})) {
    const ai = cases.versions[`${a.game_id}:synth`]?.doc, tr = cases.versions[`${a.game_id}:truth`]?.doc;
    if (!ai || !tr) continue;
    let same = 0, n = 0;
    for (const p of ai.plate_appearances) {
      const t = tr.plate_appearances.find((x) => x.inning === p.inning && x.half === p.half && x.order === p.order);
      if (!t) continue; n++;
      if (semanticKey(ai, p, masters) === semanticKey(tr, t, masters)) same++;
    }
    console.log(`  [比較器妥当性] ${a.game_id} 全打席の意味一致 ${same}/${n}`);
  }
  const truthLabelOf = (c: EvalCase): TruthLabel => {
    if (!c.truth_pa || !c.ai_pa) return "no_truth_pa";
    const aiDoc = cases.versions[c.doc_ref].doc;
    // 正解 doc は保存していない(participants の名前解決は masters のみ=roster link は player_id→名前で解ける想定)
    const truthDoc = cases.versions[`${c.game_id}:truth`]?.doc; // 正解側の m系IDは正解docの participants で解く(AI側で解くと別人に化ける)
    if (!truthDoc) return "no_truth_pa";
    return semanticKey(aiDoc, c.ai_pa, masters) === semanticKey(truthDoc, c.truth_pa, masters) ? "ai_matched_truth" : "ai_differs_truth";
  };

  // 集計側(cost_aggregate)は --run 未実行でも出す
  const aggs = Object.values(cases.cost_aggregate ?? {});
  console.log(`synth ケース ${cases.cases.length} 件 / 集計 ${aggs.length} 試合 (${aggs.filter((a) => a.error).length} 試合は失敗)`);
  for (const a of aggs) console.log(`  ${a.game_id} ${a.model} ops=${a.ops} PA ai=${a.pa_ai}/truth=${a.pa_truth} flags=${a.flags}${a.error ? ` ERROR ${a.error.slice(0, 80)}` : ""}${a.clarification ? " clarification" : ""}`);
  const byLabel = new Map<string, number>();
  for (const c of cases.cases) inc(byLabel, truthLabelOf(c));
  printCounts("フラグ時点の truth_label(全ケース)", byLabel);

  const caseById = new Map(cases.cases.map((c) => [c.case_id, c]));
  const rows = results.map((r) => ({ r, c: caseById.get(r.case_id) })).filter((x): x is { r: EvalResult; c: EvalCase } => !!x.c);
  if (rows.length > 0) {
    console.log(`\n読み直し結果 ${rows.length} 件 (model: ${[...new Set(rows.map((x) => x.r.model))].join(", ")})`);
    const verdicts: EvalResult["verdict"][] = ["transcription_fix", "source_ambiguous", "undecidable", "invalid_output"];
    const labels: TruthLabel[] = ["ai_differs_truth", "ai_matched_truth", "no_truth_pa"];
    console.log(`\nverdict × truth_label`);
    console.log(`  ${"".padEnd(18)}${labels.map((d) => d.padStart(18)).join("")}${"計".padStart(6)}`);
    for (const v of verdicts) {
      const line = labels.map((l) => rows.filter((x) => x.r.verdict === v && truthLabelOf(x.c) === l).length);
      console.log(`  ${v.padEnd(18)}${line.map((n) => String(n).padStart(18)).join("")}${String(line.reduce((a, b) => a + b, 0)).padStart(6)}`);
    }

    // fix_correct: transcription_fix の fix を本番 reducer で適用した後の打席が正解と一致するか(G2 の採否とは独立に数える)
    const fixes = rows.filter((x) => x.r.verdict === "transcription_fix");
    let fixCorrect = 0, fixCorrectAccepted = 0, fixApplyErr = 0;
    const wrongFixes: { r: EvalResult; c: EvalCase; why: string }[] = [];
    for (const x of fixes) {
      if (!x.r.fix || !x.c.truth_pa) { wrongFixes.push({ ...x, why: x.r.fix ? "truth_pa 無し" : "fix 無し" }); continue; }
      const doc = cases.versions[x.c.doc_ref].doc;
      try {
        const op = toGameOp({ ...x.r.fix, op: "editPlateAppearance", inning: x.c.pa.inning, half: x.c.pa.half, order: x.c.pa.order, ...(x.c.pa.id ? { pa_id: x.c.pa.id } : {}) }) as GameOpInput;
        const { type: _t, ...input } = op as { type: string } & EditPAInput; void _t;
        const next = previewEditPA(doc, input, masters);
        const after = findPA(next, x.c.pa);
        const truthDoc = cases.versions[`${x.c.game_id}:truth`]?.doc;
        const ok = !!after && !!truthDoc && semanticKey(next, after, masters) === semanticKey(truthDoc, x.c.truth_pa, masters);
        if (ok) { fixCorrect++; if (x.r.g2 === "accepted") fixCorrectAccepted++; }
        else wrongFixes.push({ ...x, why: "適用後も正解と不一致" });
      } catch (e) { fixApplyErr++; wrongFixes.push({ ...x, why: `適用エラー ${(e as Error).message.slice(0, 80)}` }); }
    }
    console.log(`\nfix_correct(適用後の打席が正解と一致): ${fixCorrect}/${fixes.length} (うち G2 accepted ${fixCorrectAccepted}) / 適用エラー ${fixApplyErr}`);
    // 作文候補(重要指標): AIの打席が正解と一致していたのに transcription_fix を出した=ノートに無いことを「直した」
    const fab = fixes.filter((x) => truthLabelOf(x.c) === "ai_matched_truth");
    console.log(`作文候補(ai_matched_truth ∧ transcription_fix): ${fab.length}`);
    for (const x of fab) {
      console.log(`  ${x.r.case_id} G1=${x.r.g1} G2=${x.r.g2}${x.r.g2_reason ? `(${x.r.g2_reason})` : ""}`);
      console.log(`     evidence: ${x.r.evidence.slice(0, 80)}`);
      if (x.r.fix) console.log(`     fix: ${JSON.stringify(x.r.fix).slice(0, 160)}`);
    }
    if (wrongFixes.length) {
      console.log(`\n正解に届かなかった fix ${wrongFixes.length} 件`);
      for (const x of wrongFixes) console.log(`  ${x.r.case_id} [${truthLabelOf(x.c)}] G2=${x.r.g2}${x.r.g2_reason ? `(${x.r.g2_reason})` : ""} ${x.why}`);
    }

    const g1ok = rows.filter((x) => x.r.g1 === "ok").length;
    console.log(`\nevidence 原文一致(G1): ${g1ok}/${rows.length} (${Math.round((100 * g1ok) / rows.length)}%)`);
    const accepted = fixes.filter((x) => x.r.g2 === "accepted").length;
    console.log(`G2 採用率(transcription_fix のみ): ${accepted}/${fixes.length}`);
    const rej = new Map<string, number>();
    for (const x of fixes) if (x.r.g2 === "gate_rejected") inc(rej, x.r.g2_reason ?? "?");
    printCounts("gate_rejected 内訳", rej);
    const byRule = new Map<string, number>();
    for (const x of rows) inc(byRule, `${x.c.rule.padEnd(4)} ${x.r.verdict.padEnd(18)} ${truthLabelOf(x.c)}`);
    printCounts("rule × verdict × truth_label", byRule);
  } else {
    console.log("\n読み直し結果なし(--run --cases ... 未実行)");
  }

  // 料金: 集計(cost_aggregate) + 読み直し(results) をモデル別に円換算
  console.log(`\n料金(単価 PRICE・為替 ${JPY_PER_USD}円/USD は仮置き=要確認)`);
  const models = new Set([...aggs.map((a) => a.model), ...rows.map((x) => x.r.model)]);
  let totalUsd = 0, unknown = false;
  for (const m of models) {
    const ua = sumUsage(aggs.filter((a) => a.model === m).map((a) => a.usage));
    const ur = sumUsage(rows.filter((x) => x.r.model === m).map((x) => x.r.usage));
    const ca = costUsd(m, ua), cr = costUsd(m, ur);
    if (ca == null || cr == null) { unknown = true; console.log(`  ${m}: 単価未登録(PRICE に追加してください) 集計 in=${ua.input} out=${ua.output} / 読み直し in=${ur.input} out=${ur.output}`); continue; }
    totalUsd += ca + cr;
    console.log(`  ${m} 集計コスト: ${yen(ca)} (in=${ua.input} out=${ua.output} cached=${ua.cacheRead})`);
    console.log(`  ${m} 読み直しコスト: ${yen(cr)} (${rows.filter((x) => x.r.model === m).length}コール in=${ur.input} out=${ur.output} cached=${ur.cacheRead})`);
  }
  console.log(`  合計: ${yen(totalUsd)}${unknown ? " (単価未登録分を除く)" : ""}`);
}

// ===== main =====
async function main(): Promise<void> {
  try {
    if (has("--collect")) await collect();
    else if (has("--synth")) await synth();
    else if (has("--run")) await run();
    else if (has("--report")) report();
    else console.log("usage: eval_reread.ts --collect | --synth [--games id,id] [--model M] | --run [--cases PATH] [--limit N] [--game ID] [--model M] [--redo] | --report [--cases PATH]");
  } finally {
    if (!has("--report")) await (await getClient()).close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
