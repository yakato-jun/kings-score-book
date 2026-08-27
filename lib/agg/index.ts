/**
 * 集計エンジン（Phase1の中核）。v2試合doc → 選手別 打撃/投手/守備 ＋ シーズン集計 ＋ 出欠。
 *
 * 集計契約（手集計で検証済み・全試合 Excel と 0 差分を確認）:
 *  - 自軍の攻撃/守備の別は game.home_away（away=先攻→攻撃 top・守備 bottom / home=逆）。
 *  - 打撃 = 自軍攻撃 half の打席。打数=counts_at_bat(H1/H2/H3/HR/OUT/K/FC/E)。安打=H1〜HR。
 *    打点=runs[].rbi(その打席の打者起因)。得点=runs[].runner_id がその選手。盗塁=baserunning_during の SB 走者。
 *  - 投手 = 自軍守備 half の pitcher_id 単位。失点/自責=runs[]（responsible_pitcher へ帰属）。暴投=baserunning_during WP。
 *  - 守備 = 自軍守備 half。刺殺=putout_position(無ければ sequence 最後) / 捕殺=assist_positions(無ければ最後以外) /
 *    失策=errors.pos / 三振→その回の捕手(snapshot pos2)に刺殺1 / 守備機会=刺殺+捕殺+失策。守備位置→選手は有効 snapshot で解決。
 *  - 参加 = attendance（打席数ではない）。
 *  ※勝利/敗北/セーブ は記録員判断（v2 doc に持たない）ため当エンジンは算出しない。
 */
import type {
  GameDoc,
  Half,
  PlateAppearance,
  LineupSnapshot,
  ResultCode,
} from "../types/v2";
import type {
  BattingLine,
  PitchingLine,
  FieldingLine,
  AttendanceLine,
  GameBox,
  SeasonBox,
} from "./types";
import { resolveEr } from "./types";

const COUNTS_AB = new Set<ResultCode>(["H", "H1", "H2", "H3", "HR", "OUT", "K", "FC", "E"]);
const IS_HIT = new Set<ResultCode>(["H", "H1", "H2", "H3", "HR"]);
const NOT_PA = new Set<ResultCode>(["INC", "AUTO_OUT"]); // is_pa=false

// [§12 P5 legacy・撤去しない] game_history 過去版(旧 aggregateGame 経路)の旧guest link読みに必要。
//   pid が P### 以外=旧助っ人IDを guest 扱いにするフォールバック。現公開版の集計は participants 解決(participants.ts)。
function scopeOf(pid: string): "own" | "guest" {
  return pid.startsWith("P") ? "own" : "guest";
}
function halfRank(h: Half): number {
  return h === "top" ? 0 : 1;
}
function isPA(pa: PlateAppearance): boolean {
  return pa.complete !== false && !NOT_PA.has(pa.result);
}

/** (inning, half) に有効な最新スナップショットを返す */
// (inning, half, order) の辞書順比較。order は before_order が示す「この打席番号から有効」の閾値。
function leqPos(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] <= b[2];
}
export function effectiveSnapshot(
  snaps: LineupSnapshot[],
  inning: number,
  half: Half,
  order: number
): LineupSnapshot | null {
  const paPos: [number, number, number] = [inning, halfRank(half), order];
  let best: LineupSnapshot | null = null;
  for (const s of snaps) {
    const ef = s.effective_from;
    const snapPos: [number, number, number] = [ef.inning, halfRank(ef.half), ef.before_order ?? 0];
    // 開始スナップショット(seq0)は試合開始から有効（後攻チームの1回表対策）。
    // before_order を含めて比較し、イニング途中の守備交代を打席番号で正しく切り替える。
    const effective = s.seq === 0 || leqPos(snapPos, paPos);
    if (effective && (best === null || s.seq > best.seq)) best = s;
  }
  return best;
}
/** position_id -> player_id */
export function posMap(snap: LineupSnapshot | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!snap) return m;
  for (const r of snap.lineup) {
    if (r.position_id && r.player_id) m.set(r.position_id, r.player_id);
  }
  return m;
}

const BATTER_OUT = new Set<ResultCode>(["OUT", "SF", "SH"]);

/** このPAで増えたアウト数（三振+守備アウト+走塁死）。
 * 旧データはフライ/犠飛で fielding.outs を空にし sequence だけ記録するため、
 * out系resultなのに守備outが空なら打者アウト1を補完する。 */
