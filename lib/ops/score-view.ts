/**
 * [§10.3 Phase D] スコア入力タブ(試合データエディタ)の表示モデルを GameDoc から純関数で導出する。
 * page.tsx(サーバ) がこれを呼んで serializable なビューをクライアント(ScoreInput)へ渡す。
 * 「スキーマが表現できる事実はすべて画面から見え・直せる」= ここが各打席の全事実＋導出プレビューを組み立てる。
 * 純関数なので vitest で単体検証できる(nameOf はリゾルバを注入)。
 */
import type {
  GameDoc, Half, PlateAppearance, ResultCode, Fielding, BaserunDuring, BaserunMove, Annotation,
  DirectBatting, DirectPitching, DirectFielding,
} from "@/lib/types/v2";
import { derivePAStates, kingsBatHalf, deriveResponsiblePitchers } from "./gamestate";
import { effectiveSnapshot, posMap } from "@/lib/agg";
import { unresolvedUnclear } from "./validate";

const halfRank = (h: Half) => (h === "top" ? 0 : 1);
const chrono = (a: { inning: number; half: Half; order: number }, b: { inning: number; half: Half; order: number }) =>
  a.inning - b.inning || halfRank(a.half) - halfRank(b.half) || a.order - b.order;

/** 打席結果コード→日本語ラベル(全コード)。汎用 "H" は表示のみ(選択肢からは除外)。 */
export const RESULT_LABELS: Record<string, string> = {
  H1: "単打", H2: "二塁打", H3: "三塁打", HR: "本塁打", H: "安打",
  BB: "四球", HBP: "死球", K: "三振", OUT: "凡退", E: "失策出塁", FC: "野選",
  SH: "犠打", SF: "犠飛", CI: "打妨", INC: "未完了", AUTO_OUT: "自動アウト",
};
export function resultLabel(code: ResultCode): string {
  return (code && RESULT_LABELS[code]) || code || "?";
}

/** エディタの結果選択肢(§10.3: AUTO_OUT を含める・汎用 "H" は出さない)。 */
export const RESULT_CHOICES: [string, string][] = [
  ["H1", "単打"], ["H2", "二塁打"], ["H3", "三塁打"], ["HR", "本塁打"],
  ["BB", "四球"], ["HBP", "死球"], ["K", "三振"], ["OUT", "凡退"],
  ["E", "失策出塁"], ["FC", "野選"], ["SH", "犠打"], ["SF", "犠飛"],
  ["CI", "打妨"], ["AUTO_OUT", "自動アウト"], ["INC", "未完了"],
];

const BASE_JP: Record<string, string> = { first: "一", second: "二", third: "三" };

export interface RunView {
  runner_id: string;
  name: string;
  rbi: boolean;
  cause: string;
  responsible_pitcher_id: string | null;
  responsiblePitcherName: string | null;
}

export interface AnnoView { detail: string; rule: string | null; source: string | null }

/** 1打席の全事実＋導出プレビュー(編集初期値)。 */
export interface PARowView {
  paId: string | null;
  inning: number;
  half: Half;
  order: number;
  isKingsHalf: boolean;
  isOpp: boolean;
  batter_id: string;
  batterName: string;
  batting_slot: number | null;
  opponent_slot: number | null;
  result: ResultCode;
  resultLabel: string;
  complete: boolean;
  dropped_third_strike: boolean;
  intentional: boolean;
  automatic_out: boolean;
  double_play: boolean;
  triple_play: boolean;
  note: string | null;
  fielding: Fielding | null;
  baserunning_during: BaserunDuring[];
  baserunning_after: BaserunMove[];
  pinch_runner: PlateAppearance["pinch_runner"];
  // 導出プレビュー(編集不可)
  startOuts: number;
  startRunners: { base: string; baseJp: string; runner_id: string; name: string }[];
  runs: RunView[];
  // 注記パネル
  unresolved: AnnoView[];
  manualNotes: { detail: string }[];
  annotationsRaw: Annotation[]; // 手動注記の追加時に全置換で失わないよう保持(内部用・非表示)
}

