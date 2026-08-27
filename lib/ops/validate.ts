/**
 * ルールベース事後バリデータ。導出した盤面に対して不変条件を検査し、破れた打席に
 * annotations[{type:"unclear", source:"validator"}] を付ける(=編集シードで浮上→修正へ)。
 *
 * 方針: ブロックしない(形式ルールで弾かない)。タグ付けのみ。冪等(再検査でvalidator起源を置換)。
 * ハードな矛盾のみ: (R1)得点数と盤面導出の生還者数の不一致、(R2)未登録の選手ID、
 * (R3)走者保存則の破れ＝塁上の走者が「アウトでも得点でもなく」盤面から消える取りこぼし。
 */
import type { GameDoc, Half, PlateAppearance, Annotation, Runners } from "@/lib/types/v2";
import { derivePAStates, deriveScorers, foldRunners, kingsBatHalf, deriveResponsiblePitchers } from "./gamestate";
import { ownSidePaIds } from "@/lib/sides";
import { outsMade, effectiveSnapshot, posMap } from "@/lib/agg";

export interface GameFlag { inning: number; half: Half; order: number; detail: string; rule: string }

/**
 * 打席の「未解決(承認されていない)の不明瞭」注記。要確認カウント/表示はこれを使う。
 * validator由来は再検査で承認済みルールが既に除かれている前提(残っている=未解決)。
 * AI由来(source:ai)はキーイング不可なので、ルール無しの承認(打席単位)があれば除外する。
 */
export function unresolvedUnclear(pa: PlateAppearance): Annotation[] {
  const ann = pa.annotations ?? [];
  const aiResolved = ann.some((a) => a.type === "resolved" && !a.rule);
  const resolvedRules = new Set(ann.filter((a) => a.type === "resolved" && a.rule).map((a) => a.rule));
  return ann.filter(
    (a) => a.type === "unclear" && !(a.source === "ai" && aiResolved) && !(a.rule && resolvedRules.has(a.rule))
  );
}

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

/** 既知の人物ID。§9: participants(=試合の人リスト)が正本。旧形式doc(移行前/過去版)も検査できるよう旧ソースを合流。 */
function knownIds(doc: GameDoc): Set<string> {
  const s = new Set<string>();
  for (const p of doc.participants ?? []) s.add(p.id);
  for (const snap of doc.lineup_snapshots ?? []) {
    for (const r of snap.roster ?? []) if (r.player_id) s.add(r.player_id);
    for (const l of snap.lineup ?? []) if (l.player_id) s.add(l.player_id);
  }
  for (const a of doc.additional_players ?? []) s.add(a.id); // 旧形式
  return s;
}

/**
 * @param nameOf 参加者ID/選手マスタID→表示名リゾルバ(任意)。detail に人物IDを直接埋めず名前で出すために注入する
 *   ([[feedback_no_internal_codes_to_user]]: m1/P001 等の内部コードをユーザー向け文言に出さない)。
 *   未注入(純ロジックテスト等)は従来どおりIDのまま＝挙動不変(nm() が id へフォールバック)。
 */