export function outsMade(pa: PlateAppearance): number {
  const fo = pa.fielding?.outs ?? [];
  const counted = new Set<string>(); // 既にアウト計上した走者ID(二重計上防止)
  let o = fo.length;
  for (const f of fo) if (f.runner_id) counted.add(f.runner_id);
  for (const bd of pa.baserunning_during ?? []) {
    for (const m of bd.runners ?? []) if (m.to === "out") { o += 1; if (m.runner_id) counted.add(m.runner_id); }
  }
  // baserunning_after のアウト(打球での進塁中アウト等)も数える。ただしFCの封殺など fielding.outs と
  // 同じ走者を二重に数えない(走者除去はafterで行うため両方に出る)。idが無く守備outがある場合は重複とみなしスキップ。
  for (const m of pa.baserunning_after ?? []) {
    if (m.to !== "out") continue;
    if (m.runner_id ? counted.has(m.runner_id) : fo.length > 0) continue;
    o += 1; if (m.runner_id) counted.add(m.runner_id);
  }
  // 守備outが未記録のとき打者アウトを補完（三振=捕手刺殺 / フライ等=打者アウト / AUTO_OUT=自動アウト枠）。
  // 振り逃げで送球アウト(fielding.outsあり)のKは二重計上しない。
  if (fo.length === 0) {
    if (pa.result === "K" && !pa.dropped_third_strike) o += 1;
    else if (BATTER_OUT.has(pa.result) || pa.result === "AUTO_OUT") o += 1;
  }
  // 併殺/三重殺フラグ: 守備outの記録が足りなくても最低アウト数を保証(§10.3 保存アウト書き直しの前提)
  if (pa.double_play && o < 2) o = 2;
  if (pa.triple_play && o < 3) o = 3;
  return o;
}

type Accum<T> = Map<string, T>;
function bget(m: Accum<BattingLine>, pid: string): BattingLine {
  let x = m.get(pid);
  if (!x) {
    x = { player_id: pid, scope: scopeOf(pid), g: 0, pa: 0, ab: 0, r: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, rbi: 0, bb: 0, hbp: 0, k: 0, sh: 0, sf: 0, sb: 0 };
    m.set(pid, x);
  }
  return x;
}
function pget(m: Accum<PitchingLine>, pid: string): PitchingLine {
  let x = m.get(pid);
  if (!x) {
    x = { player_id: pid, scope: scopeOf(pid), g: 0, outs: 0, bf: 0, h: 0, hr: 0, k: 0, bb: 0, hbp: 0, r: 0, er: 0, wp: 0 };
    m.set(pid, x);
  }
  return x;
}
function fget(m: Accum<FieldingLine>, pid: string): FieldingLine {
  let x = m.get(pid);
  if (!x) {
    x = { player_id: pid, scope: scopeOf(pid), g: 0, po: 0, a: 0, e: 0, tc: 0 };
    m.set(pid, x);
  }
  return x;
}

// 守備記録の付与（pa.fielding と baserunning_during.fielding の両方で共用）。
// 刺殺=putout_position(無ければsequence最後) / 捕殺=assist_positions(無ければ最後以外)。
type OutLike = { putout_position?: string | null; assist_positions?: string[]; at?: string; type?: string; runner_id?: string | null };
function creditOuts(outsList: OutLike[], seq: string[], pm: Map<string, string>, fielding: Accum<FieldingLine>) {
  for (const o of outsList) {
    const putoutPos = o.putout_position ?? (seq.length ? seq[seq.length - 1] : null);
    if (putoutPos) {
      const pid = pm.get(putoutPos);
      if (pid) fget(fielding, pid).po += 1;
    }
    const assists = o.assist_positions ?? [...new Set(seq.slice(0, -1))].filter((p) => p !== putoutPos);
    for (const ap of assists) {
      const pid = pm.get(ap);
      if (pid) fget(fielding, pid).a += 1;
    }
  }
}
function creditErrors(errs: { pos: string }[] | undefined, pm: Map<string, string>, fielding: Accum<FieldingLine>) {
  for (const err of errs ?? []) {
    const pid = pm.get(err.pos);
    if (pid) fget(fielding, pid).e += 1;
  }
}

