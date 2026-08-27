/** 集計結果の型。各 line は「1選手・1試合」または「1選手・シーズン合計」。 */

export interface BattingLine {
  player_id: string;
  // [§12 P5 legacy・撤去しない] own/guest 区分は game_history 過去版の旧guest link集計に必要(現公開版は roster 一本)。
  //   以下 PitchingLine/FieldingLine/AttendanceLine の scope も同じ理由で残す。
  scope: "own" | "guest";
  g: number;        // 出場(打席のあった)試合数
  pa: number;       // 打席
  ab: number;       // 打数
  r: number;        // 得点
  h: number;        // 安打
  b1: number;       // 単打
  b2: number;       // 二塁打
  b3: number;       // 三塁打
  hr: number;       // 本塁打
  rbi: number;      // 打点
  bb: number;       // 四球(申告敬遠含む)
  hbp: number;      // 死球
  k: number;        // 三振
  sh: number;       // 犠打
  sf: number;       // 犠飛
  sb: number;       // 盗塁
}

export interface PitchingLine {
  player_id: string;
  scope: "own" | "guest";
  g: number;        // 登板試合数
  outs: number;     // 投球アウト数(IP*3)
  bf: number;       // 対打者
  h: number;        // 被安打
  hr: number;       // 被本塁打
  k: number;        // 奪三振
  bb: number;       // 与四球(申告敬遠含む)
  hbp: number;      // 与死球
  r: number;        // 失点
  er: number | null; // 自責点。[クラスタA] null=不明(人未明示 かつ 導出でも決められない＝r>0だが自責判定不能=走者不明得点/純断片)
  wp: number;       // 暴投
}

export interface FieldingLine {
  player_id: string;
  scope: "own" | "guest";
  g: number;
  po: number;       // 刺殺
  a: number;        // 捕殺
  e: number;        // 失策
  tc: number;       // 守備機会 = po+a+e
}

export interface AttendanceLine {
  player_id: string;
  scope: "own" | "guest";
  games: number;    // 出席試合数(participants在籍=出席)。played/benchの区別は廃止(出場は成績有無から導出)
}

export interface GameBox {
  game_id: string;
  date: string;
  batting: BattingLine[];
  pitching: PitchingLine[];
  fielding: FieldingLine[];
}

export interface SeasonBox {
  games: number;
  batting: BattingLine[];
  pitching: PitchingLine[];
  fielding: FieldingLine[];
  attendance: AttendanceLine[];
}

/** 投球回を X.Y 形式(Y=1/3単位)の数値にする。15→5, 16→5.1, 17→5.2 */
export function ipFromOuts(outs: number): number {
  return Math.floor(outs / 3) + (outs % 3) / 10;
}

/** 表示用: 投球回 "5.2" 形式の文字列 */
export function ipStr(outs: number): string {
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}
/** .333 形式（先頭0を落とす） */
export function rate3(x: number): string {
  return x.toFixed(3).replace(/^0(?=\.)/, "");
}
export function avg(b: BattingLine): number {
  return b.ab ? b.h / b.ab : 0;
}
export function obp(b: BattingLine): number {
  const d = b.ab + b.bb + b.hbp + b.sf;
  return d ? (b.h + b.bb + b.hbp) / d : 0;
}
export function slg(b: BattingLine): number {
  const tb = b.b1 + 2 * b.b2 + 3 * b.b3 + 4 * b.hr;
  return b.ab ? tb / b.ab : 0;
}
export function ops(b: BattingLine): number {
  return obp(b) + slg(b);
}
/** 防御率（9イニング換算 = 自責*27/アウト数）。[クラスタA] er=不明(null) または アウト0 は null を返す＝表示側で「—」。 */
export function era(p: PitchingLine): number | null {
  if (p.er == null || !p.outs) return null;
  return (p.er * 27) / p.outs;
}

/**
 * [クラスタA] 自責点(er)の最終決定。null=不明。
 *  - override(doc.pitching.earned_runs 明示)があれば正本＝そのまま(絶対に上書きしない)。
 *  - 不明な寄与(earned=null の得点 / 断片で r>0 だが er 未記録)が1つでもあれば er=null(不明)。
 *  - それ以外は確定した自責の合算(known)。r=0 も known=0 で 0(自明clear)。
 */
export function resolveEr(known: number, hasUnknown: boolean, override?: number): number | null {
  if (override !== undefined) return override;
  return hasUnknown ? null : known;
}
/** 守備率 = (刺殺+捕殺)/(刺殺+捕殺+失策) */
export function fpct(f: FieldingLine): number {
  const c = f.po + f.a + f.e;
  return c ? (f.po + f.a) / c : 0;
}
