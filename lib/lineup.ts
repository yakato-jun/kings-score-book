/** 守備位置の表示・打順解決(lineup_snapshots から)。 */
import type { LineupSnapshot } from "./types/v2";

export const POS_ABBR: Record<string, string> = {
  "1": "投", "2": "捕", "3": "一", "4": "二", "5": "三",
  "6": "遊", "7": "左", "8": "中", "9": "右", DH: "指",
};

export interface LineupInfo {
  slot: number | null;   // 打順
  positions: string[];   // 守備位置ID(就いた順・重複なし)
  starter: boolean;      // 先発か
}

/** player_id → 打順/守備位置/先発 */
export function lineupInfo(snapshots: LineupSnapshot[]): Map<string, LineupInfo> {
  const info = new Map<string, LineupInfo>();
  const sorted = [...snapshots].sort((a, b) => a.seq - b.seq);
  const startIds = new Set((sorted[0]?.lineup ?? []).map((r) => r.player_id));
  for (const snap of sorted) {
    for (const r of snap.lineup) {
      if (!r.player_id) continue;
      let e = info.get(r.player_id);
      if (!e) {
        e = { slot: r.order, positions: [], starter: startIds.has(r.player_id) };
        info.set(r.player_id, e);
      }
      if (e.slot == null && r.order != null) e.slot = r.order;
      if (r.position_id && !e.positions.includes(r.position_id)) e.positions.push(r.position_id);
    }
  }
  return info;
}

/** 位置ラベル(例 "中/投")。先発は () 付き。 */
export function posLabel(info: LineupInfo | undefined): string {
  if (!info) return "";
  const label = info.positions.map((p) => POS_ABBR[p] ?? p).join("/");
  return info.starter ? `(${label})` : label;
}

const HIT_TYPE: Record<string, string> = { G: "ゴロ", F: "飛", L: "直" };

/** 打席結果の短いラベル(イニング別グリッド用)。例: 二ゴロ/中飛/左安/三振/四球。hit=安打 */
export function paResultLabel(pa: {
  result: string | null;
  complete?: boolean;
  intentional?: boolean;
  fielding?: { hit_to?: string | null; hit_type?: string | null } | null;
}): { text: string; hit: boolean } {
  if (pa.complete === false || pa.result === "INC" || !pa.result) return { text: "", hit: false };
  const pos = pa.fielding?.hit_to ? POS_ABBR[pa.fielding.hit_to] ?? "" : "";
  switch (pa.result) {
    case "HR": return { text: "本", hit: true };
    case "H1": return { text: `${pos}安`, hit: true };
    case "H2": return { text: `${pos}二`, hit: true };
    case "H3": return { text: `${pos}三`, hit: true };
    case "K": return { text: "三振", hit: false };
    case "BB": return { text: pa.intentional ? "敬遠" : "四球", hit: false };
    case "HBP": return { text: "死球", hit: false };
    case "SH": return { text: "犠打", hit: false };
    case "SF": return { text: "犠飛", hit: false };
    case "E": return { text: `${pos}失`, hit: false };
    case "FC": return { text: `${pos}ゴロ`, hit: false };
    case "OUT": {
      const ht = pa.fielding?.hit_type ? HIT_TYPE[pa.fielding.hit_type] ?? "" : "";
      return { text: pos || ht ? `${pos}${ht}` : "凡退", hit: false };
    }
    default: return { text: pa.result, hit: false };
  }
}