export interface LineScore {
  innings: number;
  topRuns: number[];
  bottomRuns: number[];
  topHits: number;
  bottomHits: number;
  topErrors: number; // top(表)の打席中に起きた失策＝後攻チームの守備失策
  bottomErrors: number; // bottom(裏)の打席中＝先攻チームの守備失策
}

/** 回別得点・安打・失策(ラインスコア)を試合docから集計 */
export function gameLineScore(doc: GameDoc): LineScore {
  const pas = doc.plate_appearances;
  const innings = pas.reduce((m, p) => Math.max(m, p.inning), 0);
  const topRuns = Array(innings).fill(0);
  const bottomRuns = Array(innings).fill(0);
  let topHits = 0, bottomHits = 0, topErrors = 0, bottomErrors = 0;
  for (const p of pas) {
    const top = p.half === "top";
    (top ? topRuns : bottomRuns)[p.inning - 1] += p.runs.length;
    if (IS_HIT.has(p.result)) top ? topHits++ : bottomHits++;
    let errs = p.fielding?.errors?.length ?? 0;
    for (const bd of p.baserunning_during ?? []) errs += bd.fielding?.errors?.length ?? 0;
    if (top) topErrors += errs; else bottomErrors += errs;
  }
  return { innings, topRuns, bottomRuns, topHits, bottomHits, topErrors, bottomErrors };
}

export interface DerivedResult { our: number; their: number; outcome: "win" | "loss" | "tie" }
/** 記録した打席からスコア・勝敗を導出する。打席が無ければ null(＝記録から導けない)。
 *  our/their は自軍の攻撃 half(away=表/home=裏)の得点合計。得点数はラインスコア(runs.length)の合算。 */
export function deriveResult(doc: GameDoc): DerivedResult | null {
  if (doc.plate_appearances.length === 0) return null;
  const ls = gameLineScore(doc);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const away = doc.game.home_away === "away";
  const our = sum(away ? ls.topRuns : ls.bottomRuns);
  const their = sum(away ? ls.bottomRuns : ls.topRuns);
  const outcome: "win" | "loss" | "tie" = our > their ? "win" : our < their ? "loss" : "tie";
  return { our, their, outcome };
}

export interface DisplayResult { our: number; their: number; outcome: "win" | "loss" | "tie"; decided_by: string | null; manual: boolean }
/** 表示用の最終結果。手入力(g.result)があればそれを正(manual:true・決着込み)、無ければ記録から導出(manual:false・
 *  decided_by:null)、どちらも無ければ null。基本は導出・手入力は上書き、という表示方針の一元窓口。 */
export function displayResult(doc: GameDoc): DisplayResult | null {
  const r = doc.game.result;
  if (r) return { our: r.our_score, their: r.their_score, outcome: r.outcome, decided_by: r.decided_by, manual: true };
  const d = deriveResult(doc);
  if (d) return { our: d.our, their: d.their, outcome: d.outcome, decided_by: null, manual: false };
  return null;
}

