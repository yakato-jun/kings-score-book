/**
 * v2 試合データの型定義（正準スキーマ baseball_score_schema/schema/v2 に対応）。
 * 機密データ本体はリポ管理外。ここは構造の型のみ。
 */

export type PositionId =
  | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "DH" | null;

/** 打席結果コード（masters/v2/result_types.json）。INC=未完了, AUTO_OUT=自動アウト枠 */
export type ResultCode =
  | "H" | "H1" | "H2" | "H3" | "HR"
  | "OUT" | "K" | "FC" | "E"
  | "BB" | "HBP" | "SH" | "SF" | "CI"
  | "INC" | "AUTO_OUT"
  | null;

export type Half = "top" | "bottom";

export interface Runners {
  first: string | null;
  second: string | null;
  third: string | null;
}

/** runs[] が得点/打点/自責の正本 */
export interface RunEvent {
  runner_id: string;
  rbi: boolean;
  earned: boolean;
  cause:
    | "hit" | "hr" | "walk" | "hbp" | "sf" | "sh" | "fc"
    | "groundout" | "error" | "wp" | "pb" | "bk" | "sb"
    | "defensive_indifference" | "other";
  responsible_pitcher_id?: string | null;
}

export interface FieldingOut {
  at: string; // 1,2,3,home,K,-
  type: "force" | "tag" | "catch";
  runner_id?: string | null;
  putout_position?: string | null;
  assist_positions?: string[];
}

export interface FieldingError {
  pos: string;
  type: string; // fielding | throwing | drop
}

export interface Fielding {
  hit_to: string | null;
  hit_type?: string | null;
  infield_hit?: boolean;
  ground_rule?: boolean;
  sequence: string[];
  outs: FieldingOut[];
  errors: FieldingError[];
}

export interface BaserunMove {
  runner_id: string;
  from: string | null;
  to: string; // 1,2,3,home,out
  reason?: string | null;
}

export interface BaserunDuring {
  event: string; // SB | CS | WP | PB | BK | PO ...
  trigger_base?: string | null;
  runners?: BaserunMove[];
  fielding?: {
    sequence?: string[];
    outs?: { at: string; type: string; runner_id?: string | null }[];
    errors?: FieldingError[];
  } | null;
  note?: string | null;
}

export interface PlateAppearance {
  game_id?: string;
  inning: number;
  half: Half;
  order: number;
  batting_slot?: number | null;
  outs: number;
  runners: Runners;
  batter_id: string;
  pitcher_id?: string | null;
  catcher_id?: string | null;
  result: ResultCode;
  complete: boolean;
  dropped_third_strike?: boolean;
  automatic_out?: boolean;
  intentional?: boolean; // 申告敬遠（暫定フィールド・要正準化）
  runs: RunEvent[];
  fielding?: Fielding | null;
  pinch_runner?: { type: string; runner_id: string; note?: string | null } | null;
  double_play?: boolean;
  triple_play?: boolean;
  baserunning_during?: BaserunDuring[];
  baserunning_after: BaserunMove[];
  game_end?: boolean;
  note?: string | null; // [表示用] 実況テキスト。システム用注記は annotations[] へ
  annotations?: Annotation[]; // [システム用] 表示しない記録員メモ
}

/** [システム用] noteから分離した記録員メモ。type で機械処理(unclear→修正入力, manual=採点根拠, other=自由文) */
export interface Annotation {
  type: "unclear" | "manual" | "other";
  detail: string;
}

export interface LineupEntry {
  order: number | null; // null = DH制の投手など打順なし
  position_id: PositionId;
  player_id: string;
  automatic_out?: boolean;
}

export interface RosterEntry {
  player_id: string;
  fielding_team: string;
  status: string;
  stat_scope: "own" | "guest";
  include_in_season: boolean;
}

export interface LineupSnapshot {
  game_id: string;
  team: string;
  snapshot_id: string;
  seq: number;
  effective_from: { inning: number; half: Half; before_order: number | null };
  empty_slot_policy?: string;
  roster: RosterEntry[];
  lineup: LineupEntry[];
  reason: string | null;
}

/** 出欠（attendance.schema.json）。参加=成績と独立した第一級の事実 */
export interface AttendanceEntry {
  player_id: string;
  status: "played" | "bench";
  scope: "own" | "guest";
}

export interface GameResult {
  our_score: number;
  their_score: number;
  outcome: "win" | "loss" | "tie";
  decided_by:
    | "regulation" | "time_limit" | "walkoff" | "called" | "forfeit" | "tie";
  scheduled_innings?: number | null;
  line_score?: { ours: (number | null)[]; theirs: (number | null)[] } | null;
}

export interface Game {
  id: string;
  date: string; // YYYY-MM-DD
  opponent: string;
  league: string | null;
  home_away: "home" | "away" | null; // forfeit は null
  dh: boolean;
  result?: GameResult | null;
  note?: string | null;
}

export interface AdditionalPlayer {
  id: string;
  name: string;
  type: string; // opponent | guest ...
}

/** 選手マスタ（id→名前）。名前は機密のためリポ外→Atlas players コレクション経由 */
export interface Player {
  id: string;
  name: string;
  type?: string;
}

/** 投手の記録員判断（自責点など）。OBR9.16の回再構成を伴うため集計で再計算せず記録値を正本にする。 */
export interface PitchingRecord {
  pitcher_id: string;
  earned_runs: number; // 自責点（明示・記録値）
  decision?: "W" | "L" | "S" | null; // [任意] 勝敗/セーブも記録員判断。将来拡張用
}

/** 履歴1版が記録した操作（監査・逆操作生成の補助。中抜き機構は依存しない＝任意） */
export interface GameOp {
  type: string;
  args?: unknown;
}

/**
 * 試合履歴の1版（append-only）。最新スナップショット(games)とは別の履歴コレクションに版ごとに1doc。
 * 編集/ロールバック/中抜き(revert)/下書き=すべて先端に1版appendするだけ（線形・枝分かれなし）。
 */
export interface GameVersion {
  game_id: string;
  gen: number; // 1始まり（gen0=履歴前のシード状態の暗黙値）
  snapshot: GameDoc;
  op?: GameOp | null;
  updated_at: string; // ISO
  updated_by: string; // 当面 "ui" | "ai" | "seed"、認証後にユーザーID
  draft: boolean; // true=履歴に積むが games(最新) は更新しない
}

/** 1試合の完全ドキュメント（output/G2026xxxx.json） */
export interface GameDoc {
  schema_version: "2.0";
  game: Game;
  additional_players: AdditionalPlayer[];
  lineup_snapshots: LineupSnapshot[];
  plate_appearances: PlateAppearance[];
  attendance: AttendanceEntry[];
  pitching?: PitchingRecord[]; // 投手別の記録員判断（自責点を明示）。省略時はruns[].earnedから集計
}