/** 全打席の表示モデル(時系列)。半イニング区切り・挿入導線・エディタ初期値はこの配列から作る。 */
export function buildPARows(doc: GameDoc, nameOf: (id: string) => string): PARowView[] {
  const kb = kingsBatHalf(doc);
  const states = derivePAStates(doc);
  const respMap = deriveResponsiblePitchers(doc); // [§10.6] 責任投手はread時導出(reach規則+手動override)を表示に使う
  return [...doc.plate_appearances].sort(chrono).map((p) => {
    const st = states.get(p);
    const isKingsHalf = p.half === kb;
    const runners = st?.runners ?? { first: null, second: null, third: null };
    const startRunners = (["first", "second", "third"] as const)
      .flatMap((b) => (runners[b] ? [{ base: b, baseJp: BASE_JP[b], runner_id: runners[b]!, name: nameOf(runners[b]!) }] : []));
    const paResp = respMap.get(p);
    const runs: RunView[] = (p.runs ?? []).map((r) => {
      // [§0-C] 得点者不明(runner_id=null)は責任map非キー。responsible_pitcher_id明示 or 導出(表示側は空)へ。
      const resp = (r.runner_id != null ? paResp?.get(r.runner_id) : undefined) ?? r.responsible_pitcher_id ?? null;
      return {
        runner_id: r.runner_id ?? "",
        name: r.runner_id != null ? nameOf(r.runner_id) : "不明",
        rbi: r.rbi,
        cause: r.cause,
        responsible_pitcher_id: resp,
        responsiblePitcherName: resp ? nameOf(resp) : null,
      };
    });
    const ann = p.annotations ?? [];
    const unresolved: AnnoView[] = unresolvedUnclear(p).map((a) => ({ detail: a.detail, rule: a.rule ?? null, source: a.source ?? null }));
    const manualNotes = ann.filter((a) => a.type === "manual").map((a) => ({ detail: a.detail }));
    return {
      paId: p.id ?? null,
      inning: p.inning,
      half: p.half,
      order: st?.order ?? p.order,
      isKingsHalf,
      isOpp: p.opponent_slot != null,
      batter_id: p.batter_id,
      batterName: p.opponent_slot != null ? `相手${p.opponent_slot}番` : nameOf(p.batter_id),
      batting_slot: p.batting_slot ?? null,
      opponent_slot: p.opponent_slot ?? null,
      result: p.result,
      resultLabel: resultLabel(p.result),
      complete: p.complete !== false,
      dropped_third_strike: !!p.dropped_third_strike,
      intentional: !!p.intentional,
      automatic_out: !!p.automatic_out,
      double_play: !!p.double_play,
      triple_play: !!p.triple_play,
      note: p.note ?? null,
      fielding: p.fielding ?? null,
      baserunning_during: p.baserunning_during ?? [],
      baserunning_after: p.baserunning_after ?? [],
      pinch_runner: p.pinch_runner ?? null,
      startOuts: st?.outs ?? p.outs ?? 0, // [§10.6] 導出(derivePAStates=主張値優先/未主張は盤面から)。rawのnull/未設定は0
      startRunners,
      runs,
      unresolved,
      manualNotes,
      annotationsRaw: ann,
    };
  });
}

export interface LineupSlotView {
  order: number | null;
  position_id: string | null;
  player_id: string;
  name: string;
}

/** 現在の(最新有効スナップショットの)打順・守備。交代エディタの現状表示に使う。 */
export function buildCurrentLineup(doc: GameDoc, nameOf: (id: string) => string): LineupSlotView[] {
  const snaps = doc.lineup_snapshots ?? [];
  if (!snaps.length) return [];
  const latest = [...snaps].sort((a, b) => b.seq - a.seq)[0];
  return [...latest.lineup]
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .map((e) => ({ order: e.order ?? null, position_id: e.position_id ?? null, player_id: e.player_id, name: nameOf(e.player_id) }));
}

export interface PitcherRowView {
  player_id: string;
  name: string;
  earned_runs: number | null;
  decision: "W" | "L" | "S" | null;
}

/**
 * 登板した投手(自軍守備half=相手攻撃halfの各打席の有効スナップショット守備位置1)を登場順で。
 * 既存の投手記録(doc.pitching)の自責/勝敗Sを突き合わせる。記録だけあって未登板の投手も末尾に含める。
 */
