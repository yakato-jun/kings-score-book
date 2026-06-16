/**
 * 管理アシスタント(段階A)。Opus 4.8 の手動 tool-use ループをサーバ実行。
 * 読み取りツール=即実行して結果を返す。書き込みツール=「提案」として記録し実行しない
 * (実際の適用はユーザーが承認ボタンで行う＝下書きコミット)。機密(名前/接続情報)はサーバ内で完結。
 */
import Anthropic from "@anthropic-ai/sdk";
import { loadWorking } from "@/lib/db/games";
import { listGameMeta, upsertGameMeta, setAttendance, importGameDoc } from "@/lib/ops/games";
import { listPlayers, upsertPlayer } from "@/lib/ops/players";

const client = new Anthropic();
const MODEL = "claude-opus-4-8";

const WRITE = new Set(["upsertGameMeta", "setAttendance", "importGameDoc", "upsertPlayer"]);

const TOOLS: Anthropic.Tool[] = [
  { name: "listGames", description: "全試合のメタ情報(id/日付/相手/リーグ/先後/結果)一覧を返す", input_schema: { type: "object", properties: {} } },
  { name: "getGame", description: "1試合の作業中doc(下書き含む最新・打席含む)を返す。打席を追記/修正する前に必ずこれで現状を読む", input_schema: { type: "object", properties: { id: { type: "string", description: "G20260607 形式" } }, required: ["id"] } },
  { name: "listPlayers", description: "選手マスタ(id/名前/種別)一覧を返す", input_schema: { type: "object", properties: {} } },
  {
    name: "upsertGameMeta", description: "試合メタ情報の追加/編集を提案する",
    input_schema: { type: "object", properties: {
      id: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, opponent: { type: "string" },
      league: { type: ["string", "null"] }, home_away: { type: ["string", "null"], enum: ["home", "away", null] },
      dh: { type: "boolean" },
      result: { type: ["object", "null"], properties: { our_score: { type: "integer" }, their_score: { type: "integer" }, outcome: { type: "string", enum: ["win", "loss", "tie"] }, decided_by: { type: "string" } } },
    }, required: ["id", "date", "opponent", "home_away", "dh"] },
  },
  {
    name: "setAttendance", description: "出欠の設定を提案する(played/bench のみ列挙、欠席は含めない)",
    input_schema: { type: "object", properties: {
      gameId: { type: "string" },
      entries: { type: "array", items: { type: "object", properties: { player_id: { type: "string" }, status: { type: "string", enum: ["played", "bench"] }, scope: { type: "string", enum: ["own", "guest"] } }, required: ["player_id", "status"] } },
    }, required: ["gameId", "entries"] },
  },
  { name: "importGameDoc", description: "v2試合docを丸ごと取り込み/差し替えを提案する", input_schema: { type: "object", properties: { doc: { type: "object", description: "schema_version 2.0 の完全な試合doc" } }, required: ["doc"] } },
  { name: "upsertPlayer", description: "選手マスタの追加/編集を提案する", input_schema: { type: "object", properties: { id: { type: "string", description: "P001 形式" }, name: { type: "string" }, type: { type: "string" } }, required: ["id", "name"] } },
];

export interface Proposal { id: string; tool: string; input: Record<string, unknown>; }
export interface AgentResult { reply: string; proposals: Proposal[]; }
export interface Scene { game_id?: string; inning?: number; half?: string; order?: number; player_id?: string }

async function dictionary(): Promise<string> {
  return (await listPlayers()).map((p) => `${p.id}=${p.name}`).join(", ");
}

