/**
 * 試合の状態エンジン。plate_appearances から「現在どこか(回/表裏/アウト/走者/スコア)」と、
 * 新しい打席を置く half-inning を導出する。
 *
 * 方針(重要): 形式ルール(3アウトで自動チェンジ等)は埋め込まない=記録どおりに残す。
 *  - 攻撃側(half)は 明示 > 打者の所属(O…=相手 / 他=自軍) > 直前の打席と同じ、で決める。
 *  - 回は 明示 > 「同じ側を続けるなら直前と同じ回／側が替わったらその側の次の回」。
 *    つまり半イニングの区切りは『どちらが打っているか』で決まり、アウト数では切らない
 *    (草野球で4・5アウトや誤記が来てもそのまま記録できる)。
 */
import type { GameDoc, PlateAppearance, Half, Runners, BaserunMove, LineupEntry, ResultCode, RunEvent } from "@/lib/types/v2";
import { outsMade } from "@/lib/agg";

const EMPTY: Runners = { first: null, second: null, third: null };
const halfRank = (h: Half) => (h === "top" ? 0 : 1);

/** baserunning の移動を塁状態へ適用(冪等＝到達前にその走者を全塁から外すので二重置きしない) */
function applyMoves(r: Runners, moves: BaserunMove[]): Runners {
  const bases: Record<string, string | null> = { "1": r.first, "2": r.second, "3": r.third };
  for (const m of moves) {
    for (const b of ["1", "2", "3"]) if (bases[b] === m.runner_id) bases[b] = null; // 今いる塁を空ける(from非依存)
    if (m.to === "1" || m.to === "2" || m.to === "3") bases[m.to] = m.runner_id; // 到達塁へ
    // home / out は到達塁を埋めない(得点 or アウト)
  }
  return { first: bases["1"], second: bases["2"], third: bases["3"] };
}

/** 打者が到達する塁(結果から導出)。out/犠打/三振等は null。 */
function destForResult(result: ResultCode): "1" | "2" | "3" | "home" | null {
  switch (result) {
    case "H1": case "BB": case "HBP": case "E": case "FC": case "CI": return "1";
    case "H2": return "2";
    case "H3": return "3";
    case "HR": return "home";
    default: return null; // OUT/K/SH/SF/AUTO_OUT/INC/H/null
  }
}

/** 打者を一塁に置き、強制進塁の連鎖(満塁押し出し含む)を適用。3塁の押し出しは生還(塁から消える)。 */
function applyForce(r: Runners, batterId: string): Runners {
  let f = r.first, s = r.second, t = r.third;
  if (f) { // 一塁走者は押し出される
    if (s) { // 二塁走者も押し出される
      // 三塁走者がいれば本塁へ(生還＝塁から消える)
      t = s; // 旧二塁→三塁
    }
    s = f; // 旧一塁→二塁
  }
  f = batterId;
  return { first: f, second: s, third: t };
}

// 強制進塁が起きる結果(打者が一塁に出て、詰まっていれば前の走者を押し出す)
const FORCE = new Set<ResultCode>(["BB", "HBP", "H1", "E", "CI"]);

/**
 * 1打席後の塁状態を「結果」から導出する(=エンジンが構造を所有)。
 *  - 打者は結果に応じて塁へ(H1/BB/HBP/E/FC/CI→一塁, H2→二塁, H3→三塁, HR→生還)。
 *  - 四死球・単打・出塁系は強制進塁を自動(満塁押し出し含む)。四死球は強制のみ(明示afterは使わない)。
 *  - 非強制の進塁(安打での余分な進塁・盗塁(during)・エラー時の進塁)は明示分(after/during)を適用。
 * これにより「四球と書くだけで走者が正しく進む」。打者本人の出塁忘れで走者がズレることが無くなる。
 */
export function foldRunners(before: Runners, pa: PlateAppearance): Runners {
  let r = before;
  for (const ev of pa.baserunning_during ?? []) r = applyMoves(r, ev.runners ?? []); // 盗塁等(打席中)
  if (pa.result === "HR") return EMPTY; // 全員生還
  const dest = destForResult(pa.result);
  if (FORCE.has(pa.result)) r = applyForce(r, pa.batter_id);
  else if (dest === "2" || dest === "3") r = applyMoves(r, [{ runner_id: pa.batter_id, from: null, to: dest }]);
  else if (dest === "1") r = applyMoves(r, [{ runner_id: pa.batter_id, from: null, to: "1" }]); // FC(打者は一塁、走者除去はafterで)
  // 四死球は強制のみで完結。それ以外は明示の非強制進塁を反映。
  if (pa.result !== "BB" && pa.result !== "HBP") r = applyMoves(r, pa.baserunning_after ?? []);
  return r;
}

