/**
 * [§9.4] 参加者ID層ベースの集計（新形式 doc.participants を読む）。旧 aggregateGame と同じ数値を出すが、
 * scope/合算キーを participants から解決する（接頭辞 scopeOf を使わない）。
 * ★解決境界: 参加者→player_id 解決は aggregateGameP 内に固定し、GameBox に試合ローカルIDを漏らさない。
 *   roster→key=link.player_id（クロス試合で合算）／guest→key=`${game.id}:${pid}`（試合横断で合算しない）。
 * ★投捕はスナップショット(pos1/pos2)から解決一本（pa.pitcher_id/catcher_id フォールバックは持たない＝§9.2）。
 * 旧 aggregateGame は移行検証(0差分)の基準として温存。Phase5 で消費側を本コードへ寄せ旧を撤去する。
 */
import type { GameDoc, Half, PlateAppearance, ParticipantLink, ResultCode, DirectBatting, DirectPitching, DirectFielding } from "@/lib/types/v2";
import type { BattingLine, PitchingLine, FieldingLine, AttendanceLine, GameBox, SeasonBox } from "./types";
import { resolveEr } from "./types";
import { outsMade, effectiveSnapshot, posMap } from "./index";
import { deriveResponsiblePitchers } from "@/lib/ops/gamestate";

const COUNTS_AB = new Set<ResultCode>(["H", "H1", "H2", "H3", "HR", "OUT", "K", "FC", "E"]);
const IS_HIT = new Set<ResultCode>(["H", "H1", "H2", "H3", "HR"]);
const NOT_PA = new Set<ResultCode>(["INC", "AUTO_OUT"]);
const BATTER_OUT = new Set<ResultCode>(["OUT", "SF", "SH"]);
// 打撃の集計対象数値フィールド(player_id/scope/g を除く全stat)。採用述語＝このいずれかが非ゼロ。
// h/b1/hr/rbi を必ず含む(欠落が §0 断片全損の blocker だった)。b2/b3 だけあって b1 が無い内部矛盾も解消。
const BAT_STAT_KEYS = ["pa", "ab", "r", "h", "b1", "b2", "b3", "hr", "rbi", "bb", "hbp", "k", "sh", "sf", "sb"] as const satisfies readonly (keyof BattingLine)[];
function isPA(pa: PlateAppearance): boolean {
  return pa.complete !== false && !NOT_PA.has(pa.result);
}

/** 参加者ID → 集計キー＋scope。roster=player_idで合算(own) / guest=game:pidで合算せず(guest)。 */
interface ResolvedKey {
  key: string;
  scope: "own" | "guest";
}
function makeResolver(doc: GameDoc): (pid: string) => ResolvedKey {
  const gameId = doc.game.id;
  const map = new Map<string, ParticipantLink>();
  for (const p of doc.participants ?? []) map.set(p.id, p.link);
  return (pid: string): ResolvedKey => {
    const link = map.get(pid);
    if (link && link.kind === "roster") return { key: link.player_id, scope: "own" };
    // [§12 P5 legacy・撤去しない] guest link（および KINGS 側未登録＝防御的に guest 扱い。未登録IDは validator が検出）。
    //   現公開版の新規linkは全て roster だが、game_history 過去版の旧guest linkの集計(?gen=N プレビュー)に必要。
    return { key: `${gameId}:${pid}`, scope: "guest" };
  };
}

type Accum<T> = Map<string, T>;
function bget(m: Accum<BattingLine>, rk: ResolvedKey): BattingLine {
  let x = m.get(rk.key);
  if (!x) {
    x = { player_id: rk.key, scope: rk.scope, g: 0, pa: 0, ab: 0, r: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, rbi: 0, bb: 0, hbp: 0, k: 0, sh: 0, sf: 0, sb: 0 };
    m.set(rk.key, x);
  }
  return x;
}
function pget(m: Accum<PitchingLine>, rk: ResolvedKey): PitchingLine {
  let x = m.get(rk.key);
  if (!x) {
    x = { player_id: rk.key, scope: rk.scope, g: 0, outs: 0, bf: 0, h: 0, hr: 0, k: 0, bb: 0, hbp: 0, r: 0, er: 0, wp: 0 };
    m.set(rk.key, x);
  }
  return x;
}
function fget(m: Accum<FieldingLine>, rk: ResolvedKey): FieldingLine {
  let x = m.get(rk.key);
  if (!x) {
    x = { player_id: rk.key, scope: rk.scope, g: 0, po: 0, a: 0, e: 0, tc: 0 };
    m.set(rk.key, x);
  }
  return x;
}