export function buildPitcherRows(doc: GameDoc, nameOf: (id: string) => string): PitcherRowView[] {
  const kb = kingsBatHalf(doc);
  const snaps = doc.lineup_snapshots ?? [];
  const oppPAs = [...doc.plate_appearances].filter((p) => p.half !== kb).sort(chrono);
  const rec = new Map((doc.pitching ?? []).map((r) => [r.pitcher_id, r]));
  const seen = new Set<string>();
  const rows: PitcherRowView[] = [];
  for (const pa of oppPAs) {
    const pid = posMap(effectiveSnapshot(snaps, pa.inning, pa.half, pa.order)).get("1");
    if (pid && !seen.has(pid)) {
      seen.add(pid);
      const r = rec.get(pid);
      rows.push({ player_id: pid, name: nameOf(pid), earned_runs: r?.earned_runs ?? null, decision: r?.decision ?? null });
    }
  }
  // 記録はあるが登板検出に載らなかった投手(旧データ・手入力)も残す
  for (const r of doc.pitching ?? []) {
    if (seen.has(r.pitcher_id)) continue;
    seen.add(r.pitcher_id);
    rows.push({ player_id: r.pitcher_id, name: nameOf(r.pitcher_id), earned_runs: r.earned_runs, decision: r.decision ?? null });
  }
  return rows;
}

/**
 * [クラスタA A3 / minor①] 投手記録フォームの行 → setPitchingRecords 入力(全置換)。
 *  自責(er)の空欄=不明→0埋め捏造をしない。ただし判定(decision)だけ付けた投手は落とさず earned_runs:null(不明)で残す
 *  (勝ち投手が無警告で消えるのを防ぐ。RunEvent.earned=null と同イディオム)。
 *   - er非空 → earned_runs=Number(er)（er="0" は明示ゼロ＝0保持）。
 *   - er空欄 & decisionあり → earned_runs:null で残す（自責不明のまま勝敗Sを保持）。
 *   - er空欄 & decisionなし → 除外（記録すべき内容が無い）。er:0 を捏造せず全置換の巻き添えで他投手も壊さない。
 */
export function pitchingRowsToRecords(
  rows: { player_id: string; er: string; decision?: string }[]
): { player: string; earned_runs: number | null; decision?: "W" | "L" | "S" | null }[] {
  return rows
    .filter((r) => r.er.trim() !== "" || !!r.decision) // er空欄でも decision があれば残す
    .map((r) => ({
      player: r.player_id,
      earned_runs: r.er.trim() !== "" ? Number(r.er) : null, // 空欄=不明(null)。"0" は 0 保持
      ...(r.decision ? { decision: r.decision as "W" | "L" | "S" } : { decision: null }),
    }));
}

/** 投手記録フォームの1行(自責 er は空欄=不明を表す文字列・判定は ""=なし)。 */
export interface PitcherFormRow { player_id: string; name: string; er: string; decision: string }

/** 投手記録フォームの初期行(seed)。props(PitcherRowView[])→フォーム行。earned_runs:null は空欄("")＝不明。 */
export function seedPitcherRows(pitchers: PitcherRowView[]): PitcherFormRow[] {
  return pitchers.map((p) => ({ player_id: p.player_id, name: p.name, er: p.earned_runs != null ? String(p.earned_runs) : "", decision: p.decision ?? "" }));
}

/** 投手集合キー(登場順の player_id 連結)。フォームの再シード判定に使う＝集合が同一なら再シードせず編集中入力を保つ。 */
export function pitcherSetKey(pitchers: { player_id: string }[]): string {
  return pitchers.map((p) => p.player_id).join(",");
}

/** [§0/§11] 個人成績(断片)セクションの初期値。既存 doc.direct_stats を participant 名付きで表示する。 */
export interface DirectStatRowView {
  participant_id: string;
  name: string;
  batting: DirectBatting | null;
  pitching: DirectPitching | null;
  fielding: DirectFielding | null;
  note: string | null;
}
export function buildDirectStatRows(doc: GameDoc, nameOf: (id: string) => string): DirectStatRowView[] {
  return (doc.direct_stats ?? []).map((ds) => ({
    participant_id: ds.participant_id,
    name: nameOf(ds.participant_id),
    batting: ds.batting ?? null,
    pitching: ds.pitching ?? null,
    fielding: ds.fielding ?? null,
    note: ds.note ?? null,
  }));
}