const chrono = (a: PlateAppearance, b: PlateAppearance) =>
  a.inning - b.inning || halfRank(a.half) - halfRank(b.half) || a.order - b.order;

/**
 * この打席で本塁に到達した走者(=得点者)を、開始時走者と結果から導出する。
 *  - HR: 塁上の走者＋打者が全員生還
 *  - 打席中イベント(during)で to:"home"
 *  - 四死球の満塁押し出し: 三塁走者が押し出されて生還
 *  - 打球での明示進塁(after)で to:"home"
 * これにより「誰が還ったか」をAIに正しく入れさせる必要が無くなる(得点者の取り違えを構造的に排除)。
 */
export function deriveScorers(before: Runners, pa: PlateAppearance): string[] {
  const out: string[] = [];
  if (pa.result === "HR") {
    for (const id of [before.third, before.second, before.first]) if (id) out.push(id);
    out.push(pa.batter_id);
    return [...new Set(out)];
  }
  let r = before;
  for (const ev of pa.baserunning_during ?? []) {
    for (const m of ev.runners ?? []) if (m.to === "home") out.push(m.runner_id);
    r = applyMoves(r, ev.runners ?? []);
  }
  if ((pa.result === "BB" || pa.result === "HBP") && r.first && r.second && r.third) out.push(r.third); // 満塁押し出し
  for (const m of pa.baserunning_after ?? []) if (m.to === "home") out.push(m.runner_id);
  return [...new Set(out)];
}

type Cause = RunEvent["cause"];
const causeFromEvent = (event: string): Cause => {
  const e = (event ?? "").toUpperCase();
  return e === "WP" ? "wp" : e === "PB" ? "pb" : e === "SB" ? "sb" : e === "BK" ? "bk" : "other";
};
const causeFromResult = (result: ResultCode): Cause => {
  switch (result) {
    case "H1": case "H2": case "H3": return "hit";
    case "HR": return "hr";
    case "E": return "error";
    case "SF": return "sf"; case "SH": return "sh"; case "FC": return "fc";
    case "OUT": return "groundout"; case "BB": return "walk"; case "HBP": return "hbp";
    default: return "other";
  }
};
const RBI_CAUSE = new Set<Cause>(["hit", "hr", "walk", "hbp", "sf", "sh", "fc", "groundout"]);

/**
 * この打席の runs[](得点の正本)を、開始時走者と結果から導出する。deriveScorers と同じ走査で
 * 「誰が・どの要因で還ったか」を出し、rbi/earned/cause まで決める＝AIは runs を出さない。
 *  - rbi: 打者の打撃/押し出しでの生還は true。エラー・暴投・捕逸・盗塁での生還は false。
 *  - earned: 近似(エラー要因のみ false)。正本は doc.pitching の明示値で上書きされる。
 */
export function deriveRuns(before: Runners, pa: PlateAppearance): RunEvent[] {
  const out: RunEvent[] = [];
  const seen = new Set<string>();
  const add = (runner_id: string, cause: Cause) => {
    if (!runner_id || seen.has(runner_id)) return;
    seen.add(runner_id);
    out.push({ runner_id, rbi: RBI_CAUSE.has(cause), earned: cause !== "error", cause });
  };
  if (pa.result === "HR") {
    for (const id of [before.third, before.second, before.first]) if (id) add(id, "hr");
    add(pa.batter_id, "hr");
    return out;
  }
  let r = before;
  for (const ev of pa.baserunning_during ?? []) {
    for (const m of ev.runners ?? []) if (m.to === "home") add(m.runner_id, causeFromEvent(ev.event));
    r = applyMoves(r, ev.runners ?? []);
  }
  if ((pa.result === "BB" || pa.result === "HBP") && r.first && r.second && r.third) add(r.third, pa.result === "BB" ? "walk" : "hbp");
  for (const m of pa.baserunning_after ?? []) if (m.to === "home") add(m.runner_id, causeFromResult(pa.result));
  return out;
}

const baseOccupant = (r: Runners, base?: string | null): string | null =>
  base === "1" ? r.first : base === "2" ? r.second : base === "3" ? r.third : null;

/**
 * 走塁(during/after)の runner_id を「from の塁に実在する走者」で確定する(=状態依存をエンジンが吸収)。
 * モデルは from/to の塁だけ言えばよく、誰かは盤面が決める → 走者取り違えが構造的に消え、バッチ/bulk でも崩れない。
 * 盤面は foldRunners と同順(during → 打者の強制進塁 → after)で進める。
 */