export function aggregateGame(doc: GameDoc): GameBox {
  const batting: Accum<BattingLine> = new Map();
  const pitching: Accum<PitchingLine> = new Map();
  const fielding: Accum<FieldingLine> = new Map();

  const ha = doc.game.home_away;
  // home_away が null(不戦勝/未実施)なら PA なし → 空集計
  const batHalf: Half | null = ha === "away" ? "top" : ha === "home" ? "bottom" : null;
  const fieldHalf: Half | null = batHalf === "top" ? "bottom" : batHalf === "bottom" ? "top" : null;

  const snaps = doc.lineup_snapshots;
  // [クラスタA] er(自責)は最終決定を後段へ。投手別に「確定自責の合算」と「不明(null earned)の有無」を別トラッキング。
  const erKnown = new Map<string, number>();
  const erUnknown = new Set<string>();

  for (const pa of doc.plate_appearances) {
    // ---- 打撃（自軍攻撃 half）----
    if (batHalf && pa.half === batHalf) {
      const b = bget(batting, pa.batter_id);
      if (isPA(pa)) b.pa += 1;
      if (COUNTS_AB.has(pa.result)) b.ab += 1;
      if (IS_HIT.has(pa.result)) b.h += 1;
      if (pa.result === "H1") b.b1 += 1;
      else if (pa.result === "H2") b.b2 += 1;
      else if (pa.result === "H3") b.b3 += 1;
      else if (pa.result === "HR") b.hr += 1;
      if (pa.result === "BB") b.bb += 1;
      if (pa.result === "HBP") b.hbp += 1;
      if (pa.result === "K") b.k += 1;
      if (pa.result === "SH") b.sh += 1;
      if (pa.result === "SF") b.sf += 1;
      // 打点: この打席の runs[].rbi
      for (const run of pa.runs) if (run.rbi) b.rbi += 1;
      // 得点: 生還した走者(自軍)へ。[§0-C] 得点者不明(runner_id=null)は選手別Rを動かさない(旧集計も防御)
      for (const run of pa.runs) if (run.runner_id != null) bget(batting, run.runner_id).r += 1;
      // 盗塁: 打席中 SB の走者へ
      for (const bd of pa.baserunning_during ?? []) {
        if (bd.event === "SB") {
          for (const mv of bd.runners ?? []) bget(batting, mv.runner_id).sb += 1;
        }
      }
    }

    // ---- 投手・守備（自軍守備 half）----
    if (fieldHalf && pa.half === fieldHalf) {
      // 投手/守備は「その打席時点の有効スナップショット」から再導出する(保存値に依存しない＝後発の守備変更が正しくカスケード)。
      const snap = effectiveSnapshot(snaps, pa.inning, pa.half, pa.order);
      const pm = posMap(snap);
      const facing = pm.get("1") ?? pa.pitcher_id ?? null; // 対戦投手=守備位置1。スナップに居なければ保存値へフォールバック(旧データ保険)
      // 投手（facing 単位）
      if (facing) {
        const p = pget(pitching, facing);
        if (isPA(pa)) p.bf += 1; // 未完了打席(INC: 盗塁死等でチェンジ)は対打者に数えない
        p.outs += outsMade(pa);
        if (IS_HIT.has(pa.result)) p.h += 1;
        if (pa.result === "HR") p.hr += 1;
        if (pa.result === "K") p.k += 1;
        if (pa.result === "BB") p.bb += 1;
        if (pa.result === "HBP") p.hbp += 1;
        for (const bd of pa.baserunning_during ?? []) {
          if (bd.event === "WP") p.wp += 1;
        }
      }
      // 失点/自責は責任投手へ帰属(明示の responsible_pitcher_id 優先、無ければ再導出した対戦投手)
      for (const run of pa.runs) {
        const resp = run.responsible_pitcher_id ?? facing;
        if (resp) {
          const p = pget(pitching, resp);
          p.r += 1;
          // [クラスタA] earned===true=確定自責 / earned===null=不明 / earned===false=非自責(何もしない)。
          if (run.earned === true) erKnown.set(resp, (erKnown.get(resp) ?? 0) + 1);
          else if (run.earned === null) erUnknown.add(resp);
        }
      }
      // 守備
      const fl = pa.fielding;
      const hasFieldOuts = !!(fl && fl.outs && fl.outs.length);
      // 三振 → 捕手(pos2)に刺殺。ただし送球アウト(fielding.outsあり)の場合は
      // そちらで刺殺/捕殺を計上するので捕手の自動刺殺はしない。
      if (pa.result === "K" && !pa.dropped_third_strike && !hasFieldOuts) {
        const c = pm.get("2");
        if (c) fget(fielding, c).po += 1;
      }
      if (fl) {
        const seq = fl.sequence ?? [];
        if (fl.outs && fl.outs.length) {
          creditOuts(fl.outs, seq, pm, fielding);
        } else if (BATTER_OUT.has(pa.result)) {
          // 旧データ: フライ/捕球アウトが outs未記録 → sequence(無ければhit_to)から1刺殺を導出
          const oneSeq = seq.length ? seq : fl.hit_to ? [fl.hit_to] : [];
          if (oneSeq.length) creditOuts([{}], oneSeq, pm, fielding);
        }
        creditErrors(fl.errors, pm, fielding);
      }
      // 走塁中のアウト（盗塁死/牽制死など）の守備記録
      for (const bd of pa.baserunning_during ?? []) {
        const bf = bd.fielding;
        if (bf) {
          const bseq = bf.sequence ?? [];
          if (bf.outs && bf.outs.length) creditOuts(bf.outs, bseq, pm, fielding);
          creditErrors(bf.errors, pm, fielding);
        }
      }
    }
  }

  // [クラスタA] er を最終決定(null=不明)。doc.pitching(明示)は次段で上書き＝正本。
  for (const [pid, p] of pitching) p.er = resolveEr(erKnown.get(pid) ?? 0, erUnknown.has(pid));

  // 自責点は記録値を正本とする。doc.pitching が名指す投手は er を記録値へ(箱に line 無ければ生成＝箱落ち防止)。
  //   [minor①] earned_runs=null=「人が自責不明と明示」＝er=null(表示「—」)で正本。resolveErの近似を上書きするが人の明示「不明」が勝つのが正。
  for (const rec of doc.pitching ?? []) {
    const p = pget(pitching, rec.pitcher_id);
    p.er = rec.earned_runs; // number=確定自責 / null=不明の明示
  }

  // tc と g(=1) を確定
  for (const f of fielding.values()) f.tc = f.po + f.a + f.e;
  const setG = (arr: { g: number }[]) => arr.forEach((x) => (x.g = 1));
  const bArr = [...batting.values()].filter((b) => b.pa > 0 || b.ab > 0 || b.bb > 0 || b.hbp > 0 || b.sh > 0 || b.sf > 0 || b.r > 0 || b.sb > 0);
  const pArr = [...pitching.values()];
  const fArr = [...fielding.values()].filter((f) => f.tc > 0);
  setG(bArr); setG(pArr); setG(fArr);

  return { game_id: doc.game.id, date: doc.game.date, batting: bArr, pitching: pArr, fielding: fArr };
}