function systemPrompt(dict: string, scene?: Scene): string {
  return [
    "あなたは草野球チーム N-KINGS のスコア管理アシスタントです。ツールで現状を読み、データ変更は必ず『提案』として返します(書き込みツールを呼ぶと提案が記録されるだけ。適用はユーザーが承認ボタンで行います)。提案の引数には解決済みの具体値を入れてください。",
    "【最重要】ユーザーへの応答は選手名・日本語で。内部ID(P009 や G001 など)や提案番号といった内部コードは画面に一切出さない。表や箇条書きにIDを併記しないこと。名前だけで話す(IDはツール呼び出しの中だけで使う)。",
    "【助っ人(ゲスト)】助っ人は選手マスタ(upsertPlayer)に登録しない。助っ人はその試合の出場選手として、試合docの additional_players(type:\"guest\"、IDは G001 から試合ごとに採番、名前もここ)に入れる。upsertPlayer は自軍の正規選手(P-id)専用。",
    "【新規試合の登録】メタだけでなくオーダー(打順・守備位置)や助っ人も含めて『1つの試合doc』を組み、importGameDoc で1提案にまとめる。docの形:",
    '  { "schema_version":"2.0", "game":{"id":"G+YYYYMMDD","date":"YYYY-MM-DD","opponent":...,"league":...,"home_away":"home"|"away","dh":true|false,"result":null},',
    '    "additional_players":[{"id":"G001","name":"…","type":"guest"}...],',
    '    "lineup_snapshots":[{"game_id":<id>,"team":"N-KINGS","snapshot_id":"<id>-NK-00","seq":0,"effective_from":{"inning":1,"half":(away→"top"/home→"bottom"),"before_order":null},"empty_slot_policy":"skip","roster":[{"player_id":…,"fielding_team":"N-KINGS","status":"active","stat_scope":(助っ人"guest"/他"own"),"include_in_season":(助っ人false/他true)}...],"lineup":[{"order":N,"position_id":"5"等,"player_id":…,"automatic_out":false}...],"reason":"start"}],',
    '    "attendance":[{"player_id":…,"status":"played","scope":(助っ人"guest"/他"own")}...], "plate_appearances":[] }',
    "  守備位置ID: 1=投 2=捕 3=一 4=二 5=三 6=遊 7=左 8=中 9=右、DH。先後 away=先攻(表で攻撃)/home=後攻(裏)。打順の先頭に守備位置番号が来る記法(例『5 (選手名)』は5=三塁の意味)に注意。",
    "既存試合のメタや出欠の小さな修正だけなら upsertGameMeta / setAttendance を使ってよい。",
    "【打席結果の入力】打席を足す/直すときは、まず getGame で現状(下書き含む)を読み、plate_appearances に追記・修正した『完全な試合doc』(全打席を含む)を importGameDoc で1提案にする。打席1件の形:",
    '  { "inning":N, "half":"top"(先攻の攻撃)|"bottom"(後攻の攻撃), "order":(その半イニング内の打席番号1..), "batting_slot":(打順1..), "outs":(開始時0-2), "runners":{"first":走者id|null,"second":..,"third":..}, "batter_id":…, "pitcher_id":…, "catcher_id":…, "result":コード, "complete":true, "runs":[], "fielding":{…}|null, "baserunning_during":[], "baserunning_after":[], "note":(任意の実況。盗塁/暴投等の走塁描写は書かず baserunning へ。曖昧は annotations:[{type:"unclear",detail}] に) }',
    "  result: H1単打 H2二塁打 H3三塁打 HR本塁打 OUT凡退 K三振 BB四球 HBP死球 FC野選 E失策 SH犠打 SF犠飛 (未完了は complete:false)。",
    '  runs[](得点が出た打席だけ): 各生還1件 {"runner_id","rbi":打点が付くか,"earned":自責か,"cause":"hit"|"hr"|"walk"|"hbp"|"sf"|"sh"|"error"|"wp"|"pb"|"sb"|"groundout"|"fc"|"other"}。得点=配列長/打点=rbi:true数/自責=earned:true数。エラー・暴投・捕逸・盗塁での生還は rbi:false。',
    '  fielding(打球がある時): {"hit_to":"1-9","hit_type":"G"(ゴロ)/"F"(飛)/"L"(直),"sequence":["6","4","3"等],"outs":[{"at":"1"/"2"/"3"/"home"/"-","type":"force"/"tag"/"catch","runner_id":id|null}],"errors":[{"pos","type"}]}。三振/四死球は fielding:null。',
    '  baserunning_after: 打球での走者移動 [{"runner_id","from":"1"/"2"/"3"/null,"to":"1"/"2"/"3"/"home"/"out","reason"}]。baserunning_during: 打席中の盗塁/暴投等 [{"event":"SB"/"WP"/"PB"/"PO"/"CS"/"BK","runners":[{"runner_id","from","to"}],"note"}]。',
    "  自軍は home_away で決まる半(away→top / home→bottom)で攻撃、相手はもう一方。相手打者IDは O001 から打順順(O001=1番…)。自信が無い所は推測で埋めず確認する。",
    `自軍の選手名解決用(ユーザーには見せない): ${dict}`,
    scene && Object.keys(scene).length ? `現在のシーン: ${JSON.stringify(scene)}。「この試合/この打席/彼」はこの文脈で解決。` : "現在のシーン: なし(グローバル)。",
    "曖昧な点はユーザーに確認。日本語で簡潔に。",
  ].join("\n");
}

async function execRead(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    if (name === "listGames") return JSON.stringify(await listGameMeta());
    if (name === "listPlayers") return JSON.stringify(await listPlayers());
    if (name === "getGame") {
      const w = await loadWorking(String(input.id ?? ""));
      return w ? JSON.stringify(w.doc) : "(該当試合なし)";
    }
    return `(未知の読み取りツール: ${name})`;
  } catch (e) {
    return `ERROR: ${(e as Error).message}`;
  }
}

export async function runAgent(messages: Anthropic.MessageParam[], scene?: Scene): Promise<AgentResult> {
  const system = systemPrompt(await dictionary(), scene);
  const convo: Anthropic.MessageParam[] = [...messages];
  const proposals: Proposal[] = [];
  let reply = "";

  for (let turn = 0; turn < 8; turn++) {
    const res = await client.messages.create({ model: MODEL, max_tokens: 16000, thinking: { type: "adaptive" }, system, tools: TOOLS, messages: convo });
    for (const b of res.content) if (b.type === "text") reply += b.text;
    if (res.stop_reason !== "tool_use") break;

    convo.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of res.content) {
      if (b.type !== "tool_use") continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      if (WRITE.has(b.name)) {
        const id = String(proposals.length + 1);
        proposals.push({ id, tool: b.name, input });
        results.push({ type: "tool_result", tool_use_id: b.id, content: `提案#${id}(${b.name})を記録しました。まだ適用していません。ユーザーが承認ボタンで適用します。` });
      } else {
        results.push({ type: "tool_result", tool_use_id: b.id, content: await execRead(b.name, input) });
      }
    }
    convo.push({ role: "user", content: results });
  }
  return { reply: reply.trim(), proposals };
}

/** 承認された提案を適用＝AIソースの下書きコミット(試合は draft、選手は通常)。 */
export async function applyProposal(tool: string, input: Record<string, unknown>): Promise<string> {
  const opts = { source: "ai", draft: true } as const;
  switch (tool) {
    case "upsertGameMeta":
      await upsertGameMeta(input as never, opts);
      return String(input.id);
    case "setAttendance":
      await setAttendance(String(input.gameId), input.entries as never, opts);
      return String(input.gameId);
    case "importGameDoc":
      return await importGameDoc(JSON.stringify(input.doc), opts);
    case "upsertPlayer":
      await upsertPlayer(input as never);
      return String(input.id);
    default:
      throw new Error(`未知の提案ツール: ${tool}`);
  }
}