// 守備記録の付与（pa.fielding と baserunning_during.fielding で共用）。刺殺=putout_position(無ければseq最後)/捕殺=assist_positions(無ければ最後以外)。
type OutLike = { putout_position?: string | null; assist_positions?: string[]; at?: string; type?: string; runner_id?: string | null };
function creditOuts(outsList: OutLike[], seq: string[], pm: Map<string, string>, fielding: Accum<FieldingLine>, resolve: (pid: string) => ResolvedKey) {
  for (const o of outsList) {
    const putoutPos = o.putout_position ?? (seq.length ? seq[seq.length - 1] : null);
    if (putoutPos) {
      const pid = pm.get(putoutPos);
      if (pid) fget(fielding, resolve(pid)).po += 1;
    }
    const assists = o.assist_positions ?? [...new Set(seq.slice(0, -1))].filter((p) => p !== putoutPos);
    for (const ap of assists) {
      const pid = pm.get(ap);
      if (pid) fget(fielding, resolve(pid)).a += 1;
    }
  }
}
function creditErrors(errs: { pos: string }[] | undefined, pm: Map<string, string>, fielding: Accum<FieldingLine>, resolve: (pid: string) => ResolvedKey) {
  for (const err of errs ?? []) {
    const pid = pm.get(err.pos);
    if (pid) fget(fielding, resolve(pid)).e += 1;
  }
}