export function resolveBaserunningIds(start: Runners, pa: PlateAppearance): PlateAppearance {
  let r = start;
  // 得点(to:home)の走者は「開始時の走者を本塁に近い順」で割り当てる(打者は除く)。
  // 強制進塁で打者が前に出て盤面がずれても、生還者は元の走者から正しく選ぶ(打者を誤って得点にしない)。
  const queue = [start.third, start.second, start.first].filter((id): id is string => !!id && id !== pa.batter_id);
  const takeScorer = (from?: string | null): string | null => {
    const at = baseOccupant(start, from);
    if (at) { // from が示す開始塁の走者(打者本人＝内野安打等で本塁まで、はそのまま)
      const i = queue.indexOf(at);
      if (i >= 0) queue.splice(i, 1);
      return at;
    }
    return queue.length ? queue.shift()! : null; // from不明なら本塁に近い走者から
  };
  // 「バッターランナー」等の打者参照は打者IDに解決(モデルが batter/打者走者 と書いてもよい)
  const batterRef = (v?: string | null) => !!v && /^(batter|打者|打者走者|バッターランナー|b)$/i.test(v);
  const fix = (m: BaserunMove): BaserunMove => {
    const from = batterRef(m.from) ? null : m.from;
    const id = batterRef(m.from) || batterRef(m.runner_id) ? pa.batter_id
      : m.to === "home" ? (takeScorer(from) ?? m.runner_id)
      : (baseOccupant(r, from) ?? m.runner_id);
    const fixed = { ...m, from, runner_id: id };
    r = applyMoves(r, [fixed]);
    return fixed;
  };
  const during = (pa.baserunning_during ?? []).map((ev) => ({ ...ev, runners: (ev.runners ?? []).map(fix) }));
  if (pa.result === "HR") r = EMPTY;
  else if (FORCE.has(pa.result)) r = applyForce(r, pa.batter_id);
  else {
    const dest = destForResult(pa.result);
    if (dest && dest !== "home") r = applyMoves(r, [{ runner_id: pa.batter_id, from: null, to: dest }]);
  }
  const after = (pa.baserunning_after ?? []).map(fix);
  return { ...pa, baserunning_during: during, baserunning_after: after };
}

/** 指定打席の開始時走者(その half-inning の order 未満を畳む)。編集時の得点者補正に使う。 */
export function startRunnersBefore(doc: GameDoc, inning: number, half: Half, order: number): Runners {
  let r: Runners = EMPTY;
  for (const pa of pasInHalf(doc, inning, half)) {
    if (pa.order >= order) break;
    r = foldRunners(r, pa);
  }
  return r;
}

/** 自軍が攻撃する half (away=先攻=top, home=後攻=bottom)。home_away不明は top 扱い。 */
export function kingsBatHalf(doc: GameDoc): Half {
  return doc.game.home_away === "home" ? "bottom" : "top";
}

/** 相手が攻撃する half (自軍の逆) */
export function oppBatHalf(doc: GameDoc): Half {
  return kingsBatHalf(doc) === "top" ? "bottom" : "top";
}

/** 打者IDから攻撃側を判定(O…=相手) */
function sideHalf(doc: GameDoc, batterId: string): Half {
  return /^O\d/i.test(batterId) ? oppBatHalf(doc) : kingsBatHalf(doc);
}

