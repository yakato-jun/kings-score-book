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

/** runs[] が得点/打点/自責の正本。
 * [§10.6 非破壊リワーク] origin=一度きりの導出fill(auto・上書き可) / 人が明示した記録(manual・保持)。
 *   非破壊: 明示された生還(manual)は盤面と食い違っても保持し、R1が食い違いをflag(黙って落とさない)。
 * responsible_pitcher_id は auto 導出専用に戻した(§10.6 item3)。手動の責任投手上書きは doc.run_overrides へ。
 * [§0/§11] runner_id は null 可＝「得点は入ったが得点者不明」(§0-C)。null得点はチーム得点(line_score)/
 *   投手失点・自責は計上するが、選手別の得点(R)は動かさない(捏造しない)。集計/検査は null を専用に扱う。 */
export interface RunEvent {
  runner_id: string | null;
  rbi: boolean;
  // [クラスタA] null=自責か否か不明。runner_id=null と厳密に平行: 投手失点(r)は計上するが自責(er)は計上しない=不明として扱う(捏造しない)。
  //   error由来=false(自明clear) / 通常導出=true(標準の記録近似=仮確定・origin:auto が仮確定を表す) / 走者不明得点(manual)=null(自責不明)。
  earned: boolean | null;
  cause:
    | "hit" | "hr" | "walk" | "hbp" | "sf" | "sh" | "fc"
    | "groundout" | "error" | "wp" | "pb" | "bk" | "sb"
    | "defensive_indifference" | "other";
  responsible_pitcher_id?: string | null;
  origin?: "auto" | "manual"; // [§10.6] auto=導出fill(毎回上書き可) / manual=人の明示(保持)。未設定は auto 扱い
}

/**
 * [§10.6 非破壊リワーク] 手動の責任投手上書き(記録値=人の明示)を doc レベルに分離して永続化するストア。
 * runs[].responsible_pitcher_id(auto導出)へ畳まない＝自動と手動の同居(判別不能)を解消する。
 * read(集計/検査)時に auto 導出結果へ最優先で上書きされる。打席は不変ID(pa_id)で参照。
 */
export interface RunOverride {
  pa_id: string; // 打席の不変ID(b1..)
  runner_id: string;
  responsible_pitcher_id: string | null;
  origin: "manual";
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
  id?: string; // [§10.3] 打席の不変ID(サーバ採番・不透明 b1..)。編集/削除/挿入/承認のアドレス。旧データは遅延採番
  inning: number;
  half: Half;
  order: number;
  batting_slot?: number | null;
  opponent_slot?: number | null; // [§9] 相手打順(1..9)の第一級の置き場所。相手は身元非追跡でこの位置のみ追う。自軍PAでは未使用
  // [§10.6] 開始時アウト数。number=人が明示した主張値(4-5アウト回/DP等で保存が正) / null|未設定=未主張(read時にderivePAStatesが盤面から導出)。
  //   スイープは主張値(number)を上書きしない＝非破壊。旧データ(全部が導出値)は移行でnull戻し(食い違いはflag)。
  outs?: number | null;
  runners?: Runners; // [廃止§9] 保存開始時走者。読み手ゼロ(走者は毎回導出が正本)で未解決トークン混入の温床だったため廃止。移行後は持たない
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
  // [§10.3 代走=本対応] for_base=交代した塁(この打席開始時に盤面の走者を置換)。旧データはfor_base無し=盤面置換なし(表示のみ)
  pinch_runner?: { type: string; runner_id: string; for_base?: "1" | "2" | "3" | null; replaced_id?: string | null; note?: string | null } | null;
  double_play?: boolean;
  triple_play?: boolean;
  baserunning_during?: BaserunDuring[];
  baserunning_after: BaserunMove[];
  game_end?: boolean;
  // [§14.1 研究A] ノートに人が書いた「この打席の後」の状態記載(チェックサム)の転記。導出値ではない＝
  //   エンジン(スイープ/再導出)は一切触らず、AIは判断ゼロで記載をそのまま写す。R11 が導出盤面と突合し不一致をflag。
  //   省略(=記載なし)と [](=「走者なし」と記載) を型で区別する＝曖昧第一級(記載の無いノートでは完全に無変化)。
  stated_outs?: number | null; // この打席の後のアウト数の記載。null/未設定=無記載
  stated_runners?: ("1" | "2" | "3")[] | null; // この打席の後の走者占有塁の記載。[]=走者なしと記載、null/未設定=無記載
  note?: string | null; // [表示用] 実況テキスト。システム用注記は annotations[] へ
  annotations?: Annotation[]; // [システム用] 表示しない記録員メモ
}

