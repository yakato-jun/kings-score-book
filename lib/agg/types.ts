/** 集計結果の型。各 line は「1選手・1試合」または「1選手・シーズン合計」。 */

export interface BattingLine {
  player_id: string;
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
  g: number;        // 登板試合数
  outs: number;     // 投球アウト数(IP*3)
  bf: number;       // 対打者
  h: number;        // 被安打
  hr: number;       // 被本塁打
  k: number;        // 奪三振
  bb: number;       // 与四球(申告敬遠含む)
  hbp: number;      // 与死球
  r: number;        // 失点
  er: number;       // 自責点
  wp: number;       // 暴投
}

export interface FieldingLine {
  player_id: string;
  g: number;
  po: number;       // 刺殺
  a: number;        // 捕殺
  e: number;        // 失策
  tc: number;       // 守備機会 = po+a+e
}

export interface AttendanceLine {
  player_id: string;
  scope: "own" | "guest";
  games: number;    // 参加試合数
  played: number;   // うち出場
  bench: number;    // うちベンチ参加
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