export function aggregateGameP(doc: GameDoc): GameBox {
  const batting: Accum<BattingLine> = new Map();
  const pitching: Accum<PitchingLine> = new Map();
  const fielding: Accum<FieldingLine> = new Map();
  const resolve = makeResolver(doc);

  const ha = doc.game.home_away;
  const batHalf: Half | null = ha === "away" ? "top" : ha === "home" ? "bottom" : null;
  const fieldHalf: Half | null = batHalf === "top" ? "bottom" : batHalf === "bottom" ? "top" : null;
  const snaps = doc.lineup_snapshots;
  const respMap = deriveResponsiblePitchers(doc); // [§10.6] read時の責任投手導出(reach規則+手動override)を共有関数から
  // [クラスタA] er(自責)は最終決定を後段へ回す。ここでは投手キー別に「確定自責の合算」と「不明(null earned)の有無」を別トラッキング。
  const erKnown = new Map<string, number>(); // 確定した自責の合算(earned===true の失点 ＋ direct の明示er)
  const erUnknown = new Set<string>(); // 自責が判定不能な寄与を持つ(earned===null の失点 / direct で r>0 だが er未記録)

  for (const pa of doc.plate_appearances) {
    // ---- 打撃（自軍攻撃 half）----
    if (batHalf && pa.half === batHalf) {
      const b = bget(batting, resolve(pa.batter_id));
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
      for (const run of pa.runs) if (run.rbi) b.rbi += 1; // 打点=打者(runner非依存・不明得点でも打者に付く)
      // [§0-C 防御(a)] 得点者不明(runner_id=null)は選手別Rを動かさない＝resolve(null)で幽霊guest行(`game:null`)を作らない。
      //   チーム得点/投手失点は下の責任投手帰属で計上する。
      for (const run of pa.runs) if (run.runner_id != null) bget(batting, resolve(run.runner_id)).r += 1;
      for (const bd of pa.baserunning_during ?? []) {
        if (bd.event === "SB") {
          for (const mv of bd.runners ?? []) bget(batting, resolve(mv.runner_id)).sb += 1;
        }
      }
    }

    // ---- 投手・守備（自軍守備 half）----
    if (fieldHalf && pa.half === fieldHalf) {
      const snap = effectiveSnapshot(snaps, pa.inning, pa.half, pa.order);
      const pm = posMap(snap);
      const facing = pm.get("1") ?? null; // 対戦投手=守備位置1。スナップ解決一本(pa.pitcher_idフォールバックは持たない)
      if (facing) {
        const p = pget(pitching, resolve(facing));
        if (isPA(pa)) p.bf += 1;
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
      // 失点/自責は責任投手へ([§10.6] read時共有導出: 手動override>保存値>出塁時投手(reach)>当該投手(facing))
      const paResp = respMap.get(pa);
      for (const run of pa.runs) {
        // [§0-C 帰属規則] 既知走者=責任投手map(reach規則) / 得点者不明(null)=明示resp ?? facing。
        //   いずれもチーム失点/自責は当該facing投手へ計上(選手別Rだけ動かさないのが上の防御(a))。
        const resp = run.runner_id != null ? (paResp?.get(run.runner_id) ?? facing) : (run.responsible_pitcher_id ?? facing);
        if (resp) {
          const rk = resolve(resp);
          const p = pget(pitching, rk);
          p.r += 1;
          // [クラスタA] er は後段で確定。earned===true=確定自責 / earned===null=不明 / earned===false=非自責(何もしない)。
          if (run.earned === true) erKnown.set(rk.key, (erKnown.get(rk.key) ?? 0) + 1);
          else if (run.earned === null) erUnknown.add(rk.key);
        }
      }
      // 守備
      const fl = pa.fielding;
      const hasFieldOuts = !!(fl && fl.outs && fl.outs.length);
      if (pa.result === "K" && !pa.dropped_third_strike && !hasFieldOuts) {
        const c = pm.get("2");
        if (c) fget(fielding, resolve(c)).po += 1;
      }
      if (fl) {
        const seq = fl.sequence ?? [];
        if (fl.outs && fl.outs.length) {
          creditOuts(fl.outs, seq, pm, fielding, resolve);
        } else if (BATTER_OUT.has(pa.result)) {
          const oneSeq = seq.length ? seq : fl.hit_to ? [fl.hit_to] : [];
          if (oneSeq.length) creditOuts([{}], oneSeq, pm, fielding, resolve);
        }
        creditErrors(fl.errors, pm, fielding, resolve);
      }
      for (const bd of pa.baserunning_during ?? []) {
        const bf = bd.fielding;
        if (bf) {
          const bseq = bf.sequence ?? [];
          if (bf.outs && bf.outs.length) creditOuts(bf.outs, bseq, pm, fielding, resolve);
          creditErrors(bf.errors, pm, fielding, resolve);
        }
      }
    }
  }

  // [§11 集計2段化 Phase3a] PA走査の後に doc.direct_stats を同じ resolve(participant_id) キーへ additive 加算。
  //   純§0試合(PAゼロ・directのみ)もここで箱に出る。er上書き(下)より前=direct投手のerも一旦accへ載る。
  // [V-D read側] 未参加の participant_id は resolve が `game:pid` の幽霊guest行を作るため read でも根絶する
  //   (書込時 reduceSetDirectStats の throw と二重防御。AI全置換後の participants クリアで残った宙吊り参照も落とす)。
  const partIds = new Set((doc.participants ?? []).map((p) => p.id));
  for (const ds of doc.direct_stats ?? []) {
    if (!partIds.has(ds.participant_id)) continue;
    const rk = resolve(ds.participant_id);
    if (ds.batting) mergeBatting(bget(batting, rk), directBattingLine(rk, ds.batting));
    if (ds.pitching) {
      mergePitching(pget(pitching, rk), directPitchingLine(rk, ds.pitching));
      // [クラスタA] direct の er: 明示(present)=確定自責の合算 / 未記録だが r>0=不明(0に潰さない)。
      const dp = ds.pitching;
      if (dp.er != null) erKnown.set(rk.key, (erKnown.get(rk.key) ?? 0) + dp.er);
      else if ((dp.r ?? 0) > 0) erUnknown.add(rk.key);
    }
    if (ds.fielding) mergeFielding(fget(fielding, rk), directFieldingLine(rk, ds.fielding));
  }

  // [クラスタA] direct 加算まで済んだ時点で各投手行の er を最終決定(null=不明)。doc.pitching(明示)は次段で上書き。
  for (const [key, p] of pitching) p.er = resolveEr(erKnown.get(key) ?? 0, erUnknown.has(key));

  // [§11 防御(d) / クラスタA A5 / minor①] 自責点は記録値を正本＝絶対に上書きしない。
  //   doc.pitching が名指す投手は er を記録値へ。earned_runs=null は「人が自責不明と明示」＝er=null(表示「—」)で正本
  //   （resolveEr の known/近似を上書きするが、人の明示「不明」が勝つのが正。捏造でなく不明の明示）。箱に line 無い投手も生成(明示erの箱落ち防止)。
  for (const rec of doc.pitching ?? []) {
    const p = pget(pitching, resolve(rec.pitcher_id)); // 無ければ生成(A5)
    p.er = rec.earned_runs; // number=確定自責 / null=不明の明示
  }

  // [§11 防御(b)] tc単独主張(po=a=e=0でtcだけ)を po+a+e=0 で握り潰さない。分解値と主張値の大きい方を採る。
  //   PA由来(tc=0開始→po+a+e)は Math.max(0, po+a+e)=po+a+e で不変(バイト一致)。
  for (const f of fielding.values()) f.tc = Math.max(f.tc, f.po + f.a + f.e);
  const setG = (arr: { g: number }[]) => arr.forEach((x) => (x.g = 1));
  // [§11 防御(c)/BLOCKER修正] 採用述語＝打撃の全非ゼロ数値フィールドのいずれかが非ゼロなら採用。
  //   direct由来の {h:2,rbi:1}(canonical「2安打1打点」)・{rbi:1}・{hr:1}・{h:2}・{b1:1} 等の断片を
  //   fold後に沈黙で全損させない(旧述語は h/b1/hr/rbi を欠き断片を丸ごと箱から消していた＝blocker)。
  //   PA由来は h/b1/hr/rbi>0⇒ab>0・k>0⇒ab>0 等で既に採用集合に入る＝採用集合は不変(15試合バイト一致)。
  //   空欄=None=0 は全フィールド0＝不採用のまま。
  const bArr = [...batting.values()].filter((b) => BAT_STAT_KEYS.some((k) => b[k] > 0));
  const pArr = [...pitching.values()];
  const fArr = [...fielding.values()].filter((f) => f.tc > 0);
  setG(bArr); setG(pArr); setG(fArr);

  return { game_id: doc.game.id, date: doc.game.date, batting: bArr, pitching: pArr, fielding: fArr };
}

// [§11 Phase3a] DirectXxx(全optional・空欄=None) → 完全な XxxLine(欠損は0)。merge の additive 加算に渡す。
function directBattingLine(rk: ResolvedKey, d: DirectBatting): BattingLine {
  return {
    player_id: rk.key, scope: rk.scope, g: 0,
    pa: d.pa ?? 0, ab: d.ab ?? 0, r: d.r ?? 0, h: d.h ?? 0, b1: d.b1 ?? 0, b2: d.b2 ?? 0, b3: d.b3 ?? 0,
    hr: d.hr ?? 0, rbi: d.rbi ?? 0, bb: d.bb ?? 0, hbp: d.hbp ?? 0, k: d.k ?? 0, sh: d.sh ?? 0, sf: d.sf ?? 0, sb: d.sb ?? 0,
  };
}
function directPitchingLine(rk: ResolvedKey, d: DirectPitching): PitchingLine {
  return {
    player_id: rk.key, scope: rk.scope, g: 0,
    outs: d.outs ?? 0, bf: d.bf ?? 0, h: d.h ?? 0, hr: d.hr ?? 0, k: d.k ?? 0, bb: d.bb ?? 0,
    // [クラスタA] er は d.er ?? 0 で潰さない＝None(不明)は erUnknown で追跡し、後段 resolveEr が最終決定する(ここは 0 プレースホルダで post-pass が上書き)。
    hbp: d.hbp ?? 0, r: d.r ?? 0, er: 0, wp: d.wp ?? 0,
  };
}
function directFieldingLine(rk: ResolvedKey, d: DirectFielding): FieldingLine {
  return { player_id: rk.key, scope: rk.scope, g: 0, po: d.po ?? 0, a: d.a ?? 0, e: d.e ?? 0, tc: d.tc ?? 0 };
}

function mergeBatting(into: BattingLine, x: BattingLine) {
  into.g += x.g; into.pa += x.pa; into.ab += x.ab; into.r += x.r; into.h += x.h;
  into.b1 += x.b1; into.b2 += x.b2; into.b3 += x.b3; into.hr += x.hr; into.rbi += x.rbi;
  into.bb += x.bb; into.hbp += x.hbp; into.k += x.k; into.sh += x.sh; into.sf += x.sf; into.sb += x.sb;
}
function mergePitching(into: PitchingLine, x: PitchingLine) {
  into.g += x.g; into.outs += x.outs; into.bf += x.bf; into.h += x.h; into.hr += x.hr;
  into.k += x.k; into.bb += x.bb; into.hbp += x.hbp; into.r += x.r; into.wp += x.wp;
  // [クラスタA] er は null 安全に合算(どちらか不明なら合算も不明)。シーズン集計で不明混在→null(表示「—」)。
  into.er = into.er == null || x.er == null ? null : into.er + x.er;
}
function mergeFielding(into: FieldingLine, x: FieldingLine) {
  into.g += x.g; into.po += x.po; into.a += x.a; into.e += x.e; into.tc += x.tc;
}

export function aggregateSeasonP(docs: GameDoc[]): SeasonBox {
  const b: Accum<BattingLine> = new Map();
  const p: Accum<PitchingLine> = new Map();
  const f: Accum<FieldingLine> = new Map();
  const att: Accum<AttendanceLine> = new Map();

  for (const doc of docs) {
    const box = aggregateGameP(doc);
    for (const x of box.batting) mergeBatting(bget(b, { key: x.player_id, scope: x.scope }), x);
    for (const x of box.pitching) mergePitching(pget(p, { key: x.player_id, scope: x.scope }), x);
    for (const x of box.fielding) mergeFielding(fget(f, { key: x.player_id, scope: x.scope }), x);
    // 出欠は participants 在籍（在籍=出席・attendance[] は廃止・participants に統合）
    const resolve = makeResolver(doc);
    for (const part of doc.participants ?? []) {
      const rk = resolve(part.id);
      let t = att.get(rk.key);
      if (!t) { t = { player_id: rk.key, scope: rk.scope, games: 0 }; att.set(rk.key, t); }
      t.games += 1; // 在籍=出席。played/benchの区別は廃止(出場は成績有無から導出)
    }
  }
  // 試合数(試)は出席数(participants在籍)を正本にする（解決後キーで揃う）。
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
