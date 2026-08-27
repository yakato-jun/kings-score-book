/**
 * [診断・一回きり] ペルソナ有無のA/B検証。同一ノートを
 *   A=現行「スコア入力の変換器」 / B=「野球公式記録員(スコアラー)」ペルソナ
 * の system で解析し、result_code の違い(特にエラー出塁を E にできるか)を比較する。
 * DBへは一切書かない(パースのみ)。モデル/effort/thinking はバリアント指定(既定の MODEL 定数は本番と別=計測対象を明示すること。
 * 本番採用構成は fable-5×low、lib/ai/agent.ts が正)。
 * モデルIDが gpt- / o+数字 接頭辞のバリアントは本番と同じアダプタ(lib/ai/openai.ts の openaiSubmitOnce)で OpenAI を叩く
 * (system はブロック連結・reasoning_effort・submit 強制=本番 seam と同じ扱い)。thinking/toolChoice 指定は Anthropic 経路のみ有効。
 * 実行: node --env-file=.env.local --import tsx scripts/ab_persona.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { SUBMIT_TOOL, instructions, APP_EFFORT } from "../lib/ai/agent";
import { isOpenAiModel, openaiSubmitOnce } from "../lib/ai/openai";
import { listPlayers } from "../lib/ops/players";
import { loadNote } from "../lib/db/notes";
import { getClient } from "../lib/db/mongo";

const client = new Anthropic();
const MODEL = "claude-sonnet-5";
const REPS = 2;
const OUT_DIR = "C:/Users/yakat/AppData/Local/Temp/claude/F--kings/6ae7bdd5-07e2-4d31-bbba-8fea757765f0/scratchpad/ab_persona";

// 成績メモ.txt から行範囲で1試合分を切り出す(1-indexed・両端含む)。中身は機密なのでリポジトリへは書かない。
function memoSlice(from: number, to: number): string {
  const lines = readFileSync("F:/kings/成績メモ.txt", "utf8").split(/\r?\n/);
  return lines.slice(from - 1, to).join("\n");
}

// B: 先頭の役割一文だけを差し替え、他の指示文(会話しない/推測で埋めない/from導出 等)は現行と同一に保つ
const personaOf = (base: string) =>
  base.replace("N-KINGSのスコア入力の変換器。", "N-KINGSの試合の野球公式記録員(スコアラー)。プレー描写を野球のスコア規則どおりに読み取る。");

// C: 全面書き直し案。前提(入力は曖昧・断片・自由記法が正常)を明示し、字面変換でなく「実際に起きたプレー」の
//    読み取りを役割にする。死んだ指示(会話しない=tool強制で不可能)は落とす。
const ROLE_C =
  "N-KINGSの試合メモから事実を記録する係。入力は人が試合を見ながら書いたメモで、断片的・曖昧・記法は自由（凡例が付くこともある）。" +
  "字面の定型（ゴロ/フライ等）ではなく、実際に何が起きたか（打者は生きたか、アウトは増えたか、走者はどう動いたか）を行全体から読み取り、書かれた出来事だけをスキーマに落とす。" +
  "書かれていないことは推測で埋めない。曖昧・矛盾のある打席も落とさず、ベスト推定で記録して unclear に理由を残す（曖昧を曖昧のまま残すのは正しい）。" +
  "試合全体として確定不能な時だけ operations を空にし clarification に短い質問。" +
  "盤面・得点者・走者の同定・打者の塁配置はサーバが from塁から決定的に導出する。from が本当に分からない時だけ unknown と書く（unknown は正当な答え）。";

type Op = Record<string, unknown> & { op: string };
// effort は SDK の literal union に合わせる(string だと messages.stream の output_config 型に入らない)
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

async function parseOnce(system: Anthropic.TextBlockParam[], note: string, opts?: { thinking?: Anthropic.ThinkingConfigParam; toolChoice?: Anthropic.ToolChoice; maxTokens?: number; model?: string; effort?: Effort }) {
  const model = opts?.model ?? MODEL;
  if (isOpenAiModel(model)) {
    // OpenAI 経路: 本番と同じアダプタを直接使う。stop_reason/ブロック構成は Anthropic 固有の観察点なので固定値。
    const r = await openaiSubmitOnce({
      model, effort: opts?.effort ?? APP_EFFORT,
      systemText: system.map((b) => b.text).join("\n\n"), userText: note,
      maxTokens: opts?.maxTokens ?? 20000,
      toolName: SUBMIT_TOOL.name, toolDescription: SUBMIT_TOOL.description ?? "", toolSchema: SUBMIT_TOOL.input_schema,
    });
    const out = (r.toolInput ?? { operations: [], clarification: null }) as { operations?: Op[]; clarification?: string | null };
    return {
      operations: out.operations ?? [], clarification: out.clarification ?? null,
      stop_reason: null as string | null, blocks: "openai:tool_call", no_tool_use: r.toolInput === undefined,
      usage: { in: r.usage.input, out: r.usage.output, cr: r.usage.cacheRead, cw: r.usage.cacheWrite },
    };
  }
  const effortCfg = /haiku/i.test(model) ? {} : { output_config: { effort: opts?.effort ?? APP_EFFORT } }; // Haikuはeffort非対応(本番と同じ分岐)
  const res = await client.messages.stream(
    {
      model, max_tokens: opts?.maxTokens ?? 20000, thinking: opts?.thinking ?? { type: "disabled" }, ...effortCfg,
      system, tools: [SUBMIT_TOOL], tool_choice: opts?.toolChoice ?? { type: "tool", name: "submit" },
      messages: [{ role: "user", content: note }],
    },
    { timeout: 300_000 },
  ).finalMessage();
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const out = (tu?.input ?? { operations: [], clarification: null }) as { operations?: Op[]; clarification?: string | null };
  // 挙動検査用: stop_reason(自然停止/上限)・ブロック構成(thinking有無/テキスト逃げ)も記録する
  const blocks = res.content.map((b) => b.type).join(",");
  return { operations: out.operations ?? [], clarification: out.clarification ?? null, stop_reason: res.stop_reason, blocks, no_tool_use: !tu, usage: { in: res.usage.input_tokens, out: res.usage.output_tokens, cr: res.usage.cache_read_input_tokens ?? 0, cw: res.usage.cache_creation_input_tokens ?? 0 } };
}

const H = (h: unknown) => (h === "top" ? "表" : h === "bottom" ? "裏" : String(h ?? "?"));
function compact(ops: Op[]): string {
  const lines: string[] = [];
  for (const op of ops) {
    if (op.op === "addPlateAppearance") {
      const bd = (op.baserunning_during as { event?: string }[] | undefined)?.map((e) => e.event).join(",");
      // 研究A: stated_*(記載チェックサムの転記)を表示。省略=記載なし、[]=走者なしと記載、の区別が見える形で出す
      const so = op.stated_outs !== undefined ? ` o=${JSON.stringify(op.stated_outs)}` : "";
      const sr = op.stated_runners !== undefined ? ` r=${JSON.stringify(op.stated_runners)}` : "";
      lines.push(`  ${op.inning}${H(op.half)} ${op.batter_id} ${op.result_code}${so}${sr}${bd ? ` [${bd}]` : ""}${op.unclear ? ` ⚠${op.unclear}` : ""}`);
    } else lines.push(`  <${op.op}>`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const dict = (await listPlayers()).map((p) => `${p.id}=${p.name}`).join(", ");
  const notes: { key: string; text: string }[] = [
    // 研究A(stated転記忠実性)チェック: 状態記載の濃い2ノートのみ(速記=G1・散文=G4)
    { key: "G1", text: await loadNote("dfc16c689e") },
    // { key: "G2_BUZZ", text: memoSlice(341, 452) },
    // { key: "G3_ブレイブハーツ", text: memoSlice(784, 941) },
    { key: "G4_ヤンキーズ", text: memoSlice(217, 338) },
  ];
  // A/B/C は実施済み。今回は E 案(設計から組み直したロール文)の挙動検査。
  // 見るのは正答率でなく: 失敗がどのチャネルに落ちるか(unclear浮上/黙って誤記録)・フラグ乱発等の想定外モード・出力のスキーマ適合。
  void personaOf; void ROLE_C; void instructions;
  const ROLE_E =
    "草野球チーム N-KINGS のスコア係。メンバーが自由に書いた試合メモ（断片的・曖昧でもよく、記法も自由で凡例が付くこともある）を試合記録に起こす。" +
    "メモは打席の並びとして前後がつながっているので、各打席はその流れ（アウト数・走者の増減）の中で読む。" +
    "書かれた出来事だけを記録し、書かれていないことは埋めない。" +
    "不確かな打席は unclear に理由を添えて記録し、試合全体が読み取れない時だけ clarification で質問する。" +
    "走者の同定・塁の配置・得点の計算は、記録された打席結果と走者の移動（どの塁からどの塁へ）を入力にサーバが行う。だから移動は元の塁が分かる形で記録する。";
  // Fable 5 low の傾向調査。fable は thinking 常時ON(disabled不可→adaptive)。tool_choice 強制が
  // 併用可能かは未知→まず強制で試し、400なら auto に落として再実行(構造保証を保てるか自体が観察点)。
  // 今回実行するのは O_sol_low のみ(ユーザー決定=Sol一本。fable基線は実施済み8ランを再利用・再測定しない)。
  // maxTokens は基線 M_fable5_low(32000)と揃える=予算差でなくモデル差を測る。GPT-5.6は推論トークンが出力に含まれる。
  const variants: { key: string; role: string; thinking?: Anthropic.ThinkingConfigParam; toolChoice?: Anthropic.ToolChoice; maxTokens?: number; model?: string; effort?: Effort }[] = [
    // 研究A: 本番構成(fable)で stated_* の転記忠実性を確認
    { key: "A_fable5_stated", role: ROLE_E, model: "claude-fable-5", effort: "low", thinking: { type: "adaptive" }, toolChoice: { type: "tool", name: "submit" }, maxTokens: 32000 },
    // { key: "O_sol_low", model: "gpt-5.6-sol", effort: "low", role: ROLE_E, maxTokens: 32000 }, // 実施済み
    // { key: "O_terra_low", model: "gpt-5.6-terra", effort: "low", role: ROLE_E, maxTokens: 32000 }, // 見送り(必要時に有効化)
  ];

  // 全ジョブを列挙し、並列4で流す(レート余裕を残す)
  const jobs: { note: (typeof notes)[number]; v: (typeof variants)[number]; rep: number }[] = [];
  for (const note of notes) for (const v of variants) for (let rep = 1; rep <= REPS; rep++) jobs.push({ note, v, rep });
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      const tag = `${j.note.key}__${j.v.key}__rep${j.rep}`;
      const system: Anthropic.TextBlockParam[] = [
        { type: "text", text: j.v.role },
        { type: "text", text: `選手名→ID:\n${dict}`, cache_control: { type: "ephemeral", ttl: "5m" } },
        { type: "text", text: "新規作成の試合。" },
      ];
      try {
        const r = await parseOnce(system, j.note.text, { thinking: j.v.thinking, toolChoice: j.v.toolChoice, maxTokens: j.v.maxTokens, model: j.v.model, effort: j.v.effort });
        writeFileSync(`${OUT_DIR}/${tag}.json`, JSON.stringify(r, null, 1), "utf8");
        const ops = Array.isArray(r.operations) ? r.operations : [];
        console.log(`=== ${tag} PA=${ops.filter((o) => o.op === "addPlateAppearance").length} out_tok=${r.usage.out} stop=${r.stop_reason} blocks=[${r.blocks}]${r.no_tool_use ? " ★tool未呼出" : ""}${r.clarification ? " clarification!" : ""}`);
        console.log(compact(ops));
      } catch (e) {
        console.log(`=== ${tag} ERROR: ${String(e)}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  await (await getClient()).close();
}
main().catch((e) => { console.error(e); process.exit(1); });
