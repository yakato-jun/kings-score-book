/**
 * 試合データの操作レイヤ。Atlas を正本に書き込む。管理UIとAI入力の双方がこれを呼ぶ。
 * 詳細な打席編集は画面では作らず、JSON取込(importGameDoc)で丸ごと差し替える方針。
 */
import { loadGames, loadGame, loadWorking, commitGameDoc, squashDrafts, draftGameIds } from "@/lib/db/games";
import { applyValidation, repairGame } from "./validate";
import { gameState, deriveNextPA, kingsBatHalf, oppBatHalf, lineupSlots, resolvePATarget, deriveRuns, startRunnersBefore, resolveBaserunningIds } from "./gamestate";
import { effectiveSnapshot, posMap } from "@/lib/agg";
import type { Runners } from "@/lib/types/v2";
import type {
  GameDoc, Game, GameResult, AttendanceEntry, GameOp, Half, PlateAppearance,
  ResultCode, Fielding, RunEvent, BaserunMove, BaserunDuring, Annotation, PositionId,
  AdditionalPlayer, LineupSnapshot, RosterEntry,
} from "@/lib/types/v2";

/** コミットの共通オプション。UIは既定(ui/非draft)、AIは {source:"ai", draft:true} を渡す。 */
export interface CommitOpts {
  source?: string;
  draft?: boolean;
  base_gen?: number;
  repair?: boolean; // false=自動修復(repairGame)を通さない。AI修正(手動の特別対応)で整合性を取らない時に使う
}
const co = (o: CommitOpts, op: GameOp) => ({
  source: o.source ?? "ui",
  draft: o.draft ?? false,
  base_gen: o.base_gen,
  op,
});

/** 一覧用に各試合のメタ(game)だけ返す */
export async function listGameMeta(): Promise<Game[]> {
  const games = await loadGames();
  return games.map((d) => d.game).sort((a, b) => b.date.localeCompare(a.date));
}