/** [システム用] noteから分離した記録員メモ。type で機械処理(unclear→要確認, resolved→解決済み(承認), manual=採点根拠, other=自由文) */
export interface Annotation {
  type: "unclear" | "resolved" | "manual" | "other";
  detail: string;
  source?: "ai" | "validator" | "manual"; // validator=再検査で置換される(冪等) / ai・manual=永続
  resolved_by?: string | null; // resolved の時: 誰が解決したか(当面admin)
  rule?: string | null; // ルールコード(R1..R5)。validatorのunclear/承認のキー。AI由来はnull(キーイング不可=打席単位で承認)
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
  stat_scope?: "own" | "guest"; // [廃止予定§9] 読み手ゼロの死フラグ。scopeは participants.link から導出。移行後docは持たない
  include_in_season?: boolean; // [廃止予定§9] 同上
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

/**
 * [§9 参加者ID層] 試合ローカルの参加者。出欠(attendance)と additional_players を統合した「試合の人リスト1本」。
 * 打撃/守備/投手/出欠の全データは participants の id(不透明・試合ローカル)を参照する＝打席データと選手(マスタ人格)を疎結合に。
 * team/scope/season_counted は link から純関数導出（格納しない＝矛盾を型で表現不能に）。
 */
export type ParticipantLink =
  | { kind: "roster"; player_id: string } // 自軍ロスター(シーズン集計の正本人格。player_idで合算)
  // [§12 P5 legacy・撤去しない] 現公開版の新規linkは全て roster(助っ人=種別guestのマスタ選手)へ移行済み＝
  //   新規に guest link は作らない。だが game_history の過去版が旧 guest link を保持するため型の縮約はしない
  //   (過去版プレビュー ?gen=N の集計/名前解決に必要)。
  | { kind: "guest"; name?: string | null; was?: string | null }; // 助っ人/抜いた跡。was有り=抜いたロスター(成績残し・再リンク可)・無し=純助っ人。シーズン非合算

export interface Participant {
  id: string; // 不透明・試合ローカルID。打席データが参照する唯一のID
  link: ParticipantLink;
  // [参加=出席の第一級記録] participants[]に在籍=出席・不在=欠席。
  //   played/bench の区別は廃止(出た/出ないは成績の有無から導出＝派生概念をスキーマに持たない)。
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
  // 種別。将来の助っ人一本化での予約値: "regular"(正選手) | "guest"(助っ人)。
  //   後方互換のため自由文字列のまま(既存データは "member" 既定や未設定が混在)。値は狭めない=壊さない最優先。
  //   未設定/空は "regular" 相当として扱う(loadPlayerMap がメモリ上で正規化・DBは書かない)。
  type?: string;
  // [助っ人移行用・任意] 助っ人participantを種別付きマスタ選手へ一本化した際の出自＝冪等キー。
  //   同じ game_id/participant_id からの二重生成を防ぐ。通常の正選手には付かない。
  origin?: { kind: "guest_migration"; game_id: string; participant_id: string };
}

/**
 * [§0/§11 断片試合] 盤面(PA)を伴わない個人成績の直接記録。participant別に打撃/投手/守備の数値を
 * **全optional**で主張する(空欄=None・0埋めしない＝参加第一級と同型)。origin:"manual"=導出射程外＝構造的に人の主張。
 * 集計は PA走査の後に同じ resolve(participant_id) キーへ additive 加算する(§11 集計2段化)。
 * 「盤面ある事実=PA・無い事実=direct_stats」で違法状態を表現不能に(PA必須フィールドは緩和しない)。
 */
export interface DirectBatting {
  pa?: number; ab?: number; r?: number; h?: number; b1?: number; b2?: number; b3?: number;
  hr?: number; rbi?: number; bb?: number; hbp?: number; k?: number; sh?: number; sf?: number; sb?: number;
}
export interface DirectPitching {
  outs?: number; bf?: number; h?: number; hr?: number; k?: number; bb?: number; hbp?: number;
  r?: number; er?: number; wp?: number; decision?: "W" | "L" | "S" | null;
}
export interface DirectFielding {
  po?: number; a?: number; e?: number; tc?: number;
}
export interface DirectStatLine {
  participant_id: string; // participants[].id を指す(未登録は書込時V-Dでthrow拒否・幽霊guest化防止)
  batting?: DirectBatting | null;
  pitching?: DirectPitching | null;
  fielding?: DirectFielding | null;
  origin: "manual"; // 常にmanual=人の明示(導出射程外)
  note?: string | null;
  annotations?: Annotation[];
}

/** 投手の記録員判断（自責点など）。OBR9.16の回再構成を伴うため集計で再計算せず記録値を正本にする。 */
export interface PitchingRecord {
  pitcher_id: string;
  earned_runs: number | null; // 自責点（明示・記録値）。null=decisionはあるが自責は不明（RunEvent.earned と同イディオム：値の不明をnullで第一級表現）
  decision?: "W" | "L" | "S" | null; // [任意] 勝敗/セーブも記録員判断。将来拡張用
}

/** 履歴1版が記録した操作（監査・逆操作生成の補助。中抜き機構は依存しない＝任意） */
/** どの機能がこの版を生んだか。データ構造が業務(編集の出自)を語る。 */
export type EditSource = "ai_aggregate" | "ai_edit" | "manual" | "publish" | "rollback" | "revert" | "migration";

/** その版を生んだ変更リソース(正本入力)。AI集計=ノート全文 / AI修正=指示文+対象打席 / 手修正=操作内容。 */
export interface VersionInput {
  kind: "note" | "instruction" | "manual";
  text: string;
  target?: { inning: number; half: Half; order: number } | null; // ai_edit時の対象打席
}

/**
 * 試合履歴の1版（append-only）。最新スナップショット(games)とは別の履歴コレクションに版ごとに1doc。
 * draft:true=未確定(破棄可)／false=公開版(正本・不変)。working=最大gen、public=最大genのdraft:false。
 */
export interface GameVersion {
  game_id: string;
  gen: number; // 1始まり（gen0=履歴前のシード状態の暗黙値）
  draft: boolean; // true=未確定(破棄可・games更新しない) / false=公開版(正本)
  snapshot: GameDoc;
  updated_at: string; // ISO
  updated_by: string; // 当面 "admin"、認証後にユーザーID
  edit_source: EditSource; // どの機能で編集したか
  input?: VersionInput | null; // その版を生んだ変更リソース(別Attr)
}

/** 1試合の完全ドキュメント（output/G2026xxxx.json） */
export interface GameDoc {
  schema_version: "2.0";
  game: Game;
  additional_players?: AdditionalPlayer[]; // [廃止予定§9] participants に統合。移行後docは持たない
  participants?: Participant[]; // [§9] 出欠・additional_players を統合した試合の人リスト1本。移行後の正本(現状は attendance/additional_players が正本)
  lineup_snapshots: LineupSnapshot[];
  plate_appearances: PlateAppearance[];
  attendance?: AttendanceEntry[]; // [廃止予定§9] participants(在籍=出席)に統合。移行後docは持たない
  pitching?: PitchingRecord[]; // 投手別の記録員判断（自責点を明示）。省略時はruns[].earnedから集計
  run_overrides?: RunOverride[]; // [§10.6] 手動の責任投手上書き(記録値・人の明示)。runs[]のauto導出へread時に最優先で被せる
  direct_stats?: DirectStatLine[]; // [§0/§11] PA非依存の個人成績直接記録(断片試合)。additive・移行不要
}
