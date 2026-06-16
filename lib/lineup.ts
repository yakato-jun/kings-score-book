/** 守備位置の表示・打順解決(lineup_snapshots から)。 */
import type { LineupSnapshot, PlateAppearance, Half } from "./types/v2";

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

export type Role = "starter" | "pitcher" | "pinch_hitter" | "pinch_runner" | "sub";

export interface LineupRow {
  player_id: string;
  slot: number | null; // 打順(null=DH制の投手など打順なし)
  slotSeq: number;     // その打順に入ったsnapshot seq(チェーン並び用)
  positions: string[]; // 就いた守備位置ID(順・重複なし)
  role: Role;
}

/**
 * 表示用の完全ラインアップを打順→交代チェーン順で返す。
 * - 各打順1-9をスナップショット順の交代チェーンで列挙
 * - DH制の投手(打順null)は末尾(=最終打者の下)。DH解除で打順に入った投手はその打順の位置(=指名打者の下)
 * - role: starter/pitcher/pinch_hitter(代打)/pinch_runner(代走)/sub(守備交代)
 */
export function displayLineup(
  snapshots: LineupSnapshot[],
  pinchRunners: Set<string>,
  batted: Set<string>
): LineupRow[] {
  const sorted = [...snapshots].sort((a, b) => a.seq - b.seq);
  const start = sorted[0];
  const startOrder = new Map<string, number | null>(
    (start?.lineup ?? []).map((r) => [r.player_id, r.order])
  );
  const info = new Map<string, LineupRow>();
  for (const snap of sorted) {
    for (const r of snap.lineup) {
      if (!r.player_id) continue;
      let e = info.get(r.player_id);
      if (!e) {
        e = { player_id: r.player_id, slot: r.order, slotSeq: r.order != null ? snap.seq : Infinity, positions: [], role: "sub" };
        info.set(r.player_id, e);
      }
      if (e.slot == null && r.order != null) { e.slot = r.order; e.slotSeq = snap.seq; }
      if (r.position_id && !e.positions.includes(r.position_id)) e.positions.push(r.position_id);
    }
  }
  for (const e of info.values()) {
    if (startOrder.has(e.player_id)) {
      e.role = startOrder.get(e.player_id) == null ? "pitcher" : "starter";
    } else if (pinchRunners.has(e.player_id)) {
      e.role = "pinch_runner";
    } else if (batted.has(e.player_id)) {
      e.role = "pinch_hitter"; // 代打(出場後に打席あり)
    } else {
      e.role = "sub"; // 守備交代(打席なし)
    }
  }
  return [...info.values()].sort((a, b) => {
    const sa = a.slot ?? 99, sb = b.slot ?? 99;
    return sa !== sb ? sa - sb : a.slotSeq - b.slotSeq;
  });
}

/** 役割つき位置ラベル。先発()、投手は位置そのまま、代打=打、代走=走 を前置 */
export function roleLabel(row: LineupRow | undefined): string {
  if (!row) return "";
  const pos = row.positions.map((p) => POS_ABBR[p] ?? p).filter(Boolean).join("/");
  switch (row.role) {
    case "starter": return `(${pos})`;
    case "pitcher": return pos || "投";
    case "pinch_hitter": return pos ? `打/${pos}` : "打";
    case "pinch_runner": return pos ? `走/${pos}` : "走";
    default: return pos;
  }
}

export interface GridCell { text: string; hit: boolean; rbi: boolean; }

/**
 * イニング別打席結果グリッド: batter_id → inning → セル[]。
 * batter_id と inning でキーするので打順入れ替え(順序)に非依存。
 * batHalf は自軍が攻撃する half。
 */
export function battingGrid(
  pas: PlateAppearance[],
  batHalf: Half
): Map<string, Map<number, GridCell[]>> {
  const grid = new Map<string, Map<number, GridCell[]>>();
  for (const pa of pas) {
    if (pa.half !== batHalf) continue;
    const lab = paResultLabel(pa);
    if (!lab.text) continue;
    const bi = grid.get(pa.batter_id) ?? new Map<number, GridCell[]>();
    bi.set(pa.inning, [...(bi.get(pa.inning) ?? []), lab]);
    grid.set(pa.batter_id, bi);
  }
  return grid;
}

const HIT_TYPE: Record<string, string> = { G: "ゴロ", F: "飛", L: "直" };

/** 打席結果の短いラベル(イニング別グリッド用)。例: 二ゴロ/中飛/左安/三振/四球。hit=安打, rbi=打点あり */
export function paResultLabel(pa: {
  result: string | null;
  complete?: boolean;
  intentional?: boolean;
  runs?: { rbi: boolean }[];
  fielding?: { hit_to?: string | null; hit_type?: string | null } | null;
}): { text: string; hit: boolean; rbi: boolean } {
  const rbi = (pa.runs ?? []).some((r) => r.rbi);
  if (pa.complete === false || pa.result === "INC" || !pa.result) return { text: "", hit: false, rbi: false };
  const pos = pa.fielding?.hit_to ? POS_ABBR[pa.fielding.hit_to] ?? "" : "";
  // 構造化フィールド(hit_to/hit_type)のみを読む。方向が無ければフル語へ救済(noteは見ない)。
  const base: { text: string; hit: boolean } = (() => {
    switch (pa.result) {
      case "HR": return { text: pos ? `${pos}本` : "本塁打", hit: true };
      case "H1": return { text: pos ? `${pos}安` : "安打", hit: true };
      case "H2": return { text: pos ? `${pos}二` : "二塁打", hit: true };
      case "H3": return { text: pos ? `${pos}三` : "三塁打", hit: true };
      case "K": return { text: "三振", hit: false };
      case "BB": return { text: pa.intentional ? "敬遠" : "四球", hit: false };
      case "HBP": return { text: "死球", hit: false };
      case "SH": return { text: "犠打", hit: false };
      case "SF": return { text: "犠飛", hit: false };
      case "E": return { text: pos ? `${pos}失` : "失策", hit: false };
      case "FC": return { text: pos ? `${pos}ゴロ` : "野選", hit: false };
      case "OUT": {
        const ht = pa.fielding?.hit_type ? HIT_TYPE[pa.fielding.hit_type] ?? "" : "";
        return { text: pos && ht ? `${pos}${ht}` : ht || "凡打", hit: false };
      }
      default: return { text: pa.result ?? "", hit: false };
    }
  })();
  return { ...base, rbi };
}