/** AI入力の選択肢用: 公開試合＋下書きのみの試合(未公開)を、下書きフラグ付きで返す。 */
export async function listGamesForChat(): Promise<{ id: string; date: string; opponent: string; draft: boolean }[]> {
  const published = await loadGames();
  const pubIds = new Set(published.map((d) => d.game.id));
  const drafts = new Set(await draftGameIds());
  const out = published.map((d) => ({ id: d.game.id, date: d.game.date, opponent: d.game.opponent, draft: drafts.has(d.game.id) }));
  for (const id of drafts) {
    if (pubIds.has(id)) continue; // 公開済みは上で出している
    const w = await loadWorking(id);
    if (w) out.push({ id, date: w.doc.game.date, opponent: w.doc.game.opponent, draft: true });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export interface GameMetaInput {
  id: string;
  date: string;
  opponent: string;
  league?: string | null;
  home_away: "home" | "away" | null;
  dh: boolean;
  result: GameResult | null;
}

/** メタ情報の編集/新規。既存docがあれば game だけ差し替え、無ければ空のシェルを作る。 */
export async function upsertGameMeta(input: GameMetaInput, opts: CommitOpts = {}): Promise<void> {
  if (!/^G\d{8}$/.test(input.id)) throw new Error(`試合IDは G20260607 形式で必須です（受領: "${input.id}"）`);
  if (!input.date) throw new Error("日付は必須です");
  if (!input.opponent?.trim()) throw new Error("対戦相手は必須です");

  const existing = (await loadWorking(input.id))?.doc ?? null; // 作業中(下書き)があればその上に積む
  // 結果は編集対象(スコア/勝敗/決着)以外の既存フィールド(scheduled_innings/line_score)を保持する
  const result: GameResult | null = input.result
    ? { ...existing?.game.result, ...input.result }
    : null;
  const game: Game = {
    id: input.id,
    date: input.date,
    opponent: input.opponent.trim(),
    league: input.league?.trim() || null,
    home_away: input.home_away,
    dh: input.dh,
    result,
    note: existing?.game.note ?? null,
  };
  const doc: GameDoc = existing
    ? { ...existing, game }
    : {
        schema_version: "2.0",
        game,
        additional_players: [],
        lineup_snapshots: [],
        plate_appearances: [],
        attendance: [],
      };
  await commitGameDoc(doc, co(opts, { type: "upsertGameMeta", args: { id: input.id } }));
}

/** 出欠の設定。played/bench のみを保存（欠席はエントリ無し）。 */
export async function setAttendance(gameId: string, entries: AttendanceEntry[], opts: CommitOpts = {}): Promise<void> {
  const doc = (await loadWorking(gameId))?.doc ?? null; // 作業中(下書き)を基準に積む
  if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
  await commitGameDoc({ ...doc, attendance: entries }, co(opts, { type: "setAttendance", args: { gameId, count: entries.length } }));
}

/** 作業中の下書きを確定(publish)＝最新スナップショットを games(公開) に反映し、下書き世代を畳む(squash)。 */
export async function publishGame(gameId: string, opts: CommitOpts = {}): Promise<void> {
  const w = await loadWorking(gameId);
  if (!w) throw new Error(`試合 ${gameId} が見つかりません`);
  await commitGameDoc(w.doc, co({ ...opts, draft: false }, { type: "publish", args: { gameId, from_gen: w.gen } }));
  await squashDrafts(gameId); // 履歴を publish 単位に保つ(下書き世代を削除)
}

// ===== 差分op(v2) =====
// 「下書き＝操作ストリームの畳み込み」。AIの1返却＝複数opを1世代で原子的に反映する(applyOps)。
// 各opは純粋なリデューサ (doc, args) => doc。途中で throw すれば commit に到達せず=半端が残らない。

export interface LineupRowInput {
  order: number;
  position: string | null; // "1".."9" | "DH" | null
  player_id?: string; // 既存(P-id)
  guest_name?: string; // 助っ人。player_id無し時にサーバがG採番
}

export interface AddPAInput {
  inning?: number;
  half?: Half;
  batter_id?: string; // 省略時は自動(自軍=打順, 相手=O番号)
  pitcher_id?: string | null;
  catcher_id?: string | null;
  result: ResultCode;
  complete?: boolean;
  fielding?: Fielding | null;
  runs?: RunEvent[];
  baserunning_during?: BaserunDuring[];
  baserunning_after?: BaserunMove[];
  note?: string | null;
  annotations?: Annotation[];
}

/** 既存打席の編集(アドレス＝回/表裏/order)。渡したフィールドだけ差し替える。 */
export interface EditPAInput {
  inning: number;
  half: Half;
  order: number;
  batter_id?: string;
  pitcher_id?: string | null;
  catcher_id?: string | null;
  result?: ResultCode;
  complete?: boolean;
  fielding?: Fielding | null;
  runs?: RunEvent[];
  baserunning_during?: BaserunDuring[];
  baserunning_after?: BaserunMove[];
  note?: string | null;
  annotations?: Annotation[];
}
export interface RemovePAInput { inning: number; half: Half; order: number }

/** 守備位置変更(delta)。1人ぶん＝対象選手(player_id か from_position で特定)を to_position へ。 */
export interface DefenseChangeInput {
  player_id?: string; // 対象選手(P/G-id か名前)
  from_position?: string | null; // 旧守備位置(player_id省略時に現ロスターから対象を解決。例『2->5』『ピッチャー→サード』)
  to_position: string; // 新守備位置 "1".."9"|"DH"
}

/** 1返却で送られてくる操作の判別共用体 */
export type GameOpInput =
  | ({ type: "setGameMeta" } & Partial<GameMetaInput>)
  | { type: "setStartingLineup"; rows: LineupRowInput[] }
  | { type: "changeDefense"; changes: DefenseChangeInput[]; inning?: number; half?: Half }
  | ({ type: "addPlateAppearance" } & AddPAInput)
  | ({ type: "editPlateAppearance" } & EditPAInput)
  | ({ type: "removePlateAppearance" } & RemovePAInput);

function emptyDoc(game: Game): GameDoc {
  return { schema_version: "2.0", game, additional_players: [], lineup_snapshots: [], plate_appearances: [], attendance: [] };
}

/** メタ情報の部分更新(渡したフィールドだけ変える) */
function reduceSetGameMeta(doc: GameDoc | null, gameId: string, patch: Partial<GameMetaInput>): GameDoc {
  if (!/^G\d{8}$/.test(gameId)) throw new Error("試合IDは G20260607 形式");
  const base: Game = doc?.game ?? { id: gameId, date: "", opponent: "", league: null, home_away: null, dh: false, result: null };
  const result: GameResult | null = patch.result !== undefined ? (patch.result ? { ...base.result, ...patch.result } : null) : base.result ?? null;
  const game: Game = {
    id: gameId,
    date: patch.date ?? base.date,
    opponent: patch.opponent ?? base.opponent,
    league: patch.league !== undefined ? patch.league?.trim() || null : base.league ?? null,
    home_away: patch.home_away !== undefined ? patch.home_away : base.home_away,
    dh: patch.dh !== undefined ? patch.dh : base.dh,
    result,
    note: base.note ?? null,
  };
  return doc ? { ...doc, game } : emptyDoc(game);
}

/** スタメン登録(seq0)。助っ人はG採番してadditional_players(名前付き)へ。出欠=played も生成。 */
function reduceSetStartingLineup(doc: GameDoc, gameId: string, rows: LineupRowInput[]): GameDoc {
  const additional: AdditionalPlayer[] = [...(doc.additional_players ?? [])];
  const guestByName = new Map(additional.filter((a) => a.type === "guest").map((a) => [a.name, a.id]));
  let gn = 1 + additional.reduce((m, a) => Math.max(m, parseInt(/^G(\d+)/.exec(a.id)?.[1] ?? "0", 10)), 0);
  const lineup = rows.map((r) => {
    let pid = r.player_id;
    if (!pid && r.guest_name) {
      pid = guestByName.get(r.guest_name);
      if (!pid) {
        pid = "G" + String(gn++).padStart(3, "0");
        guestByName.set(r.guest_name, pid);
        additional.push({ id: pid, name: r.guest_name, type: "guest" });
      }
    }
    if (!pid) throw new Error(`打順${r.order}: 選手が特定できません(既存IDか助っ人名が必要)`);
    return { order: r.order, position_id: (r.position as PositionId) ?? null, player_id: pid, automatic_out: false };
  });
  const roster: RosterEntry[] = lineup.map((l) => ({
    player_id: l.player_id, fielding_team: "N-KINGS", status: "active",
    stat_scope: l.player_id.startsWith("G") ? "guest" : "own", include_in_season: !l.player_id.startsWith("G"),
  }));
  const half: Half = kingsBatHalf(doc);
  const snap: LineupSnapshot = {
    game_id: gameId, team: "N-KINGS", snapshot_id: `${gameId}-NK-00`, seq: 0,
    effective_from: { inning: 1, half, before_order: null }, empty_slot_policy: "skip", roster, lineup, reason: "start",
  };
  const attendance: AttendanceEntry[] = lineup.map((l) => ({ player_id: l.player_id, status: "played", scope: l.player_id.startsWith("G") ? "guest" : "own" }));
  const others = (doc.lineup_snapshots ?? []).filter((s) => s.seq !== 0);
  return { ...doc, additional_players: additional, lineup_snapshots: [snap, ...others], attendance };
}

/**
 * 守備位置変更(delta)。直前(最大seq)のスナップショットを引き継ぎ、該当選手の position だけ差し替えて
 * 新スナップショットを追記する(=スタメンを全置換しない＝他の選手が消えない)。打順は不変。
 * 対象は player_id か from_position(現ロスターの占有者)で特定。スワップでも崩れないよう base に対して先に解決する。
 */
export function reduceChangeDefense(doc: GameDoc, gameId: string, changes: DefenseChangeInput[], at: { inning?: number; half?: Half }): GameDoc {
  const snaps = doc.lineup_snapshots ?? [];
  if (!snaps.length) throw new Error("スタメン未登録のため守備位置変更を適用できません");
  const base = [...snaps].sort((a, b) => a.seq - b.seq)[snaps.length - 1]; // 最新の有効ロスター
  const occupant = (pos?: string | null) => (pos ? base.lineup.find((l) => l.position_id === pos)?.player_id : undefined);
  // (対象player_id, 新position) を base に対して先に解決(applyMoves同様、スワップで破綻させない)
  const moves = changes.map((c) => {
    const pid = c.player_id ? (resolveBatter(doc, c.player_id) ?? c.player_id) : occupant(c.from_position);
    if (!pid) throw new Error("守備位置変更: 対象選手を特定できません(player_id か from_position が必要)");
    return [pid, (c.to_position as PositionId) ?? null] as const;
  });
  const moveMap = new Map(moves);
  const lineup = base.lineup.map((l) => (moveMap.has(l.player_id) ? { ...l, position_id: moveMap.get(l.player_id)! } : l));
  const st = gameState(doc);
  const half: Half = at.half ?? st.half;
  const inning = at.inning && at.inning > 0 ? at.inning : st.inning;
  const n = doc.plate_appearances.filter((p) => p.inning === inning && p.half === half).length; // この半イニングの既存打席数
  const seq = Math.max(...snaps.map((s) => s.seq)) + 1;
  const snap: LineupSnapshot = {
    game_id: gameId, team: "N-KINGS", snapshot_id: `${gameId}-NK-${String(seq).padStart(2, "0")}`, seq,
    effective_from: { inning, half, before_order: n > 0 ? n + 1 : null },
    empty_slot_policy: base.empty_slot_policy ?? "skip", roster: base.roster, lineup, reason: "defensive_change",
  };
  return { ...doc, lineup_snapshots: [...snaps, snap] };
}

/** ID解決: 既にID(P/G/O+数字)ならそのまま。助っ人名や "GUEST:名前" はその試合の additional_players のG-idへ。 */
function resolveBatter(doc: GameDoc, raw?: string): string | undefined {
  if (!raw) return undefined;
  if (/^[PGO]\d/i.test(raw)) return raw; // 既にID
  const name = raw.replace(/^GUEST:\s*/i, "").trim();
  const g = (doc.additional_players ?? []).find((a) => a.name === name);
  return g ? g.id : raw; // 見つからなければそのまま(新規助っ人はsetStartingLineupで登録済みの前提)
}

/** 打席内の全 runner_id(runs/baserunning) も同様に解決する(得点者・走塁が助っ人名のままにならないように)。 */
function normRunnerIds<T extends AddPAInput | EditPAInput>(doc: GameDoc, input: T): T {
  const r = (id?: string | null) => (id ? resolveBatter(doc, id) ?? id : id) as string;
  return {
    ...input,
    runs: input.runs?.map((x) => ({ ...x, runner_id: r(x.runner_id), ...(x.responsible_pitcher_id ? { responsible_pitcher_id: r(x.responsible_pitcher_id) } : {}) })),
    baserunning_after: input.baserunning_after?.map((m) => ({ ...m, runner_id: r(m.runner_id) })),
    baserunning_during: input.baserunning_during?.map((ev) => ({ ...ev, runners: ev.runners?.map((m) => ({ ...m, runner_id: r(m.runner_id) })) })),
  };
}

/** 投手/捕手を守備配置から導出。自軍守備(相手の攻撃half)だけ＝自軍攻撃時の相手投手は未追跡(null)。 */
function batteryAt(doc: GameDoc, inning: number, half: Half, order: number): { pitcher_id: string | null; catcher_id: string | null } {
  if (half !== oppBatHalf(doc)) return { pitcher_id: null, catcher_id: null };
  const pm = posMap(effectiveSnapshot(doc.lineup_snapshots ?? [], inning, half, order));
  return { pitcher_id: pm.get("1") ?? null, catcher_id: pm.get("2") ?? null };
}

/** 打席を1件追加。order/打順/開始時アウト/開始時走者/(省略時の)打者はサーバが導出。 */
function reduceAddPA(doc: GameDoc, rawInput: AddPAInput): { doc: GameDoc; placed: { inning: number; half: Half; order: number } } {
  const input = normRunnerIds(doc, rawInput);
  const raw = resolveBatter(doc, input.batter_id);
  // どの half-inning に置くかはサーバが決める(形式ルールは課さない＝側で決める)
  const { inning, half } = resolvePATarget(doc, { inning: input.inning, half: input.half, batter_id: raw });
  const d = deriveNextPA(doc, inning, half);
  // 自軍攻撃なら明示打者→打順。相手攻撃は選手を追跡しないので常にO自動(モデルの『相手N番』等は無視)。
  const batter_id = half === kingsBatHalf(doc) ? (raw ?? d.batter_id) : (d.batter_id ?? raw);
  if (!batter_id) throw new Error("打者が特定できません(打順未登録なら batter_id を指定)");
  const battery = batteryAt(doc, inning, half, d.order); // 投捕は守備配置から導出
  const pa: PlateAppearance = {
    inning, half, order: d.order, batting_slot: d.batting_slot,
    outs: d.outs, runners: d.runners, batter_id,
    pitcher_id: input.pitcher_id ?? battery.pitcher_id, catcher_id: input.catcher_id ?? battery.catcher_id,
    result: input.result, complete: input.complete ?? true,
    runs: [], fielding: input.fielding ?? null,
    baserunning_during: input.baserunning_during ?? [], baserunning_after: input.baserunning_after ?? [],
    note: input.note ?? null,
    ...(input.annotations?.length ? { annotations: input.annotations } : {}),
  };
  const resolved = resolveBaserunningIds(d.runners, pa); // 走塁runner_idをfrom-baseで確定(状態依存を吸収)
  const finalPa = { ...resolved, runs: deriveRuns(d.runners, resolved) }; // runs[]はエンジンが導出(得点者/打点/自責)
  return { doc: { ...doc, plate_appearances: [...doc.plate_appearances, finalPa] }, placed: { inning, half, order: d.order } };
}

function findPAIndex(doc: GameDoc, inning: number, half: Half, order: number): number {
  return doc.plate_appearances.findIndex((p) => p.inning === inning && p.half === half && p.order === order);
}

/** 既存打席を編集。渡したフィールドだけ差し替え、注記未指定なら不明瞭(unclear)は解決済みとして除去。 */
function reduceEditPA(doc: GameDoc, rawInput: EditPAInput): GameDoc {
  const input = normRunnerIds(doc, rawInput);
  const idx = findPAIndex(doc, input.inning, input.half, input.order);
  if (idx < 0) throw new Error(`${input.inning}回${input.half === "top" ? "表" : "裏"} ${input.order}番目の打席が見つかりません`);
  const cur = doc.plate_appearances[idx];
  const next: PlateAppearance = { ...cur };
  if (input.batter_id !== undefined) next.batter_id = resolveBatter(doc, input.batter_id) ?? input.batter_id;
  if (input.pitcher_id !== undefined) next.pitcher_id = input.pitcher_id;
  if (input.catcher_id !== undefined) next.catcher_id = input.catcher_id;
  if (input.result !== undefined) next.result = input.result;
  if (input.complete !== undefined) next.complete = input.complete;
  if (input.fielding !== undefined) next.fielding = input.fielding;
  if (input.runs !== undefined) next.runs = input.runs;
  if (input.baserunning_during !== undefined) next.baserunning_during = input.baserunning_during;
  if (input.baserunning_after !== undefined) next.baserunning_after = input.baserunning_after;
  if (input.note !== undefined) next.note = input.note;
  if (input.annotations !== undefined) next.annotations = input.annotations;
  else if (next.annotations?.length) next.annotations = next.annotations.filter((a) => a.type !== "unclear"); // 編集＝不明瞭の解決
  const start0 = startRunnersBefore(doc, input.inning, input.half, input.order);
  const resolvedE = resolveBaserunningIds(start0, next);
  const fixed = { ...resolvedE, runs: deriveRuns(start0, resolvedE) }; // 走塁確定→runs[]再導出
  const pas = [...doc.plate_appearances];
  pas[idx] = fixed;
  return { ...doc, plate_appearances: pas };
}

/** 既存打席を削除し、その half-inning の order を 1..N に振り直す。 */
function reduceRemovePA(doc: GameDoc, input: RemovePAInput): GameDoc {
  if (findPAIndex(doc, input.inning, input.half, input.order) < 0) {
    throw new Error(`${input.inning}回${input.half === "top" ? "表" : "裏"} ${input.order}番目の打席が見つかりません`);
  }
  const remaining = doc.plate_appearances.filter((p) => !(p.inning === input.inning && p.half === input.half && p.order === input.order));
  // 同じ half-inning を order 連番に振り直す(歯抜け回避)
  const renumber = new Map<PlateAppearance, number>();
  remaining.filter((p) => p.inning === input.inning && p.half === input.half).sort((a, b) => a.order - b.order)
    .forEach((p, i) => renumber.set(p, i + 1));
  const pas = remaining.map((p) => (renumber.has(p) ? { ...p, order: renumber.get(p)! } : p));
  return { ...doc, plate_appearances: pas };
}

/**
 * 操作の配列を1世代で原子的に反映(AIの1返却＝これ1回)。
 * 作業中(下書き)を1回ロード→順に畳む→1回 commit。base_gen で楽観ロック。
 * 戻り値は各opの人間向け要約(画面の「反映しました」用)。
 */
export async function applyOps(gameId: string, ops: GameOpInput[], opts: CommitOpts = {}): Promise<string[]> {
  const w = await loadWorking(gameId);
  let doc: GameDoc | null = w?.doc ?? null;
  const summaries: string[] = [];
  for (const op of ops) {
    if (op.type === "setGameMeta") {
      const { type, ...patch } = op; void type;
      doc = reduceSetGameMeta(doc, gameId, patch);
      summaries.push("メタ情報を更新しました");
    } else if (op.type === "setStartingLineup") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      doc = reduceSetStartingLineup(doc, gameId, op.rows ?? []);
      summaries.push(`スタメン${(op.rows ?? []).length}人を登録しました`);
    } else if (op.type === "changeDefense") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      doc = reduceChangeDefense(doc, gameId, op.changes ?? [], { inning: op.inning, half: op.half });
      summaries.push(`守備位置変更(${(op.changes ?? []).length}件)を反映しました`);
    } else if (op.type === "addPlateAppearance") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      const { type, ...input } = op; void type;
      const r = reduceAddPA(doc, input as AddPAInput);
      doc = r.doc;
      summaries.push(`${r.placed.inning}回${r.placed.half === "top" ? "表" : "裏"} ${r.placed.order}人目の打席を追加しました`);
    } else if (op.type === "editPlateAppearance") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      const { type, ...input } = op; void type;
      doc = reduceEditPA(doc, input as EditPAInput);
      summaries.push(`${input.inning}回${input.half === "top" ? "表" : "裏"} ${input.order}番目の打席を修正しました`);
    } else if (op.type === "removePlateAppearance") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      const { type, ...input } = op; void type;
      doc = reduceRemovePA(doc, input as RemovePAInput);
      summaries.push(`${input.inning}回${input.half === "top" ? "表" : "裏"} ${input.order}番目の打席を削除しました`);
    } else {
      throw new Error(`未知の操作: ${(op as { type?: string }).type}`);
    }
  }
  if (!doc) throw new Error("適用できる操作がありません");
  if (opts.repair !== false) doc = repairGame(doc); // 決定的に直せる不整合は修復。AI修正は repair:false で整合性を取らない
  doc = applyValidation(doc); // 残りの矛盾はルールベース事後検査で不明瞭タグ(冪等・値は変えない)
  await commitGameDoc(doc, co({ ...opts, base_gen: w?.gen }, { type: "applyOps", args: { gameId, ops: ops.map((o) => o.type) } }));
  return summaries;
}