function mergeBatting(into: BattingLine, x: BattingLine) {
  into.g += x.g; into.pa += x.pa; into.ab += x.ab; into.r += x.r; into.h += x.h;
  into.b1 += x.b1; into.b2 += x.b2; into.b3 += x.b3; into.hr += x.hr; into.rbi += x.rbi;
  into.bb += x.bb; into.hbp += x.hbp; into.k += x.k; into.sh += x.sh; into.sf += x.sf; into.sb += x.sb;
}
function mergePitching(into: PitchingLine, x: PitchingLine) {
  into.g += x.g; into.outs += x.outs; into.bf += x.bf; into.h += x.h; into.hr += x.hr;
  into.k += x.k; into.bb += x.bb; into.hbp += x.hbp; into.r += x.r; into.wp += x.wp;
  // [クラスタA] er は null 安全に合算(どちらか不明なら合算も不明)。
  into.er = into.er == null || x.er == null ? null : into.er + x.er;
}
function mergeFielding(into: FieldingLine, x: FieldingLine) {
  into.g += x.g; into.po += x.po; into.a += x.a; into.e += x.e; into.tc += x.tc;
}

export function aggregateSeason(docs: GameDoc[]): SeasonBox {
  const b: Accum<BattingLine> = new Map();
  const p: Accum<PitchingLine> = new Map();
  const f: Accum<FieldingLine> = new Map();
  const att: Accum<AttendanceLine> = new Map();

  for (const doc of docs) {
    const box = aggregateGame(doc);
    for (const x of box.batting) { const t = bget(b, x.player_id); mergeBatting(t, x); }
    for (const x of box.pitching) { const t = pget(p, x.player_id); mergePitching(t, x); }
    for (const x of box.fielding) { const t = fget(f, x.player_id); mergeFielding(t, x); }
    for (const a of doc.attendance ?? []) {
      let t = att.get(a.player_id);
      if (!t) { t = { player_id: a.player_id, scope: a.scope, games: 0 }; att.set(a.player_id, t); }
      t.games += 1; // 在籍=出席。played/benchの区別は廃止(出場は成績有無から導出)
    }
  }
  // 試合数(試)は出席数(attendance.games)を正本にする。
  // 打席や守備機会が無い試合でも出席していれば数える。投手の登板数(g)は登板ベースのまま。
  const attendedBy = new Map([...att.values()].map((a) => [a.player_id, a.games]));
  for (const line of b.values()) {
    const pl = attendedBy.get(line.player_id);
    if (pl !== undefined) line.g = pl;
  }
  for (const line of f.values()) {
    const pl = attendedBy.get(line.player_id);
    if (pl !== undefined) line.g = pl;
  }

  return {
    games: docs.length,
    batting: [...b.values()],
    pitching: [...p.values()],
    fielding: [...f.values()],
    attendance: [...att.values()],
  };
}
