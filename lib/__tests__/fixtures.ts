/**
 * テスト用ダミーデータのビルダ（完全に架空・機密の実データは使わない）。
 * 最小の GameDoc を組み立てて集計エンジンの各挙動を検証する。
 */
import type {
  GameDoc,
  LineupSnapshot,
  PlateAppearance,
  PositionId,
} from "../types/v2";

/** 標準ダミー守備配置: P1=遊6 P2=捕2 P3=左7 P4=二4 P5=三5 P6=一3 P7=中8 P8=右9 P9=指DH PP=投1 */
export const LINEUP: [number | null, string, string][] = [
  [1, "6", "P1"], [2, "2", "P2"], [3, "7", "P3"], [4, "4", "P4"],
  [5, "5", "P5"], [6, "3", "P6"], [7, "8", "P7"], [8, "9", "P8"],
  [9, "DH", "P9"], [null, "1", "PP"],
];

export function snap(
  lineup: [number | null, string, string][],
  over: Partial<LineupSnapshot> = {}
): LineupSnapshot {
  return {
    game_id: "GTEST",
    team: "N-KINGS",
    snapshot_id: "GTEST-NK-00",
    seq: 0,
    effective_from: { inning: 1, half: "top", before_order: null },
    roster: lineup.map(([, , pid]) => ({
      player_id: pid,
      fielding_team: "N-KINGS",
      status: "active",
      stat_scope: pid.startsWith("P") ? "own" : "guest",
      include_in_season: true,
    })),
    lineup: lineup.map(([order, pos, pid]) => ({
      order,
      position_id: pos as PositionId,
      player_id: pid,
      automatic_out: false,
    })),
    reason: "start",
    ...over,
  };
}

export function pa(over: Partial<PlateAppearance>): PlateAppearance {
  return {
    inning: 1,
    half: "top",
    order: 1,
    outs: 0,
    runners: { first: null, second: null, third: null },
    batter_id: "X",
    result: "OUT",
    complete: true,
    runs: [],
    baserunning_after: [],
    ...over,
  };
}

export function doc(
  over: Partial<GameDoc> & { home_away: "home" | "away" | null }
): GameDoc {
  return {
    schema_version: "2.0",
    game: {
      id: "GTEST",
      date: "2026-01-01",
      opponent: "Test",
      league: null,
      home_away: over.home_away,
      dh: false,
    },
    additional_players: [],
    lineup_snapshots: [snap(LINEUP)],
    plate_appearances: [],
    attendance: [],
    ...over,
  };
}

/** 守備テスト用: away(自軍守備=bottom) のPAを作る薄いラッパ */
export function defPA(over: Partial<PlateAppearance>): PlateAppearance {
  return pa({ half: "bottom", pitcher_id: "PP", catcher_id: "P2", batter_id: "O1", ...over });
}