/** 単発の薄いラッパ(管理UI等から1操作だけ呼ぶ用)。中身は applyOps と同じ原子経路。 */
export async function setGameMeta(gameId: string, patch: Partial<GameMetaInput>, opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "setGameMeta", ...patch }], opts);
}
export async function setStartingLineup(gameId: string, rows: LineupRowInput[], opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "setStartingLineup", rows }], opts);
}
export async function addPlateAppearance(gameId: string, input: AddPAInput, opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "addPlateAppearance", ...input }], opts);
}

/** 軽量サマリ(対象1試合のみ): メタ＋オーダー＋現在状態。AI入力の参照用(全打席は返さない)。 */
export async function getGameSummary(gameId: string) {
  const w = await loadWorking(gameId);
  if (!w) return null;
  const doc = w.doc;
  // 記録済み打席のダイジェスト(=再入力禁止の根拠)。AIが会話履歴の過去分を二重登録しないために渡す。
  const recorded = [...doc.plate_appearances]
    .sort((a, b) => a.inning - b.inning || (a.half === "top" ? 0 : 1) - (b.half === "top" ? 0 : 1) || a.order - b.order)
    .map((p) => `${p.inning}${p.half === "top" ? "表" : "裏"}#${p.order} ${p.batter_id} ${p.result}${p.note ? `(${p.note})` : ""}`);
  return {
    id: doc.game.id, date: doc.game.date, opponent: doc.game.opponent, league: doc.game.league, home_away: doc.game.home_away, dh: doc.game.dh, result: doc.game.result,
    lineup: lineupSlots(doc).map((e) => ({ order: e.order, position_id: e.position_id, player_id: e.player_id })),
    additional_players: doc.additional_players ?? [],
    attendance_count: (doc.attendance ?? []).length,
    state: gameState(doc),
    recorded,
    draft: w.draft, gen: w.gen,
  };
}

/** 試合doc を JSON 文字列から取り込み（丸ごと upsert）。構造を軽く検証。 */
export async function importGameDoc(json: string, opts: CommitOpts = {}): Promise<string> {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error("JSON の構文が不正です");
  }
  validateGameDoc(doc);
  await commitGameDoc(doc, co(opts, { type: "importGameDoc", args: { id: doc.game.id } }));
  return doc.game.id;
}

function validateGameDoc(doc: unknown): asserts doc is GameDoc {
  const d = doc as Record<string, unknown>;
  if (!d || typeof d !== "object") throw new Error("オブジェクトではありません");
  if (d.schema_version !== "2.0") throw new Error('schema_version は "2.0" が必要です');
  const game = d.game as Record<string, unknown> | undefined;
  if (!game || typeof game.id !== "string" || !/^G\d{8}$/.test(game.id))
    throw new Error("game.id が G20260607 形式ではありません");
  if (typeof game.date !== "string" || !game.date) throw new Error("game.date が必要です");
  for (const f of ["plate_appearances", "lineup_snapshots", "attendance", "additional_players"]) {
    if (!Array.isArray(d[f])) throw new Error(`${f} は配列が必要です`);
  }
}
