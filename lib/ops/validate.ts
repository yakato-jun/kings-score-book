/**
 * ルールベース事後バリデータ。導出した盤面に対して不変条件を検査し、破れた打席に
 * annotations[{type:"unclear", source:"validator"}] を付ける(=編集シードで浮上→修正へ)。
 *
 * 方針: ブロックしない(形式ルールで弾かない)。タグ付けのみ。冪等(再検査でvalidator起源を置換)。
 * ハードな矛盾のみ: (R1)得点数と盤面導出の生還者数の不一致、(R2)未登録の選手ID、
 * (R3)走者保存則の破れ＝塁上の走者が「アウトでも得点でもなく」盤面から消える取りこぼし。
 */
import type { GameDoc, Half, PlateAppearance, RunEvent } from "@/lib/types/v2";
import { derivePAStates, deriveScorers, foldRunners } from "./gamestate";

const rank = (h: Half) => (h === "top" ? 0 : 1);
const FORCE_RESULT = new Set(["BB", "HBP", "H1", "E", "CI"]);

export interface GameFlag { inning: number; half: Half; order: number; detail: string }

const BASE_JP = { first: "一塁", second: "二塁", third: "三塁" } as const;

/** この打席でアウトとして記録された走者ID(打者自身含む)。走者保存則の検査に使う。 */
function outRunnerIds(pa: PlateAppearance): Set<string> {
  const s = new Set<string>();
  const add = (id?: string | null) => { if (id) s.add(id); };
  for (const o of pa.fielding?.outs ?? []) add(o.runner_id);
  for (const ev of pa.baserunning_during ?? []) {
    for (const m of ev.runners ?? []) if (m.to === "out") add(m.runner_id);
    for (const o of ev.fielding?.outs ?? []) add(o.runner_id);
  }
  for (const m of pa.baserunning_after ?? []) if (m.to === "out") add(m.runner_id);
  return s;
}

function knownIds(doc: GameDoc): Set<string> {
  const s = new Set<string>();
  for (const snap of doc.lineup_snapshots ?? []) {
    for (const r of snap.roster ?? []) if (r.player_id) s.add(r.player_id);
    for (const l of snap.lineup ?? []) if (l.player_id) s.add(l.player_id);
  }
  for (const a of doc.additional_players ?? []) s.add(a.id);
  return s;
}

export function validateGame(doc: GameDoc): GameFlag[] {
  const flags: GameFlag[] = [];
  const states = derivePAStates(doc);
  const known = knownIds(doc);
  for (const pa of doc.plate_appearances) {
    const at = { inning: pa.inning, half: pa.half, order: pa.order };
    const start = states.get(pa)?.runners ?? { first: null, second: null, third: null };
    // R1: 得点数 と 盤面から導いた生還者数 の不一致(押し出し漏れ・余分な得点・得点者矛盾を捕捉)
    const scorers = deriveScorers(start, pa);
    const runCount = pa.runs?.length ?? 0;
    if (runCount !== scorers.length) {
      flags.push({ ...at, detail: `得点数(${runCount})が盤面から導いた生還者数(${scorers.length})と一致しません` });
    }
    // R3: 走者保存則。開始時に塁上の走者は、この打席後 (a)塁上に残る (b)生還 (c)アウト のいずれか
    //   でなければ消えない。どれにも該当せず盤面から消える=FCの押し出し走者の記録漏れ等の取りこぼし。
    //   代走置換(pinch_runner)は盤面に未モデルなので対象外(誤検知回避)。
    if (!pa.pinch_runner) {
      const after = foldRunners(start, pa);
      const onBase = new Set([after.first, after.second, after.third].filter(Boolean) as string[]);
      const scored = new Set(scorers);
      const out = outRunnerIds(pa);
      for (const base of ["first", "second", "third"] as const) {
        const id = start[base];
        if (!id || onBase.has(id) || scored.has(id) || out.has(id)) continue;
        flags.push({ ...at, detail: `${BASE_JP[base]}走者が消えました（塁上・得点・アウトのいずれにも記録がありません）` });
      }
    }
    // R2: 未登録の選手ID(GUEST:名前 の取りこぼし等)。相手(O...)は対象外。
    const ids = [
      pa.batter_id,
      ...(pa.runs ?? []).map((r) => r.runner_id),
      ...(pa.baserunning_after ?? []).map((m) => m.runner_id),
      ...(pa.baserunning_during ?? []).flatMap((e) => (e.runners ?? []).map((m) => m.runner_id)),
    ];
    const bad = ids.find((id) => id && !known.has(id) && !/^O\d/i.test(id));
    if (bad) flags.push({ ...at, detail: `未登録の選手ID「${bad}」が含まれています` });
  }

  // R4: グローバル得点アンカー。申告スコア(game.result)があるとき導出総得点と突合する。
  //   局所ルール(R1/R3)が見逃す『内部的に辻褄の合った得点の取りこぼし/重複』を総和で捕まえる。
  //   試合全体の話なので、該当halfの最後の打席に付ける(テキストスコアでその回末へ飛べる)。
  const res = doc.game.result;
  const ha = doc.game.home_away;
  const ownHalf: Half | null = ha === "away" ? "top" : ha === "home" ? "bottom" : null;
  if (res && ownHalf) {
    const oppHalf: Half = ownHalf === "top" ? "bottom" : "top";
    let own = 0, opp = 0;
    for (const pa of doc.plate_appearances) {
      const n = pa.runs?.length ?? 0;
      if (pa.half === ownHalf) own += n; else opp += n;
    }
    const rank = (h: Half) => (h === "top" ? 0 : 1);
    const chrono = (a: PlateAppearance, b: PlateAppearance) => a.inning - b.inning || rank(a.half) - rank(b.half) || a.order - b.order;
    const lastAll = [...doc.plate_appearances].sort(chrono).at(-1);
    // 該当halfの最後の打席に付ける(無ければ試合末尾の打席=非ゼロ申告で打席ゼロでも握り潰さない)
    const anchor = (h: Half) => [...doc.plate_appearances].filter((p) => p.half === h).sort(chrono).at(-1) ?? lastAll;
    if (own !== res.our_score) {
      const p = anchor(ownHalf);
      if (p) flags.push({ inning: p.inning, half: p.half, order: p.order, detail: `自軍の総得点(導出${own})が申告スコア(${res.our_score})と一致しません（どこかで得点の取りこぼし/重複）` });
    }
    if (opp !== res.their_score) {
      const p = anchor(oppHalf);
      if (p) flags.push({ inning: p.inning, half: p.half, order: p.order, detail: `相手の総得点(導出${opp})が申告スコア(${res.their_score})と一致しません` });
    }
  }
  return flags;
}

