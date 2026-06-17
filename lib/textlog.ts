/** テキスト速報の生成ヘルパ。試合docから半イニング単位の経過を組む。 */
import type { GameDoc, PlateAppearance, Half, Runners } from "./types/v2";
import { outsMade } from "./agg";
import { paResultLabel } from "./lineup";

const OUTS = ["無死", "一死", "二死"];
export function outsLabel(o: number): string {
  return OUTS[o] ?? `${o}死`;
}

export function runnersLabel(r: Runners): string {
  const b: string[] = [];
  if (r.first) b.push("一");
  if (r.second) b.push("二");
  if (r.third) b.push("三");
  if (b.length === 0) return "走者なし";
  if (b.length === 3) return "満塁";
  return b.join("") + "塁";
}

/** 打席開始時の状況 例 "無死走者なし" "一死一二塁"。outs/runners は導出値を渡す。 */
export function situationLabel(outs: number, runners: Runners): string {
  return outsLabel(outs) + runnersLabel(runners);
}

/**
 * 打席結果の一文。アウトを伴えば累計アウトを付す(startOuts は導出した開始時アウト)。
 * note は表示用の実況に純化済み(システム用注記は pa.annotations[] に分離)。無ければ構造化ラベル。
 */
export function playLine(pa: PlateAppearance, startOuts: number): string {
  const note = (pa.note ?? "").trim() || paResultLabel(pa).text;
  const made = outsMade(pa);
  return made > 0 ? `${note} ${startOuts + made}アウト`.trim() : note;
}

const EVENT_LABEL: Record<string, string> = {
  SB: "盗塁", CS: "盗塁死", PB: "捕逸", WP: "暴投", BK: "ボーク", PO: "牽制",
};
const FROM_DESC: Record<string, string> = { "1": "一塁走者", "2": "二塁走者", "3": "三塁走者" };
const TO_PHRASE: Record<string, string> = { "1": "一塁へ", "2": "二塁へ", "3": "三塁へ", home: "生還", out: "アウト" };

/**
 * 打席中の走塁イベント(盗塁/暴投/捕逸/牽制/ボーク)を 1イベント=1行 の表示文にする。
 * 走者名は自軍のみ解決、相手は「一塁走者」等の塁表記にフォールバック(打者表記と同じ方針)。
 */
export function duringLines(pa: PlateAppearance, nameOf: (id: string) => string): string[] {
  const evs = pa.baserunning_during ?? [];
  return evs.map((ev) => {
    const runners = ev.runners ?? [];
    let label = EVENT_LABEL[ev.event] ?? ev.event;
    if (ev.event === "PO" && runners.some((r) => r.to === "out")) label = "牽制死";
    const moves = runners.map((r) => {
      const nm = nameOf(r.runner_id);
      const who = nm && nm !== r.runner_id ? nm : FROM_DESC[r.from ?? ""] ?? "走者";
      return `${who}が${TO_PHRASE[r.to] ?? r.to}`;
    });
    return moves.length ? `＜${label}＞ ${moves.join("、")}` : `＜${label}＞`;
  });
}

/**
 * 打者表記。自軍は「N番 名前」、相手は O番号から「N番」(名前があれば付す)。
 * batting_slot は 1回(order==slot)では省略されるため order をフォールバックに使う。
 */
export function batterLabel(pa: PlateAppearance, nameOf: (id: string) => string): string {
  const m = pa.batter_id.match(/^O0*(\d+)/);
  if (m) {
    const ord = `${m[1]}番`;
    const nm = nameOf(pa.batter_id);
    // 実名があれば「N番 名前」。名前が打順番号そのもの/未登録なら「N番」のみ
    return nm && nm !== pa.batter_id && nm !== ord ? `${ord} ${nm}` : ord;
  }
  const slot = pa.batting_slot ?? pa.order;
  return `${slot}番 ${nameOf(pa.batter_id)}`;
}

export function paAnchor(inning: number, half: string, order: number): string {
  return `pa-${inning}-${half}-${order}`;
}

const ANNO_PREFIX: Record<string, string> = { unclear: "要確認", manual: "補記", other: "メモ" };
/** システム注記(不明瞭/自動修復の記録)を表示用の行にする。unclear=要修正, repair/manual=補記。 */
export function annotationLines(pa: PlateAppearance): { kind: "unclear" | "note"; text: string }[] {
  return (pa.annotations ?? []).map((a) => ({
    kind: a.type === "unclear" ? "unclear" : "note",
    text: `${ANNO_PREFIX[a.type] ?? "メモ"}: ${a.detail}`,
  }));
}

const HIT = new Set(["H", "H1", "H2", "H3", "HR"]);

export interface HalfInning {
  inning: number;
  half: Half;
  kingsOffense: boolean; // 自軍の攻撃か
  pas: PlateAppearance[];
  runs: number;
  hits: number;
  walks: number; // 四死球
}

/** PAを半イニング単位にまとめ、得点/安打/四死球を集計して時系列で返す */
export function halfInnings(doc: GameDoc): HalfInning[] {
  const kingsBat: Half = doc.game.home_away === "away" ? "top" : "bottom";
  const map = new Map<string, HalfInning>();
  for (const pa of doc.plate_appearances ?? []) {
    const key = `${pa.inning}-${pa.half}`;
    let h = map.get(key);
    if (!h) {
      h = { inning: pa.inning, half: pa.half, kingsOffense: pa.half === kingsBat, pas: [], runs: 0, hits: 0, walks: 0 };
      map.set(key, h);
    }
    h.pas.push(pa);
    h.runs += pa.runs.length;
    if (HIT.has(pa.result ?? "")) h.hits += 1;
    if (pa.result === "BB" || pa.result === "HBP") h.walks += 1;
  }
  return [...map.values()].sort(
    (a, b) => a.inning - b.inning || (a.half === "top" ? 0 : 1) - (b.half === "top" ? 0 : 1)
  );
}