/** 先発(seq0)の打順スロット(order!=null)を昇順で */
export function lineupSlots(doc: GameDoc): LineupEntry[] {
  const start = [...(doc.lineup_snapshots ?? [])].sort((a, b) => a.seq - b.seq)[0];
  return [...(start?.lineup ?? [])].filter((e) => e.order != null).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** 指定 half-inning の既存打席(order昇順) */
function pasInHalf(doc: GameDoc, inning: number, half: Half): PlateAppearance[] {
  return doc.plate_appearances.filter((p) => p.inning === inning && p.half === half).sort((a, b) => a.order - b.order);
}

/** chrono 最後の打席(無ければ null) */
function lastPA(doc: GameDoc): PlateAppearance | null {
  const pas = [...doc.plate_appearances].sort(chrono);
  return pas.length ? pas[pas.length - 1] : null;
}

export interface PATarget { inning: number; half: Half; }

/**
 * 追加する打席を「どの half-inning に置くか」を決める(=サーバが構造を所有。ただし形式ルールは課さない)。
 *  - half: 明示 > 打者所属 > 直前の打席と同じ > top
 *  - 回: 明示 > 直前と同じ側なら直前の回(継続) / 側が替わったらその側の最大回+1
 *    (アウト数では切らない。側の交代＝別の半イニング)
 */
export function resolvePATarget(doc: GameDoc, opts: { inning?: number; half?: Half; batter_id?: string }): PATarget {
  const last = lastPA(doc);
  let half = opts.half ?? (opts.batter_id ? sideHalf(doc, opts.batter_id) : undefined) ?? last?.half ?? "top";
  if (opts.inning && opts.inning > 0) return { inning: opts.inning, half };
  if (last && last.half === half) return { inning: last.inning, half }; // 同じ側を継続＝同じ半イニング
  const maxForHalf = doc.plate_appearances.filter((p) => p.half === half).reduce((m, p) => Math.max(m, p.inning), 0);
  return { inning: maxForHalf + 1, half }; // 側が替わった＝その側の次の回
}

export interface NextPA {
  order: number;
  outs: number;
  runners: Runners;
  batting_slot: number | null;
  batter_id: string | null; // 自動推定(自軍=打順, 相手=O番号)。指定があれば呼び出し側で上書き
}

/** (inning, half) に次の打席を足すときの構造フィールドを導出(アウトは無上限で積む) */
export function deriveNextPA(doc: GameDoc, inning: number, half: Half): NextPA {
  const here = pasInHalf(doc, inning, half);
  let outs = 0;
  let runners: Runners = EMPTY;
  for (const pa of here) {
    outs += outsMade(pa);
    runners = foldRunners(runners, pa);
  }
  const order = here.length + 1;

  if (half === kingsBatHalf(doc)) {
    const slots = lineupSlots(doc);
    const total = doc.plate_appearances.filter((p) => p.half === half).length; // これまでの自軍打席数
    const slot = slots.length ? slots[total % slots.length] : null;
    return { order, outs, runners, batting_slot: slot?.order ?? null, batter_id: slot?.player_id ?? null };
  }
  // 相手の攻撃: O001.. を打順順(9人想定)で
  const totalOpp = doc.plate_appearances.filter((p) => p.half !== kingsBatHalf(doc)).length;
  const pos = (totalOpp % 9) + 1;
  return { order, outs, runners, batting_slot: null, batter_id: `O${String(pos).padStart(3, "0")}` };
}

export interface PADerived { outs: number; runners: Runners; order: number }

/**
 * 全打席の「開始時アウト・走者・order」を導出する(=表示は保存値でなくこれを使う)。
 * 半イニングごとに時系列で畳むので、結果から走者を導く新ロジックがそのまま反映される
 * (保存済みの壊れた runners/outs を使わない＝過去データも自動で正しくなる)。
 */
export function derivePAStates(doc: GameDoc): Map<PlateAppearance, PADerived> {
  const out = new Map<PlateAppearance, PADerived>();
  const byHalf = new Map<string, PlateAppearance[]>();
  for (const pa of doc.plate_appearances) {
    const k = `${pa.inning}-${pa.half}`;
    (byHalf.get(k) ?? byHalf.set(k, []).get(k)!).push(pa);
  }
  for (const list of byHalf.values()) {
    const ordered = [...list].sort((a, b) => a.order - b.order);
    let runners: Runners = EMPTY;
    ordered.forEach((pa, i) => {
      // 走者は結果から導出(保存値を使わない＝過去の壊れ走者も直る)。アウトは保存値が正(outsMadeは併殺等を取りこぼす)。
      out.set(pa, { outs: pa.outs, runners, order: i + 1 });
      runners = foldRunners(runners, pa);
    });
  }
  return out;
}

export interface GameStateSummary {
  inning: number;
  half: Half;
  outs: number;
  runners: Runners;
  kings_score: number;
  opp_score: number;
  pa_count: number;
}

/** いまの位置(=最後に入力した半イニング)とスコア。形式ルールで先送りしない(アウトはそのまま)。 */
export function gameState(doc: GameDoc): GameStateSummary {
  const pas = [...doc.plate_appearances].sort(chrono);
  const kb = kingsBatHalf(doc);
  let kings = 0;
  let opp = 0;
  for (const pa of pas) {
    const n = pa.runs?.length ?? 0;
    if (pa.half === kb) kings += n; else opp += n;
  }
  if (pas.length === 0) {
    return { inning: 1, half: "top", outs: 0, runners: EMPTY, kings_score: kings, opp_score: opp, pa_count: 0 };
  }
  const last = pas[pas.length - 1];
  const here = pasInHalf(doc, last.inning, last.half);
  let outs = 0;
  let runners: Runners = EMPTY;
  for (const pa of here) {
    outs += outsMade(pa);
    runners = foldRunners(runners, pa);
  }
  return { inning: last.inning, half: last.half, outs, runners, kings_score: kings, opp_score: opp, pa_count: pas.length };
}