/**
 * 決定的に直せる不整合だけ自動修復する(=検証だけでなく修復)。今は「強制走者の生還の取りこぼし」一本。
 * 条件(3つ揃った時だけ＝保守的): R4で当該halfの総得点が申告に不足、かつ FORCE結果で満塁、かつ
 * 三塁走者がR3で消えている(得点でもアウトでもなく盤面から消えた)→ その走者は押し出されて生還、と確定できる。
 * 不足の数だけ時系列で補完し、修復した打席には注記を残す(後から人が見直せる)。曖昧な不足には手を出さない。
 */
export function repairGame(doc: GameDoc): GameDoc {
  const res = doc.game.result;
  const ha = doc.game.home_away;
  const ownHalf: Half | null = ha === "away" ? "top" : ha === "home" ? "bottom" : null;
  if (!res || !ownHalf) return doc;
  const oppHalf: Half = ownHalf === "top" ? "bottom" : "top";
  const derived = (h: Half) => doc.plate_appearances.filter((p) => p.half === h).reduce((s, p) => s + (p.runs?.length ?? 0), 0);
  const short: Record<Half, number> = { top: 0, bottom: 0 };
  short[ownHalf] = res.our_score - derived(ownHalf);
  short[oppHalf] = res.their_score - derived(oppHalf);
  if (short.top <= 0 && short.bottom <= 0) return doc;

  const states = derivePAStates(doc);
  const chrono = (a: PlateAppearance, b: PlateAppearance) => a.inning - b.inning || rank(a.half) - rank(b.half) || a.order - b.order;
  const add = new Map<PlateAppearance, RunEvent>();
  for (const pa of [...doc.plate_appearances].sort(chrono)) {
    if (short[pa.half] <= 0 || !FORCE_RESULT.has(pa.result ?? "")) continue;
    const start = states.get(pa)?.runners;
    if (!start?.first || !start.second || !start.third) continue; // 満塁のみ
    const third = start.third;
    const after = foldRunners(start, pa);
    const onBase = new Set([after.first, after.second, after.third].filter(Boolean) as string[]);
    const scored = new Set((pa.runs ?? []).map((r) => r.runner_id));
    if (onBase.has(third) || scored.has(third) || outRunnerIds(pa).has(third)) continue; // 消えていない=対象外
    const cause: RunEvent["cause"] = pa.result === "E" ? "error" : pa.result === "BB" ? "walk" : pa.result === "HBP" ? "hbp" : "hit";
    add.set(pa, { runner_id: third, rbi: cause !== "error", earned: cause !== "error", cause });
    short[pa.half]--;
  }
  if (!add.size) return doc;
  const pas = doc.plate_appearances.map((pa) => {
    const run = add.get(pa);
    if (!run) return pa;
    const keep = (pa.annotations ?? []).filter((a) => a.source !== "repair");
    // runs[] と整合させるため baserunning にも to:home を足す(R1/R3が再フラグしないように)。
    return {
      ...pa,
      runs: [...(pa.runs ?? []), run],
      baserunning_after: [...(pa.baserunning_after ?? []), { runner_id: run.runner_id, from: "3", to: "home" }],
      annotations: [...keep, { type: "manual" as const, detail: "強制走者の生還を自動補完", source: "repair" as const }],
    };
  });
  return { ...doc, plate_appearances: pas };
}

/** 検査結果を annotations に反映(validator起源を置換。AI/手動の注記は触らない)。冪等。 */
export function applyValidation(doc: GameDoc): GameDoc {
  const flags = validateGame(doc);
  const byKey = new Map<string, string[]>();
  for (const f of flags) {
    const k = `${f.inning}-${f.half}-${f.order}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(f.detail);
  }
  const pas = doc.plate_appearances.map((pa) => {
    const k = `${pa.inning}-${pa.half}-${pa.order}`;
    const keep = (pa.annotations ?? []).filter((a) => a.source !== "validator");
    const add = (byKey.get(k) ?? []).map((detail) => ({ type: "unclear" as const, detail, source: "validator" as const }));
    const ann = [...keep, ...add];
    if (ann.length === 0 && !pa.annotations) return pa; // 変化なし
    return { ...pa, annotations: ann };
  });
  return { ...doc, plate_appearances: pas };
}
