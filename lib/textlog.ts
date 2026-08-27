/** テキスト速報の生成ヘルパ。試合docから半イニング単位の経過を組む。 */
import type { GameDoc, PlateAppearance, Half, Runners, LineupSnapshot } from "./types/v2";
import { outsMade } from "./agg";
import { paResultLabel, POS_ABBR } from "./lineup";
import { unresolvedUnclear } from "./ops/validate";
import { derivePAStates } from "./ops/gamestate";

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
    if (ev.event === "PO") {
      // 牽制(PO): 走者アウト=牽制死 / 走者が進塁=牽制悪送球(送球が逸れて進塁) / どちらでもなければ牽制。
      //   「牽制で進塁」は牽制悪送球なので「牽制」とは表示しない(意味不明の回避)。
      if (runners.some((r) => r.to === "out")) label = "牽制死";
      else if (runners.some((r) => r.to === "1" || r.to === "2" || r.to === "3" || r.to === "home")) label = "牽制悪送球";
    }
    const moves = runners.map((r) => {
      const nm = nameOf(r.runner_id);
      const who = nm && nm !== r.runner_id ? nm : FROM_DESC[r.from ?? ""] ?? "走者";
      return `${who}が${TO_PHRASE[r.to] ?? r.to}`;
    });
    return moves.length ? `＜${label}＞ ${moves.join("、")}` : `＜${label}＞`;
  });
}

/**
 * 打者表記。自軍は「N番 名前」、相手は opponent_slot(§9: 相手打順の第一級)から「N番」。
 * batting_slot は 1回(order==slot)では省略されるため order をフォールバックに使う。
 * 旧形式(移行前doc)の O番号は救済として読む。
 */
export function batterLabel(pa: PlateAppearance, nameOf: (id: string) => string): string {
  if (pa.opponent_slot != null) return `${pa.opponent_slot}番`; // 相手=打順位置のみ(身元非追跡)
  if (pa.batter_id == null) return `${pa.batting_slot ?? pa.order}番 (不明)`; // 打者不明(省略可の規約)でも表示は落ちない
  const m = pa.batter_id.match(/^O0*(\d+)/); // 旧形式の救済
  if (m) {
    const ord = `${m[1]}番`;
    const nm = nameOf(pa.batter_id);
    return nm && nm !== pa.batter_id && nm !== ord ? `${ord} ${nm}` : ord;
  }
  const slot = pa.batting_slot ?? pa.order;
  return `${slot}番 ${nameOf(pa.batter_id)}`;
}

/**
 * [表示] 連続するスナップショットの差分を「選手交代・守備変更」の1行テキストにする(差が無ければ null)。
 * 出場(前に居ない)/退く(後に居ない)/位置変更(position_id差)を人向けに列挙。ラベルは差分の種類から導出。
 */
export function lineupChangeLine(prev: LineupSnapshot, cur: LineupSnapshot, nameOf: (id: string) => string): string | null {
  const pos = (p?: string | null) => (p ? POS_ABBR[p] ?? p : "－");
  const before = new Map(prev.lineup.map((e) => [e.player_id, e]));
  const after = new Map(cur.lineup.map((e) => [e.player_id, e]));
  const parts: string[] = [];
  let subbed = false;
  let moved = false;
  for (const [id, e] of after) {
    const old = before.get(id);
    if (!old) { subbed = true; parts.push(`${nameOf(id)}（交代出場・${pos(e.position_id)}）`); }
    else if ((old.position_id ?? null) !== (e.position_id ?? null)) { moved = true; parts.push(`${nameOf(id)}（${pos(old.position_id)}→${pos(e.position_id)}）`); }
  }
  for (const [id] of before) if (!after.has(id)) { subbed = true; parts.push(`${nameOf(id)}（退く）`); }
  if (parts.length === 0) return null;
  const label = subbed && moved ? "選手交代・守備変更" : subbed ? "選手交代" : "守備変更";
  return `${label}: ${parts.join("、")}`;
}

export function paAnchor(inning: number, half: string, order: number): string {
  return `pa-${inning}-${half}-${order}`;
}

const ANNO_PREFIX: Record<string, string> = { unclear: "要確認", resolved: "承認済み", manual: "補記", other: "メモ" };
/** システム注記を表示用の行にする。承認済み(rule単位/AI打席単位)の要確認は隠し「承認済み」を出す。rule は承認ボタン用に返す。 */
export function annotationLines(pa: PlateAppearance): { kind: "unclear" | "note"; text: string; rule: string | null }[] {
  const ann = pa.annotations ?? [];
  const unresolved = new Set(unresolvedUnclear(pa)); // 未解決のunclearだけ要確認表示
  return ann
    .filter((a) => a.type !== "unclear" || unresolved.has(a)) // 解決済みのunclearは隠す
    .map((a) => ({
      kind: a.type === "unclear" ? ("unclear" as const) : ("note" as const),
      text: `${ANNO_PREFIX[a.type] ?? "メモ"}: ${a.detail}`,
      rule: a.rule ?? null,
    }));
}

/**
 * 版の差分グラウンディング用: doc のプレーバイプレーを1本のテキストに組む(revertでAIに渡す材料)。
 * §9: 打者/走者は nameOf で名前表記(参加者IDは不透明でAIの辞書に無いため。AIは名前→マスタID→参加者に解決される)。
 * 開始時アウトは導出値を使い、打球(playLine)・走塁(duringLines)まで含めて
 * 「一飛 vs 左飛」等の差も表現できるようにする＝結果コードだけのダイジェストより情報落ちが少ない。
 */
export function renderPlayByPlay(doc: GameDoc, nameOf: (id: string) => string = (id) => id): string {
  const states = derivePAStates(doc);
  const lines: string[] = [];
  for (const h of halfInnings(doc)) {
    lines.push(`${h.inning}回${h.half === "top" ? "表" : "裏"}`);
    for (const pa of h.pas) {
      const st = states.get(pa) ?? { outs: pa.outs ?? 0, order: pa.order };
      const during = duringLines(pa, nameOf).map((d) => ` / ${d}`).join("");
      lines.push(`  #${st.order} ${batterLabel(pa, nameOf)}: ${playLine(pa, st.outs)}${during}`);
    }
  }
  return lines.join("\n") || "（記録なし）";
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
