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
import { outsMade, effectiveSnapshot, posMap } from "@/lib/agg";

const EMPTY: Runners = { first: null, second: null, third: null };
const halfRank = (h: Half) => (h === "top" ? 0 : 1);

/** baserunning の移動を塁状態へ適用(冪等＝到達前にその走者を全塁から外すので二重置きしない) */
function applyMoves(r: Runners, moves: BaserunMove[]): Runners {
  const bases: Record<string, string | null> = { "1": r.first, "2": r.second, "3": r.third };
  for (const m of moves) {
    // 走者不明(null)の移動は盤面に適用しない。null=空塁の表現なので置くと実在走者を消す。
    // AIの冗長/不明記録から盤面を守る防波堤(後処理の決定性の担保)。真の不明は runs の null と R1 が引き受ける。
    if (m.runner_id == null) continue;
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

/** 「バッターランナー」等の打者参照(モデルが batter/打者走者 と書いてもよい)。resolveBaserunningIds と splitAfterMoves で共用 */
const batterRef = (v?: string | null) => !!v && /^(batter|打者|打者走者|バッターランナー|b)$/i.test(v);

/**
 * baserunning_after を「先行走者の移動」と「打者自身の追加進塁」に分ける(元配列の相対順は保持)。
 * ★物理順(2026-08 修正)の心臓部: 野球の物理は「先行走者が先に進み、打者走者は後から塁に収まる」。
 * 導出4関数(foldRunners/deriveScorers/deriveRuns/resolveBaserunningIds)がこの1つの判定を共用する
 * =二重実装で判定がズレるのを構造で防ぐ。判定: from か runner_id が打者参照、または runner_id が打者ID
 * → 打者自身。それ以外(from:null の不明移動を含む)→ 先行走者。
 */
export function splitAfterMoves(pa: PlateAppearance): { runnerMoves: BaserunMove[]; batterMoves: BaserunMove[] } {
  const runnerMoves: BaserunMove[] = [];
  const batterMoves: BaserunMove[] = [];
  for (const m of pa.baserunning_after ?? []) {
    if (batterRef(m.from) || batterRef(m.runner_id) || m.runner_id === pa.batter_id) batterMoves.push(m);
    else runnerMoves.push(m);
  }
  return { runnerMoves, batterMoves };
}

/** 代走(§10.3 本対応): 打席開始時に盤面の走者を置換(for_base優先、無ければreplaced_idの居る塁)。
 * 対象不明/空塁は何もしない=旧データ(対象情報なし)は表示のみの互換。 */
function applyPinch(r: Runners, pa: PlateAppearance): Runners {
  const pr = pa.pinch_runner;
  if (!pr?.runner_id) return r;
  const bases: Record<string, string | null> = { "1": r.first, "2": r.second, "3": r.third };
  let base = pr.for_base ?? null;
  if (!base && pr.replaced_id) {
    for (const b of ["1", "2", "3"] as const) if (bases[b] === pr.replaced_id) { base = b; break; }
  }
  if (!base || !bases[base]) return r;
  bases[base] = pr.runner_id;
  return { first: bases["1"], second: bases["2"], third: bases["3"] };
}

/** その走者が盤面(塁上)に実在するか。幽霊得点の締め付け(§10.3)に使う。 */
function onBoard(r: Runners, id: string): boolean {
  return r.first === id || r.second === id || r.third === id;
}

/**
 * 1打席後の塁状態を「結果」から導出する(=エンジンが構造を所有)。
 *  - 打者は結果に応じて塁へ(H1/BB/HBP/E/FC/CI→一塁, H2→二塁, H3→三塁, HR→生還)。
 *  - 四死球・単打・出塁系は強制進塁を自動(満塁押し出し含む)。四死球は強制のみ(明示afterは使わない)。
 *  - 非強制の進塁(安打での余分な進塁・盗塁(during)・エラー時の進塁)は明示分(after/during)を適用。
 * これにより「四球と書くだけで走者が正しく進む」。打者本人の出塁忘れで走者がズレることが無くなる。
 */
export function foldRunners(before: Runners, pa: PlateAppearance): Runners {
  let r = applyPinch(before, pa); // 代走の走者置換(打席開始時)
  for (const ev of pa.baserunning_during ?? []) r = applyMoves(r, ev.runners ?? []); // 盗塁等(打席中)
  if (pa.result === "HR") return EMPTY; // 全員生還
  if (pa.result === "BB" || pa.result === "HBP") {
    r = applyForce(r, pa.batter_id); // 強制進塁(満塁押し出し含む)
    // [クラスタB1] 四死球でも明示の baserunning_after を反映する(送球逸れ等での余分な進塁/生還=人/AIが明示した事実)。
    //   強制押し出しは上の applyForce で済ませ済み＝after はその後の非強制進塁のみ。強制で盤面から消えた走者が
    //   after にも居ても applyMoves は冪等(現在塁を空けてから置く)なので二重反映しない。§10.3の「四死球はafterを無視」は撤回。
    return applyMoves(r, pa.baserunning_after ?? []);
  }
  // ★物理順(2026-08 修正): 先行走者のafter → 打者の自動配置 → 打者自身のafter の順で適用する。
  //   野球の物理は「先行走者が先に進み、打者走者は後から塁に収まる」。打者を先に置くと、打者の到達塁
  //   (H2の二塁等)に居る先行走者(after で生還/進塁するはずの走者)を applyMoves の到達塁代入が上書きで消していた。
  const { runnerMoves, batterMoves } = splitAfterMoves(pa);
  r = applyMoves(r, runnerMoves); // 先行走者の移動(生還含む)を先に
  // FORCE系(H1/E/CI)で先行走者のafterを先に適用してから applyForce しても二重進塁は起きない:
  //   applyForce は一塁が空(=afterで既に進んだ)なら押し出しをせず、applyMoves は冪等(現在塁を空けてから置く)。
  const dest = destForResult(pa.result);
  if (FORCE.has(pa.result)) r = applyForce(r, pa.batter_id);
  else if (dest === "2" || dest === "3") r = applyMoves(r, [{ runner_id: pa.batter_id, from: null, to: dest }]);
  else if (dest === "1") r = applyMoves(r, [{ runner_id: pa.batter_id, from: null, to: "1" }]); // FC(打者は一塁、走者除去はafterで)
  return applyMoves(r, batterMoves); // 打者自身の追加進塁(配置後=結果を超える進塁)
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
  const start = applyPinch(before, pa); // 代走の走者置換(打席開始時)
  if (pa.result === "HR") {
    for (const id of [start.third, start.second, start.first]) if (id) out.push(id);
    out.push(pa.batter_id);
    return [...new Set(out)];
  }
  let r = start;
  for (const ev of pa.baserunning_during ?? []) {
    // 幽霊得点の締め付け(§10.3): 盤面に実在する走者だけが生還できる。
    // runner_id==null は除外(onBoard(r,null)は空塁にマッチ=不明走者を実在扱いしてR1を誤発火させない)
    for (const m of ev.runners ?? []) if (m.to === "home" && m.runner_id != null && onBoard(r, m.runner_id)) out.push(m.runner_id);
    r = applyMoves(r, ev.runners ?? []);
  }
  if (pa.result === "BB" || pa.result === "HBP") {
    if (r.first && r.second && r.third) out.push(r.third); // 満塁押し出し(強制)で三塁走者が生還
    // [クラスタB1] 四死球でも明示 baserunning_after の生還を拾う。check側は onBoard 維持(盤面感応)＝
    //   fill側 deriveRuns(onBoard不問)との差を R1 が flag する非対称(§10.6)。強制で還った走者は applyForce で
    //   盤面から消える → onBoard ゲートが二重計上を防ぐ。
    r = applyForce(r, pa.batter_id);
    for (const m of pa.baserunning_after ?? []) {
      if (m.to === "home" && m.runner_id != null && onBoard(r, m.runner_id)) out.push(m.runner_id);
      r = applyMoves(r, [m]);
    }
    return [...new Set(out)];
  }
  // ★物理順(2026-08 修正): 先行走者のafterを先に検査・適用する。打者を先に置くと打者の到達塁に居た
  //   先行走者が盤面から消え、onBoard ゲートが生還を拾えなくなっていた(生還者0人化=R1誤発火)。
  //   onBoard 判定は「その移動を適用する直前の盤面」に対して行う逐次方式(従来どおり)。
  const { runnerMoves, batterMoves } = splitAfterMoves(pa);
  for (const m of runnerMoves) {
    if (m.to === "home" && m.runner_id != null && onBoard(r, m.runner_id)) out.push(m.runner_id);
    r = applyMoves(r, [m]);
  }
  // 打者を結果に応じて配置してから打者自身のafterを検査(打者自身の生還=ランニング本塁打等も盤面実在で判定)
  if (FORCE.has(pa.result)) r = applyForce(r, pa.batter_id);
  else {
    const dest = destForResult(pa.result);
    if (dest && dest !== "home") r = applyMoves(r, [{ runner_id: pa.batter_id, from: null, to: dest }]);
  }
  for (const m of batterMoves) {
    if (m.to === "home" && m.runner_id != null && onBoard(r, m.runner_id)) out.push(m.runner_id);
    r = applyMoves(r, [m]);
  }
  return [...new Set(out)];
}

type Cause = RunEvent["cause"];
const causeFromEvent = (event: string): Cause => {
  const e = (event ?? "").toUpperCase();
  return e === "WP" ? "wp" : e === "PB" ? "pb" : e === "SB" ? "sb" : e === "BK" ? "bk" : "other";
};
/** [クラスタB1] 四死球中の非強制 after 進塁の要因を move.reason 文字列から推定(既知イベント語を拾い、無ければ other)。 */
const causeFromReason = (reason?: string | null): Cause => (reason ? causeFromEvent(reason) : "other");
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
 * この打席の runs[](得点の正本)を、開始時走者と結果から導出する。
 * 「誰が・どの要因で還ったか」を出し、rbi/earned/cause まで決める＝AIは runs を出さない。
 *  - rbi: 打者の打撃/押し出しでの生還は true。エラー・暴投・捕逸・盗塁での生還は false。
 *  - earned: 近似(エラー要因のみ false)。正本は doc.pitching の明示値で上書きされる。
 * [§10.6 非対称onBoard=非破壊fill] 明示された生還(to:home)は盤面に走者が実在しなくても runs[] に保持する
 *   (盤面不在を理由に黙って落とさない)。盤面との食い違いは check側 deriveScorers(onBoard維持)との差で R1 が flag する。
 *   HR/満塁押し出しの盤面ロジックは維持。生成する RunEvent は origin="auto"(=一度きりの導出fill・上書き可)。
 */
export function deriveRuns(before: Runners, pa: PlateAppearance): RunEvent[] {
  const out: RunEvent[] = [];
  const seen = new Set<string>();
  const add = (runner_id: string, cause: Cause) => {
    if (!runner_id || seen.has(runner_id)) return;
    seen.add(runner_id);
    out.push({ runner_id, rbi: RBI_CAUSE.has(cause), earned: cause !== "error", cause, origin: "auto" });
  };
  // [クラスタB1] 四死球中の非強制の余分生還(送球逸れ等)。打者の打撃結果ではない → rbi=false・打点を付けない。
  //   自責は不明 → earned=null(runner_id=null/自責不明 と平行=捏造しない)。origin:auto=一度きり導出fill(上書き可)。
  const addExtra = (runner_id: string, cause: Cause) => {
    if (!runner_id || seen.has(runner_id)) return;
    seen.add(runner_id);
    out.push({ runner_id, rbi: false, earned: null, cause, origin: "auto" });
  };
  const start = applyPinch(before, pa); // 代走の走者置換(打席開始時)
  if (pa.result === "HR") {
    for (const id of [start.third, start.second, start.first]) if (id) add(id, "hr");
    add(pa.batter_id, "hr");
    return out;
  }
  let r = start;
  for (const ev of pa.baserunning_during ?? []) {
    // [§10.6] 明示 to:home は盤面不在でも保持(非破壊fill)。onBoardゲートは撤去。
    for (const m of ev.runners ?? []) if (m.to === "home") add(m.runner_id, causeFromEvent(ev.event));
    r = applyMoves(r, ev.runners ?? []);
  }
  if (pa.result === "BB" || pa.result === "HBP") {
    // 標準の満塁押し出し得点(強制)は従来どおり cause=walk/hbp・rbi=true・earned近似(自明clear)。
    if (r.first && r.second && r.third) add(r.third, pa.result === "BB" ? "walk" : "hbp");
    // [クラスタB1] 四死球でも明示 baserunning_after の生還を非破壊fillで保持(§10.6: onBoard不問=盤面不在でも落とさない)。
    //   強制で還った走者は上の add で seen 済み=二重計上しない。要因は move.reason があればそれ、無ければ other。
    r = applyForce(r, pa.batter_id);
    for (const m of pa.baserunning_after ?? []) {
      if (m.to === "home") addExtra(m.runner_id, causeFromReason(m.reason));
      r = applyMoves(r, [m]);
    }
    return out;
  }
  // ★物理順(2026-08 修正): 先行走者のafter → 打者配置 → 打者自身のafter(check側 deriveScorers と同順)。
  //   fill側の to:home 拾いは onBoard 不問(§10.6 非破壊fill=非対称)のままなので件数は不変だが、
  //   盤面 r の進め方と runs[] の並び(先行走者が先)を check側・foldRunners と揃える。
  const { runnerMoves, batterMoves } = splitAfterMoves(pa);
  for (const m of runnerMoves) {
    // [§10.6] 明示 to:home は盤面不在でも保持(非破壊fill)。onBoardゲートは撤去。
    if (m.to === "home") add(m.runner_id, causeFromResult(pa.result));
    r = applyMoves(r, [m]);
  }
  if (FORCE.has(pa.result)) r = applyForce(r, pa.batter_id);
  else {
    const dest = destForResult(pa.result);
    if (dest && dest !== "home") r = applyMoves(r, [{ runner_id: pa.batter_id, from: null, to: dest }]);
  }
  for (const m of batterMoves) {
    // [§10.6] 打者自身の明示生還(ランニング本塁打等)も盤面不在で落とさない(非破壊fill)。
    if (m.to === "home") add(m.runner_id, causeFromResult(pa.result));
    r = applyMoves(r, [m]);
  }
  return out;
}

/**
 * [§0/§11 非破壊] runs[] 再導出時に人の明示した得点(origin:"manual")を保全してマージする。
 * deriveRuns の結果(origin:"auto"・一度きりの導出fill)へ、前バージョンPAの manual run を結合する
 *  ＝スイープ/編集の再導出で「得点(走者不明)」等の明示runが黙って消えないようにする。
 *  - runner_id=null(得点者不明)の manual run は常に保持(キー無し=重複判定不能=常に加える)。
 *  - runner_id 付き manual run は同じ runner_id の auto run が無い時のみ加える(重複計上を回避)。
 */
export function mergeManualRuns(autoRuns: RunEvent[], prevRuns?: RunEvent[] | null): RunEvent[] {
  const manual = (prevRuns ?? []).filter((r) => r.origin === "manual");
  if (!manual.length) return autoRuns;
  const autoKeys = new Set(autoRuns.filter((r) => r.runner_id != null).map((r) => r.runner_id));
  const out = [...autoRuns];
  for (const m of manual) {
    if (m.runner_id == null || !autoKeys.has(m.runner_id)) out.push(m);
  }
  return out;
}

/**
 * [§10.6 read用共有導出] 相手攻撃half(=自軍守備)で各得点の責任投手を導出する。集計(agg)と検査(validate)が
 * 同一規則を使うための唯一の切り出し(二重定義の乖離防止)。規則:
 *  - 各走者は「出塁した打席」時点の投手(有効スナップショットの守備位置1=集計 facing と同一)に帰属(reachPitcher)。
 *  - 代走は交代対象走者の責任投手を引き継ぐ。継投跨ぎでも後投手へ誤帰属しない。
 *  - doc.run_overrides(manual=人の明示)が最優先で上書きする(null=明示クリア)。
 * 返り値: PA → (runner_id → responsible participant_id)。自軍攻撃half(相手投手=非追跡)のPAは含まない。
 */
export function deriveResponsiblePitchers(doc: GameDoc): Map<PlateAppearance, Map<string, string>> {
  const result = new Map<PlateAppearance, Map<string, string>>();
  const kb = kingsBatHalf(doc);
  const snaps = doc.lineup_snapshots ?? [];
  const overrides = new Map<string, string | null>(); // `${pa_id}::${runner_id}` → pitcher(null=明示クリア)
  for (const ov of doc.run_overrides ?? []) if (ov.pa_id) overrides.set(`${ov.pa_id}::${ov.runner_id}`, ov.responsible_pitcher_id ?? null);
  const byHalf = new Map<string, PlateAppearance[]>();
  for (const pa of doc.plate_appearances) {
    if (pa.half === kb) continue; // 自軍攻撃=相手投手=非追跡
    const k = `${pa.inning}-${pa.half}`;
    (byHalf.get(k) ?? byHalf.set(k, []).get(k)!).push(pa);
  }
  for (const list of byHalf.values()) {
    const ordered = [...list].sort((a, b) => a.order - b.order);
    let board: Runners = EMPTY;
    const reach = new Map<string, string>(); // 走者ID→出塁時の投手
    for (const pa of ordered) {
      const facing = posMap(effectiveSnapshot(snaps, pa.inning, pa.half, pa.order)).get("1") ?? null;
      const pr = pa.pinch_runner;
      if (pr?.runner_id) {
        const forBase: Record<string, string | null> = { "1": board.first, "2": board.second, "3": board.third };
        const replaced = pr.replaced_id ?? (pr.for_base ? forBase[pr.for_base] : null);
        if (replaced && reach.has(replaced)) reach.set(pr.runner_id, reach.get(replaced)!);
      }
      if (facing && pa.batter_id) reach.set(pa.batter_id, facing);
      const m = new Map<string, string>();
      for (const run of pa.runs ?? []) {
        if (run.runner_id == null) continue; // [§0-C] 得点者不明はrunner_idキーの責任mapに載せない。消費側(agg/validate)がfacingへ帰属
        const key = pa.id ? `${pa.id}::${run.runner_id}` : null;
        let resp: string | null | undefined;
        // 手動override(人の明示)が最優先(null=明示クリア)。次に保存値(旧/明示・移行後は空)→出塁時投手(reach)→当該打席投手(facing)。
        if (key && overrides.has(key)) resp = overrides.get(key);
        else resp = run.responsible_pitcher_id ?? reach.get(run.runner_id) ?? facing;
        if (resp) m.set(run.runner_id, resp);
      }
      result.set(pa, m);
      board = foldRunners(board, pa);
    }
  }
  return result;
}

const baseOccupant = (r: Runners, base?: string | null): string | null =>
  base === "1" ? r.first : base === "2" ? r.second : base === "3" ? r.third : null;

/**
 * 走塁(during/after)の runner_id を「from の塁に実在する走者」で確定する(=状態依存をエンジンが吸収)。
 * モデルは from/to の塁だけ言えばよく、誰かは盤面が決める → 走者取り違えが構造的に消え、バッチ/bulk でも崩れない。
 * 盤面は foldRunners と同順(during → 先行走者のafter → 打者の自動配置 → 打者自身のafter)で進める。
 */
export function resolveBaserunningIds(start: Runners, pa: PlateAppearance, opts: { respectIds?: boolean } = {}): PlateAppearance {
  const start0 = applyPinch(start, pa); // 代走の走者置換(打席開始時)
  let r = start0;
  // 得点(to:home)の走者は「開始時の走者を本塁に近い順」で割り当てる(打者は除く)。
  // 強制進塁で打者が前に出て盤面がずれても、生還者は元の走者から正しく選ぶ(打者を誤って得点にしない)。
  const queue = [start0.third, start0.second, start0.first].filter((id): id is string => !!id && id !== pa.batter_id);
  const takeScorer = (from?: string | null): string | null => {
    const at = baseOccupant(start0, from);
    if (at) { // from が示す開始塁の走者(打者本人＝内野安打等で本塁まで、はそのまま)
      const i = queue.indexOf(at);
      if (i >= 0) queue.splice(i, 1);
      return at;
    }
    return queue.length ? queue.shift()! : null; // from不明なら本塁に近い走者から
  };
  // 打者参照(batter/打者走者 等)は module 上部の batterRef(splitAfterMoves と共用)で判定し打者IDに解決する
  const dropQueue = (id: string) => { const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1); };
  const fix = (m: BaserunMove): BaserunMove => {
    const from = batterRef(m.from) || m.from === "unknown" ? null : m.from;
    // §10.3 尊重ポリシー(respectIds=スイープ専用): 保存IDが盤面(または打者)に実在すれば尊重し上書きしない(明示記録の保全)。
    // 追加/編集の新規入力(既定)は従来どおり盤面から解決=AIの走者IDを信用しない(得点者取り違えの構造的排除)。
    let id: string;
    if (batterRef(m.from) || batterRef(m.runner_id)) id = pa.batter_id;
    else if (opts.respectIds && m.runner_id && (onBoard(r, m.runner_id) || m.runner_id === pa.batter_id)) {
      id = m.runner_id;
      if (m.to === "home") dropQueue(id); // 生還者キューの二重割当を防ぐ
    } else id = m.to === "home" ? (takeScorer(from) ?? m.runner_id) : (baseOccupant(r, from) ?? m.runner_id);
    const fixed = { ...m, from, runner_id: id };
    r = applyMoves(r, [fixed]);
    return fixed;
  };
  const during = (pa.baserunning_during ?? []).map((ev) => ({ ...ev, runners: (ev.runners ?? []).map(fix) }));
  const afterSrc = pa.baserunning_after ?? [];
  let after: BaserunMove[];
  if (pa.result === "HR") {
    r = EMPTY;
    after = afterSrc.map(fix);
  } else if (pa.result === "BB" || pa.result === "HBP") {
    // 四死球分岐は不変(クラスタB1): 強制押し出しの後に after を並び順どおり解決する
    r = applyForce(r, pa.batter_id);
    after = afterSrc.map(fix);
  } else {
    // ★物理順(2026-08 修正): 先行走者のafterを先に解決 → 打者配置 → 打者自身のafterを解決。
    //   打者を先に置くと from塁の在塁者解決(baseOccupant)が打者を誤って掴んでいた(参照フレームずれ)。
    //   保存配列は元の並び順のまま再構成する(順序の意味付けは導出関数が読む時に課す。保存形式は変えない)。
    //   respectIds(スイープ)経路も fix() 内の分岐なので同順序で通る。
    const { runnerMoves, batterMoves } = splitAfterMoves(pa);
    const fixedRunner = runnerMoves.map(fix);
    if (FORCE.has(pa.result)) r = applyForce(r, pa.batter_id);
    else {
      const dest = destForResult(pa.result);
      if (dest && dest !== "home") r = applyMoves(r, [{ runner_id: pa.batter_id, from: null, to: dest }]);
    }
    const fixedBatter = batterMoves.map(fix);
    // splitAfterMoves は元配列の相対順を保つ partition なので、先頭一致で消費すれば元の並び順に戻る
    let ri = 0, bi = 0;
    after = afterSrc.map((m) => (ri < runnerMoves.length && runnerMoves[ri] === m ? fixedRunner[ri++] : fixedBatter[bi++]));
  }
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
 *  - half: 明示 > side(呼び出し側が参加者メンバーシップで判定＝IDの接頭辞は見ない) > 直前の打席と同じ > top
 *  - 回: 明示 > 直前と同じ側なら直前の回(継続) / 側が替わったらその側の最大回+1
 *    (アウト数では切らない。側の交代＝別の半イニング)
 */
export function resolvePATarget(doc: GameDoc, opts: { inning?: number; half?: Half; side?: "kings" | "opponent" }): PATarget {
  const last = lastPA(doc);
  const sideHalf = opts.side === "kings" ? kingsBatHalf(doc) : opts.side === "opponent" ? oppBatHalf(doc) : undefined;
  const half = opts.half ?? sideHalf ?? last?.half ?? "top";
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
  opponent_slot: number | null; // 相手打順(1..9)。§9: 相手は身元非追跡＝この位置だけ追う
  batter_id: string | null; // 自動推定(自軍=打順の参加者, 相手=side由来プレースホルダ o1..o9)。指定があれば呼び出し側で上書き
}

/** (inning, half) に次の打席を足すときの構造フィールドを導出(アウトは無上限で積む)。
 * §10.3: 次打者は「最後の打席のスロットの次」を基準に、その時点の有効スナップショット(打順変更・交代に追従)で解決する。
 * 未完了(INC)の打席の次は同スロットの再打席。スロットに欠員(退場等)が出た場合は次の実在スロットへ進める。 */
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
    // 有効スナップショット(この打席時点)の打順スロット。打順変更・途中交代に追従(先頭スナップショット固定をやめる §10.3)
    const snap = effectiveSnapshot(doc.lineup_snapshots ?? [], inning, half, order);
    const slots = [...(snap?.lineup ?? [])].filter((e) => e.order != null).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (!slots.length) return { order, outs, runners, batting_slot: null, opponent_slot: null, batter_id: null };
    const maxOrder = Math.max(...slots.map((s) => s.order ?? 0));
    const sameHalfPAs = [...doc.plate_appearances].filter((p) => p.half === half).sort(chrono);
    const last = sameHalfPAs.at(-1);
    let slotNo: number;
    if (last?.batting_slot != null) {
      const incomplete = last.complete === false || last.result === "INC"; // 未完了=同打者の再打席
      slotNo = incomplete ? last.batting_slot : (last.batting_slot % maxOrder) + 1;
    } else if (last) {
      slotNo = ((sameHalfPAs.length % slots.length) + 1); // 旧データ(スロット未保存)のフォールバック=通算件数ローテ
    } else {
      slotNo = slots[0].order ?? 1;
    }
    // 欠員スキップ: そのスロットが現スナップショットに無ければ次の実在スロットへ(最大一巡)
    let slot = slots.find((s) => s.order === slotNo) ?? null;
    for (let hop = 0; !slot && hop < maxOrder; hop++) {
      slotNo = (slotNo % maxOrder) + 1;
      slot = slots.find((s) => s.order === slotNo) ?? null;
    }
    return { order, outs, runners, batting_slot: slot?.order ?? null, opponent_slot: null, batter_id: slot?.player_id ?? null };
  }
  // 相手の攻撃: 打順位置(1..9)を順繰りに。IDは side由来プレースホルダ(o+位置)＝身元は追跡しない(§9)。
  // 基準は最後の相手打席の opponent_slot(修正に追従)。未保存(旧データ)は通算件数ローテ。
  const oppPAs = [...doc.plate_appearances].filter((p) => p.half !== kingsBatHalf(doc)).sort(chrono);
  const lastOpp = oppPAs.at(-1);
  let pos: number;
  if (lastOpp?.opponent_slot != null) {
    const incomplete = lastOpp.complete === false || lastOpp.result === "INC";
    pos = incomplete ? lastOpp.opponent_slot : (lastOpp.opponent_slot % 9) + 1;
  } else {
    pos = (oppPAs.length % 9) + 1;
  }
  return { order, outs, runners, batting_slot: null, opponent_slot: pos, batter_id: `o${pos}` };
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
    let cumOuts = 0;
    ordered.forEach((pa, i) => {
      // 走者は結果から導出(保存値を使わない＝過去の壊れ走者も直る)。
      // [§10.6] アウトは主張値(pa.outs=number)を優先し、未主張(null/未設定)のみ累積(outsMade)で導出。
      //   人が明示した4-5アウト回/DP等の保存値は非破壊で保持。null戻し済み(移行)の自動値は毎回導出。
      out.set(pa, { outs: pa.outs ?? cumOuts, runners, order: i + 1 });
      cumOuts += outsMade(pa);
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