export function validateGame(doc: GameDoc, nameOf?: (id: string) => string): GameFlag[] {
  const flags: GameFlag[] = [];
  const states = derivePAStates(doc);
  const known = knownIds(doc);
  const nm = (id: string) => nameOf?.(id) ?? id; // 名前解決(未注入=ID)。detail の人物IDはこれを通す
  // 打席が承認(resolved)したルールコードの集合。そのルールは再検査でスキップ(蒸し返さない)。承認はルール単位。
  const resolvedRules = (pa: PlateAppearance) =>
    new Set((pa.annotations ?? []).filter((a) => a.type === "resolved" && a.rule).map((a) => a.rule as string));
  for (const pa of doc.plate_appearances) {
    const rr = resolvedRules(pa);
    const at = { inning: pa.inning, half: pa.half, order: pa.order };
    const start = states.get(pa)?.runners ?? { first: null, second: null, third: null };
    // R1: 得点数 と 盤面から導いた生還者数 の不一致(押し出し漏れ・余分な得点・得点者矛盾を捕捉)
    //   [§0-C 調停] deriveScorers は盤面導出＝得点者不明(runner_id=null)の得点は見えない(0扱い)。
    //   null得点を runCount に数えると恒久的に不一致→要確認になるため、非null得点のみ比較する。
    const scorers = deriveScorers(start, pa);
    const runCount = (pa.runs ?? []).filter((r) => r.runner_id != null).length;
    if (!rr.has("R1") && runCount !== scorers.length) {
      flags.push({ ...at, rule: "R1", detail: `得点数(${runCount})が盤面から導いた生還者数(${scorers.length})と一致しません` });
    }
    // R3: 走者保存則。開始時に塁上の走者は、この打席後 (a)塁上に残る (b)生還 (c)アウト (d)代走に置換 のいずれか
    //   でなければ消えない。どれにも該当せず盤面から消える=FCの押し出し走者の記録漏れ等の取りこぼし。
    //   代走はエンジンが盤面置換に対応(§10.3)したためスキップを撤廃し、置換された元走者を(d)として許容する。
    if (!rr.has("R3")) {
      const after = foldRunners(start, pa);
      const onBase = new Set([after.first, after.second, after.third].filter(Boolean) as string[]);
      const scored = new Set(scorers);
      const out = outRunnerIds(pa);
      const replaced = pa.pinch_runner?.replaced_id ?? (pa.pinch_runner?.for_base ? start[({ "1": "first", "2": "second", "3": "third" } as const)[pa.pinch_runner.for_base]] : null);
      // [§0-C 調停] 得点者不明(runner_id=null)の得点は deriveScorers に出ない。盤面ありのPAで実在走者が
      //   null得点で還ると「消えた」と誤検知しうるため、null得点の件数ぶんの生還を許容する(予算で相殺)。
      let nullRunBudget = (pa.runs ?? []).filter((r) => r.runner_id == null).length;
      for (const base of ["first", "second", "third"] as const) {
        const id = start[base];
        if (!id || onBase.has(id) || scored.has(id) || out.has(id) || id === replaced) continue;
        if (pa.pinch_runner && !pa.pinch_runner.for_base && !pa.pinch_runner.replaced_id) continue; // 旧データ(対象情報なし)は誤検知回避で従来どおりスキップ
        if (nullRunBudget > 0) { nullRunBudget -= 1; continue; } // 不明得点で還ったとみなす
        flags.push({ ...at, rule: "R3", detail: `${BASE_JP[base]}走者が消えました（塁上・得点・アウト・代走置換のいずれにも記録がありません）` });
      }
    }
    // R2: 未登録の選手ID(GUEST:名前 の取りこぼし等)。§9二軸: 自軍side参照(共有列挙=自軍攻撃halfの打者/走者
    //   ＋相手攻撃halfの責任投手)だけを検査する。相手の打者/走者は身元非追跡＝構造的に対象外(接頭辞除外を置換)。
    if (!rr.has("R2")) {
      const bad = ownSidePaIds(doc, pa).find((id) => !known.has(id));
      // R2は「未登録＝参加者に居ない」参照が対象＝名前解決の術が無い(nm を通しても id へフォールバックするだけ)。
      //   どの参照が宙に浮いているかを示すには生の参照トークン(id)を出すのが正確。よって R2 のみ id 表示のまま。
      if (bad) flags.push({ ...at, rule: "R2", detail: `未登録の選手ID「${bad}」が含まれています` });
    }
  }

  // R4: グローバル得点アンカー。申告スコア(game.result)があるとき導出総得点と突合する。
  //   局所ルール(R1/R3)が見逃す『内部的に辻褄の合った得点の取りこぼし/重複』を総和で捕まえる。
  //   試合全体の話なので、該当halfの最後の打席に付ける(テキストスコアでその回末へ飛べる)。
  const res = doc.game.result;
  const totals = deriveTeamTotals(doc);
  if (res && totals) {
    const ownHalf = totals.ownHalf;
    const oppHalf: Half = ownHalf === "top" ? "bottom" : "top";
    const { own, opp } = totals;
    const rank = (h: Half) => (h === "top" ? 0 : 1);
    const chrono = (a: PlateAppearance, b: PlateAppearance) => a.inning - b.inning || rank(a.half) - rank(b.half) || a.order - b.order;
    const lastAll = [...doc.plate_appearances].sort(chrono).at(-1);
    // 該当halfの最後の打席に付ける(無ければ試合末尾の打席=非ゼロ申告で打席ゼロでも握り潰さない)
    const anchor = (h: Half) => [...doc.plate_appearances].filter((p) => p.half === h).sort(chrono).at(-1) ?? lastAll;
    const r4ok = (p: PlateAppearance) => !(p.annotations ?? []).some((a) => a.type === "resolved" && a.rule === "R4");
    // [§0/§11] our_score/their_score が数値の時だけ突合する。line_score だけ(途中経過・§0-B)の部分resultは
    //   our_score が未設定になり得るため、undefined との比較で誤検知しない(断片試合の許容)。
    if (typeof res.our_score === "number" && own !== res.our_score) {
      const p = anchor(ownHalf);
      if (p && r4ok(p)) flags.push({ inning: p.inning, half: p.half, order: p.order, rule: "R4", detail: `自軍の総得点(導出${own})が申告スコア(${res.our_score})と一致しません（どこかで得点の取りこぼし/重複）` });
    }
    if (typeof res.their_score === "number" && opp !== res.their_score) {
      const p = anchor(oppHalf);
      if (p && r4ok(p)) flags.push({ inning: p.inning, half: p.half, order: p.order, rule: "R4", detail: `相手の総得点(導出${opp})が申告スコア(${res.their_score})と一致しません` });
    }
  }

  // (deriveTeamTotals はファイル末尾に export。R4 と表示側=試合一覧のスコアフォールバックが共用する)

  // R5: 打順連続性(自軍)。自軍の打席を時系列に並べ、隣接する2打席が同一打者＝打順を一巡せず連続＝打順ズレの疑い。
  //   ブロックせず要確認(特別ルールで連続打席もあり得る→ユーザーが承認できる)。承認(resolved rule:R5)はスキップ。
  const kHalf = kingsBatHalf(doc);
  const kingsPAs = doc.plate_appearances.filter((p) => p.half === kHalf).sort((a, b) => a.inning - b.inning || a.order - b.order);
  for (let i = 1; i < kingsPAs.length; i++) {
    const cur = kingsPAs[i];
    if (cur.batter_id && cur.batter_id === kingsPAs[i - 1].batter_id) {
      if ((cur.annotations ?? []).some((a) => a.type === "resolved" && a.rule === "R5")) continue;
      flags.push({ inning: cur.inning, half: cur.half, order: cur.order, rule: "R5", detail: "同じ打者が打順を一巡せず連続して打席に立っています（打順ズレの疑い）" });
    }
  }

  // R6(V-B): 同一試合で複数の参加者が同じ選手(マスタ)を指す＝シーズン二重計上の危険。
  //   主防御はreducerのコミット前throw。ここは移行/取込等で入り込んだ既存データの検出網(タグのみ)。
  const seen = new Map<string, number>();
  for (const p of doc.participants ?? []) {
    if (p.link.kind === "roster") seen.set(p.link.player_id, (seen.get(p.link.player_id) ?? 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (dups.length) {
    const rank = (h: Half) => (h === "top" ? 0 : 1);
    const anchorPa = [...doc.plate_appearances].sort((a, b) => a.inning - b.inning || rank(a.half) - rank(b.half) || a.order - b.order).at(-1);
    if (anchorPa && !(anchorPa.annotations ?? []).some((a) => a.type === "resolved" && a.rule === "R6")) {
      flags.push({ inning: anchorPa.inning, half: anchorPa.half, order: anchorPa.order, rule: "R6", detail: `同じ選手(${dups.map(nm).join(", ")})が複数の参加者として登録されています（シーズン二重計上の危険）` });
    }
  }

  // R7/R8: 投手記録(doc.pitching=記録値§10.3三分類B)の整合。弾かない・タグのみ・冪等。
  //   R7: 参照整合＝記録の投手が参加者(旧形式は既知ID)に存在する。
  //   R8: 投手別の自責点(記録値) ≤ その投手への帰属失点(集計エンジンと同じ規則:
  //       相手攻撃halfのrunsを 明示responsible_pitcher_id ?? その打席時点の守備位置1 に帰属)。
  //   試合全体の話なので R6 同様に時系列最後の打席へ付ける(承認はルール単位)。
  if (doc.pitching?.length) {
    const rank = (h: Half) => (h === "top" ? 0 : 1);
    const anchorPa = [...doc.plate_appearances].sort((a, b) => a.inning - b.inning || rank(a.half) - rank(b.half) || a.order - b.order).at(-1);
    if (anchorPa) {
      const kb = kingsBatHalf(doc);
      const respMap = deriveResponsiblePitchers(doc); // [§10.6] 集計と同一の read時導出(reach規則+手動override)
      const attributed = new Map<string, number>(); // 投手→帰属失点
      for (const pa of doc.plate_appearances) {
        if (pa.half === kb) continue; // 自軍攻撃half=相手の失点は対象外
        const facing = posMap(effectiveSnapshot(doc.lineup_snapshots ?? [], pa.inning, pa.half, pa.order)).get("1") ?? null;
        const paResp = respMap.get(pa);
        for (const run of pa.runs ?? []) {
          // [§0-C] 得点者不明(null)も帰属失点はfacing(or明示resp)へ計上(投手R8の突合対象)。
          const resp = run.runner_id != null ? (paResp?.get(run.runner_id) ?? facing) : (run.responsible_pitcher_id ?? facing);
          if (resp) attributed.set(resp, (attributed.get(resp) ?? 0) + 1);
        }
      }
      const resolvedAt = (rule: string) => (anchorPa.annotations ?? []).some((a) => a.type === "resolved" && a.rule === rule);
      const at = { inning: anchorPa.inning, half: anchorPa.half, order: anchorPa.order };
      for (const rec of doc.pitching) {
        if (!known.has(rec.pitcher_id)) {
          if (!resolvedAt("R7")) flags.push({ ...at, rule: "R7", detail: `投手記録の投手「${nm(rec.pitcher_id)}」がこの試合の参加者に居ません` });
        } else if (rec.earned_runs != null && rec.earned_runs > (attributed.get(rec.pitcher_id) ?? 0)) {
          // [minor①] earned_runs=null(自責不明)は帰属失点との突合対象外＝不明に超過チェックはしない。
          if (!resolvedAt("R8")) flags.push({ ...at, rule: "R8", detail: `投手「${nm(rec.pitcher_id)}」の自責点(${rec.earned_runs})が帰属失点(${attributed.get(rec.pitcher_id) ?? 0})を超えています` });
        }
      }
    }
  }

  // V-G(クラスタA §0/§11): 失点(r>0)があるのに自責点が genuine unknown(人未明示 かつ 導出でも決められない)な投手を要確認。
  //   源: 走者不明得点(earned=null)の失点 / 断片(direct)で r>0 だが er 未記録。人明示(doc.pitching / direct er 明示)は対象外＝過剰タグ回避(対称ガード)。
  //   標準の error-vs-earned 近似(deriveRunsの仮確定)は自明扱いで flag しない=genuine unknown だけ。
  //   試合レベル=時系列最後の打席へ付ける(R7/R8/V-E/V-F と同じ)。純§0(PAゼロ)は付け先が無く現状は表面化しない(§11 既知)。承認(rule:V-G)はスキップ。
  {
    const rank = (h: Half) => (h === "top" ? 0 : 1);
    const anchorPa = [...doc.plate_appearances].sort((a, b) => a.inning - b.inning || rank(a.half) - rank(b.half) || a.order - b.order).at(-1);
    if (anchorPa && !resolvedRules(anchorPa).has("V-G")) {
      const kb = kingsBatHalf(doc);
      const respMap = deriveResponsiblePitchers(doc); // 集計と同一の read時導出(reach規則+手動override)
      const attrR = new Map<string, number>(); // 投手→帰属失点
      const unknownEr = new Set<string>(); // 自責が不明(earned=null)な失点を持つ投手
      for (const pa of doc.plate_appearances) {
        if (pa.half === kb) continue; // 自軍攻撃half=相手の失点は対象外
        const facing = posMap(effectiveSnapshot(doc.lineup_snapshots ?? [], pa.inning, pa.half, pa.order)).get("1") ?? null;
        const paResp = respMap.get(pa);
        for (const run of pa.runs ?? []) {
          const resp = run.runner_id != null ? (paResp?.get(run.runner_id) ?? facing) : (run.responsible_pitcher_id ?? facing);
          if (!resp) continue;
          attrR.set(resp, (attrR.get(resp) ?? 0) + 1);
          if (run.earned == null) unknownEr.add(resp); // null=自責不明
        }
      }
      // 断片(direct): er明示=明示扱い(対象外) / er未記録だが r>0=不明。
      const directErKnown = new Set<string>();
      for (const ds of doc.direct_stats ?? []) {
        const dp = ds.pitching;
        if (!dp) continue;
        if (dp.er != null) directErKnown.add(ds.participant_id);
        else if ((dp.r ?? 0) > 0) { unknownEr.add(ds.participant_id); attrR.set(ds.participant_id, (attrR.get(ds.participant_id) ?? 0) + (dp.r ?? 0)); }
      }
      // [minor①] earned_runs が number の投手のみ「明示」＝V-G対象外。earned_runs:null(判定だけ・自責不明)は明示ではないので
      //   r>0 なら V-G に surface する(不明をsurfaceするのがコンセプト整合。decision付きでも不明は隠さない)。
      const docErKnown = new Set((doc.pitching ?? []).filter((r) => r.earned_runs != null).map((r) => r.pitcher_id));
      const genuine = [...unknownEr].filter((id) => !docErKnown.has(id) && !directErKnown.has(id) && (attrR.get(id) ?? 0) > 0).sort();
      if (genuine.length) {
        flags.push({ inning: anchorPa.inning, half: anchorPa.half, order: anchorPa.order, rule: "V-G", detail: `投手(${genuine.map(nm).join(", ")})に失点がありますが自責点が未記録(不明)です（分かれば入力してください）` });
      }
    }
  }

  // R9(§10.3 Phase E): 守備完全性。複数人の守備交代を途中でやめると「投手空位・同守備位置2人」の中間状態が
  //   保存され、その区間の投手/守備成績が誰にも計上されない(無音)。自軍守備half(相手攻撃)の各打席時点の有効
  //   スナップショットで (1)守備位置1(投手)が不在 (2)同一守備位置(1..9)に2人以上 を検出しタグ(弾かない・冪等)。
  //   相手守備(自軍攻撃時)は身元非追跡＝対象外。同一スナップショットが連続する打席は先頭だけ検査(重複タグ回避)。
  //   承認(resolved rule:R9)はスキップ。
  const snaps9 = doc.lineup_snapshots ?? [];
  const ha9 = doc.game.home_away;
  const defHalf: Half | null = ha9 === "away" ? "bottom" : ha9 === "home" ? "top" : null;
  if (snaps9.length && defHalf) {
    const rank = (h: Half) => (h === "top" ? 0 : 1);
    const defPAs = [...doc.plate_appearances]
      .filter((p) => p.half === defHalf)
      .sort((a, b) => a.inning - b.inning || rank(a.half) - rank(b.half) || a.order - b.order);
    let lastSnapId: string | null = null;
    for (const pa of defPAs) {
      const snap = effectiveSnapshot(snaps9, pa.inning, pa.half, pa.order);
      if (!snap) continue;
      if (snap.snapshot_id === lastSnapId) continue; // 同一配置の連続打席は先頭のみ(重複タグ回避)
      lastSnapId = snap.snapshot_id;
      if (resolvedRules(pa).has("R9")) continue;
      const byPos = new Map<string, number>();
      for (const l of snap.lineup) {
        if (l.position_id && /^[1-9]$/.test(l.position_id)) byPos.set(l.position_id, (byPos.get(l.position_id) ?? 0) + 1);
      }
      const problems: string[] = [];
      if ((byPos.get("1") ?? 0) === 0) problems.push("投手(守備位置1)が不在です");
      const dupes = [...byPos.entries()].filter(([, n]) => n > 1).map(([p]) => p).sort();
      if (dupes.length) problems.push(`守備位置${dupes.join(",")}に複数の選手が配置されています`);
      if (problems.length) {
        flags.push({ inning: pa.inning, half: pa.half, order: pa.order, rule: "R9", detail: `守備配置が不完全です: ${problems.join(" / ")}（交代の入力途中の可能性。確認してください）` });
      }
    }
  }

  // R10: 半イニングのアウト数 > 3。AIが「ゴロ+エラー(出塁)」等を誤ってOUTと転記すると4個以上のアウトが
  //   積まれるが現状無警告(実測で頻発)なため決定的な網を張る。数え方はエンジン(derivePAStates の累積)と
  //   同一の outsMade(double_play/triple_play・走塁アウト to:"out"・結果コード由来の打者アウトを含む)を
  //   再利用＝二重実装しない。3未満は入力途中として正常(部分入力は第一級)なので絶対に警告しない。
  //   アンカーは「4個目のアウトが発生した打席」＝1半イニングにつき1件だけ。承認(resolved rule:R10)は
  //   スキップ(R5/R9と同じ)。
  {
    const byHalf10 = new Map<string, PlateAppearance[]>();
    for (const p of doc.plate_appearances) {
      const k = `${p.inning}-${p.half}`;
      (byHalf10.get(k) ?? byHalf10.set(k, []).get(k)!).push(p);
    }
    for (const list of byHalf10.values()) {
      const ordered = [...list].sort((a, b) => a.order - b.order);
      const total = ordered.reduce((s, p) => s + outsMade(p), 0);
      if (total <= 3) continue; // 3ちょうどは正常、3未満は入力途中(第一級)＝警告しない
      let cum10 = 0;
      const anchor = ordered.find((p) => (cum10 += outsMade(p)) > 3)!; // total>3 なので必ず存在
      if (resolvedRules(anchor).has("R10")) continue;
      flags.push({ inning: anchor.inning, half: anchor.half, order: anchor.order, rule: "R10", detail: `この回のアウト数(${total})が3を超えています（打席結果の誤読の疑い。エラー出塁がアウトになっていないか確認してください）` });
    }
  }

  // R11(§14.1 研究A): 状態記載(stated_outs/stated_runners=人がノートに書いたチェックサムの転記)と導出盤面の突合。
  //   導出アウト=R10と同じ数え(outsMade)の半イニング内累積(当該打席含む)、導出走者=半イニング先頭から foldRunners で
  //   畳んだ「この打席後」の盤面の非null塁集合＝どちらも既存エンジンの再利用(二重実装しない)。
  //   記載の無い打席(null/未設定)は何もしない＝既存ノートでは完全無発火。記載が片方だけならその片方だけ比較・表記。
  //   自動補正はしない(タグのみ=トラックBの領分)。アウト・走者の両不一致は1フラグにまとめる。承認(resolved rule:R11)はスキップ。
  {
    const OUTS_JP = ["無死", "一死", "二死", "三死"];
    const outsJp = (n: number) => OUTS_JP[n] ?? `${n}死`;
    const BASE_NUM_JP = { "1": "一", "2": "二", "3": "三" } as const;
    const runnersJp = (bases: ("1" | "2" | "3")[]) =>
      bases.length === 0 ? "走者なし" : bases.length === 3 ? "満塁" : `走者${bases.map((b) => BASE_NUM_JP[b]).join("・")}塁`;
    const byHalf11 = new Map<string, PlateAppearance[]>();
    for (const p of doc.plate_appearances) {
      const k = `${p.inning}-${p.half}`;
      (byHalf11.get(k) ?? byHalf11.set(k, []).get(k)!).push(p);
    }
    for (const list of byHalf11.values()) {
      const ordered = [...list].sort((a, b) => a.order - b.order);
      let cum11 = 0; // この打席「後」の累積アウト(当該打席含む)
      let board: Runners = { first: null, second: null, third: null }; // この打席「後」の盤面
      for (const p of ordered) {
        cum11 += outsMade(p);
        board = foldRunners(board, p);
        if (p.stated_outs == null && p.stated_runners == null) continue; // 無記載=完全無発火
        if (resolvedRules(p).has("R11")) continue;
        const stated: string[] = [];
        const derived: string[] = [];
        if (p.stated_outs != null && p.stated_outs !== cum11) {
          stated.push(outsJp(p.stated_outs));
          derived.push(outsJp(cum11));
        }
        if (p.stated_runners != null) {
          const occ = (["1", "2", "3"] as const).filter((b) => board[({ "1": "first", "2": "second", "3": "third" } as const)[b]]);
          const st = [...new Set(p.stated_runners)].sort();
          if (st.join(",") !== occ.join(",")) {
            stated.push(runnersJp(st));
            derived.push(runnersJp(occ));
          }
        }
        if (stated.length) {
          flags.push({ inning: p.inning, half: p.half, order: p.order, rule: "R11", detail: `記載の状態(${stated.join("・")})と導出した盤面(${derived.join("・")})が一致しません（転記の誤読または走者移動の記録漏れの疑い）` });
        }
      }
    }
  }

  // V-E(§11 Phase3): 同一participantが PA由来 と direct を両持ち＝二重計上リスクを弾かずタグ(要確認)で
  //   人へ表面化(黙って合算しない=コンセプト3)。§11 minor で3系統に一般化:
  //     打撃=自軍攻撃halfに打席 / 投手=自軍守備halfで facing(守備位置1) / 守備=自軍守備halfで守備位置1-9に在籍。
  //   純§0試合(PAゼロ・directのみ)は該当集合が全て空＝二重計上のしようがない。承認(rule:V-E)はスキップ。
  // V-F(§11 minor): direct fielding が明示tcを持ち po/a/e の分解と食い違う自己矛盾(例 {po:2,a:1,tc:1})を、
  //   集計側の Math.max で黙って一方へ寄せる前に要確認で人へ表面化する(黙って一つの答えに寄せない=コンセプト3)。
  //   tc単独主張({tc:3}・po/a/e=None)は正当(集計防御b)＝矛盾でない→出さない。承認(rule:V-F)はスキップ。
  //   ※V-E/V-F は時系列最後の打席へ付ける＝純§0(PAゼロ)は付け先が無く現状は表面化できない(下の deviation 参照)。
  if (doc.direct_stats?.length) {
    const rank = (h: Half) => (h === "top" ? 0 : 1);
    const anchorPa = [...doc.plate_appearances].sort((a, b) => a.inning - b.inning || rank(a.half) - rank(b.half) || a.order - b.order).at(-1);
    const resolvedAtAnchor = (rule: string) =>
      !!anchorPa && (anchorPa.annotations ?? []).some((a) => a.type === "resolved" && a.rule === rule);

    // V-E: PA由来集合(打撃/投手/守備)を作り、direct が同系統で両持ちする participant を拾う。
    const kb = kingsBatHalf(doc);
    const paBatters = new Set(doc.plate_appearances.filter((p) => p.half === kb).map((p) => p.batter_id));
    const paPitchers = new Set<string>();
    const paFielders = new Set<string>();
    for (const p of doc.plate_appearances) {
      if (p.half === kb) continue; // 自軍守備half(=相手攻撃)だけに投手/守備が付く
      const pm = posMap(effectiveSnapshot(doc.lineup_snapshots ?? [], p.inning, p.half, p.order));
      const facing = pm.get("1");
      if (facing) paPitchers.add(facing);
      for (const [pos, pid] of pm) if (/^[1-9]$/.test(pos)) paFielders.add(pid);
    }
    const both = [...new Set(
      doc.direct_stats
        .filter((ds) =>
          (ds.batting && paBatters.has(ds.participant_id)) ||
          (ds.pitching && paPitchers.has(ds.participant_id)) ||
          (ds.fielding && paFielders.has(ds.participant_id)))
        .map((ds) => ds.participant_id))];
    if (both.length && anchorPa && !resolvedAtAnchor("V-E")) {
      flags.push({ inning: anchorPa.inning, half: anchorPa.half, order: anchorPa.order, rule: "V-E", detail: `選手(${both.map(nm).join(", ")})が打席記録と個人成績(断片)の両方に記録を持ちます（二重計上の可能性・確認してください）` });
    }

    // V-F: direct fielding の tc 自己矛盾(明示tc ≠ po+a+e)。tc単独主張(po/a/e未記入)は矛盾でない=除外。
    const tcConflict = [...new Set(
      doc.direct_stats
        .filter((ds) => {
          const f = ds.fielding;
          if (!f || f.tc == null) return false;
          const anyPart = f.po != null || f.a != null || f.e != null;
          return anyPart && f.tc !== (f.po ?? 0) + (f.a ?? 0) + (f.e ?? 0);
        })
        .map((ds) => ds.participant_id))];
    if (tcConflict.length && anchorPa && !resolvedAtAnchor("V-F")) {
      flags.push({ inning: anchorPa.inning, half: anchorPa.half, order: anchorPa.order, rule: "V-F", detail: `選手(${tcConflict.map(nm).join(", ")})の守備機会(tc)が刺殺+捕殺+失策の合計と一致しません（どちらが正か確認してください）` });
    }
  }
  return flags;
}

/** 検査結果を annotations に反映(validator起源を置換。AI/手動の注記は触らない)。冪等。
 *  nameOf: detail の人物IDを名前で出すためのリゾルバ(任意)。呼び出し側が buildNameOf(doc, masters) で構築して渡す。 */
export function applyValidation(doc: GameDoc, nameOf?: (id: string) => string): GameDoc {
  const flags = validateGame(doc, nameOf);
  const byKey = new Map<string, GameFlag[]>();
  for (const f of flags) {
    const k = `${f.inning}-${f.half}-${f.order}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(f);
  }
  const pas = doc.plate_appearances.map((pa) => {
    const k = `${pa.inning}-${pa.half}-${pa.order}`;
    const keep = (pa.annotations ?? []).filter((a) => a.source !== "validator");
    const add = (byKey.get(k) ?? []).map((f) => ({ type: "unclear" as const, detail: f.detail, source: "validator" as const, rule: f.rule }));
    const ann = [...keep, ...add];
    if (ann.length === 0 && !pa.annotations) return pa; // 変化なし
    return { ...pa, annotations: ann };
  });
  return { ...doc, plate_appearances: pas };
}

/**
 * 記録(打席のruns＋direct_stats)から両チームの総得点を導出する。home_away 不明なら null。
 * R4(申告スコアとの突合)と、表示側の「申告スコアが無い試合のフォールバック表示」(得点の導出はサーバの仕事)が共用。
 * [§0-C] null得点(得点者不明)もチーム得点として総和に含める。[§0/§11] direct_stats は自軍side＝own に加算。
 */
export function deriveTeamTotals(doc: GameDoc): { own: number; opp: number; ownHalf: Half } | null {
  const ha = doc.game.home_away;
  const ownHalf: Half | null = ha === "away" ? "top" : ha === "home" ? "bottom" : null;
  if (!ownHalf) return null;
  let own = 0, opp = 0;
  for (const pa of doc.plate_appearances) {
    const n = pa.runs?.length ?? 0;
    if (pa.half === ownHalf) own += n; else opp += n;
  }
  for (const ds of doc.direct_stats ?? []) own += ds.batting?.r ?? 0;
  return { own, opp, ownHalf };
}
