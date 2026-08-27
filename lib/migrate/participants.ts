/**
 * [§9.7 移行] 旧形式(接頭辞ID直結) → 参加者ID層(不透明ID) への純関数変換。
 * ここが接頭辞(P/G/O)分類が正当に残る唯一の場所（旧データは接頭辞で身元を符号化しているため、
 * その解読は移行の仕事そのもの）。移行後の稼働コードは接頭辞を一切見ない。
 *
 *  - 自軍side ID(二軸 ownSidePaIds ＋ lineup/roster/出欠/投手記録) を収集 → 不透明ID(m1..)割当。
 *  - P→link:roster / G→link:guest(name必須・無ければハード失敗＝静かな情報喪失を防ぐ)。
 *  - 相手half打席: O数字→ opponent_slot(第一級) へ転記し、IDは side由来プレースホルダ(o1..o9)へ。
 *  - pa.pitcher_id/catcher_id は廃止(投捕はスナップ解決一本)。attendance→participants(在籍=出席)。
 *  - additional_players/attendance/stat_scope/include_in_season は移行後docから消す。
 * 検証(verifyMigration): 数値0差分(旧集計(旧doc)＝新集計(新doc)・全scope・キー翻訳)＋属性突合。
 */
import type {
  GameDoc,
  PlateAppearance,
  Participant,
  AttendanceEntry,
  BaserunMove,
  LineupSnapshot,
} from "@/lib/types/v2";
import { battingTeam, ownSidePaIds } from "@/lib/sides";
import { aggregateGame } from "@/lib/agg";
import { aggregateGameP } from "@/lib/agg/participants";
import { derivePAStates } from "@/lib/ops/gamestate";

export class MigrationError extends Error {
  constructor(public gameId: string, msg: string) {
    super(`[${gameId}] ${msg}`);
    this.name = "MigrationError";
  }
}

export interface MigrationReport {
  game_id: string;
  idMap: Map<string, string>; // 旧own-side ID → 新participant ID
  participants: Participant[];
  attendanceAdded: string[]; // 出欠に無かったが試合データに出現→participantとして補完した旧ID(データ修復・要報告)
  oppSlots: number[]; // 転記した相手打順(検証用)
  runnersNormalized: number; // 保存走者スナップを導出値へ正規化したPA数(書き込み側バグの痕跡修復・要報告)
}

// 旧scopeOf(startsWith("P"))と同じ境界。G判定は助っ人採番(G+数字)のみ
const isP = (id: string) => id.startsWith("P");
const isG = (id: string) => /^G\d/.test(id);
const oppSlotOf = (id: string): number | null => {
  const m = id.match(/^O0*(\d+)$/);
  return m ? Number(m[1]) : null;
};

/** 旧docの自軍side ID全出現を収集（PA二軸＋lineup/roster＋出欠＋投手記録）。 */
function collectOwnIds(doc: GameDoc): string[] {
  const ids = new Set<string>();
  for (const pa of doc.plate_appearances) for (const id of ownSidePaIds(doc, pa)) ids.add(id);
  for (const s of doc.lineup_snapshots ?? []) {
    for (const r of s.roster ?? []) ids.add(r.player_id);
    for (const l of s.lineup ?? []) ids.add(l.player_id);
  }
  for (const a of doc.attendance ?? []) ids.add(a.player_id);
  for (const p of doc.pitching ?? []) ids.add(p.pitcher_id);
  return [...ids];
}

/**
 * 旧doc → 新doc(参加者ID層)。guestNames は旧G-id→実名（現docのadditional_players/バックアップ由来）。
 * 実名が引けないG-idはハード失敗（連番合成へ落とさない＝§9.7）。
 */
export function migrateToParticipants(
  doc: GameDoc,
  guestNames: Map<string, string>
): { doc: GameDoc; report: MigrationReport } {
  const gid = doc.game.id;
  if (doc.participants?.length) throw new MigrationError(gid, "既に participants を持つ(移行済み)");

  // ---- 1) 自軍side ID収集・分類 ----
  const ownIds = collectOwnIds(doc);
  const bad = ownIds.filter((id) => !isP(id) && !isG(id));
  if (bad.length) throw new MigrationError(gid, `自軍side参照に分類不能なID: ${bad.join(", ")}（人手判断が必要）`);

  // ---- 2) 不透明ID割当（決定論: P自然順 → G自然順） ----
  const sorted = [...ownIds.filter(isP).sort(), ...ownIds.filter(isG).sort()];
  const idMap = new Map<string, string>();
  sorted.forEach((old, i) => idMap.set(old, `m${i + 1}`));

  // ---- 3) participants 構築（出欠を畳む） ----
  const att = new Map<string, AttendanceEntry>((doc.attendance ?? []).map((a) => [a.player_id, a]));
  const attendanceAdded: string[] = [];
  const participants: Participant[] = sorted.map((old) => {
    const a = att.get(old);
    if (!a) attendanceAdded.push(old);
    let name: string | undefined;
    if (isG(old)) {
      name = guestNames.get(old);
      if (!name) throw new MigrationError(gid, `助っ人 ${old} の実名が引けない（現doc/バックアップとも無し）。人手入力が必要`);
    }
    // 出欠(在籍)は participant として登録するだけ＝出席。status(played/bench)概念は廃止(在籍=出席)。
    return {
      id: idMap.get(old)!,
      link: isP(old) ? { kind: "roster", player_id: old } : { kind: "guest", name },
    };
  });
  // 出欠のみの参加者（控え/不戦勝など試合データに出ない人）
  for (const a of doc.attendance ?? []) {
    if (idMap.has(a.player_id)) continue;
    if (!isP(a.player_id) && !isG(a.player_id)) throw new MigrationError(gid, `出欠に分類不能なID: ${a.player_id}`);
    const nid = `m${idMap.size + 1}`;
    idMap.set(a.player_id, nid);
    let name: string | undefined;
    if (isG(a.player_id)) {
      name = guestNames.get(a.player_id);
      if (!name) throw new MigrationError(gid, `助っ人 ${a.player_id} の実名が引けない`);
    }
    participants.push({
      id: nid,
      link: isP(a.player_id) ? { kind: "roster", player_id: a.player_id } : { kind: "guest", name },
    });
  }

  const own = (id: string): string => {
    const n = idMap.get(id);
    if (!n) throw new MigrationError(gid, `自軍side参照 ${id} が参加者に割当てられていない(収集漏れ)`);
    return n;
  };
  const opp = (id: string): string => {
    const slot = oppSlotOf(id);
    if (slot === null) throw new MigrationError(gid, `相手攻撃側に想定外のID: ${id}（選手貸し借り等は人手判断）`);
    return `o${slot}`;
  };

  // ---- 4) PA書き換え（二軸: 攻撃側スロット=half攻撃チーム / 守備側スロット=逆） ----
  // 保存走者スナップ(pa.runners)は §9 で廃止(読み手ゼロ・走者は毎回導出が正本。未解決トークン混入の温床だった)。
  // フィールドごと落とす=違法状態を表現不能に。導出値との不一致件数は書き込み側バグの痕跡として報告する。
  const derived = derivePAStates(doc);
  let runnersNormalized = 0;
  const oppSlots: number[] = [];
  const pas: PlateAppearance[] = doc.plate_appearances.map((pa) => {
    const kingsAttack = battingTeam(doc, pa.half) === "kings";
    const atk = kingsAttack ? own : opp; // 攻撃側スロットの写像
    const mv = (m: BaserunMove): BaserunMove => ({ ...m, runner_id: atk(m.runner_id) });
    const startRunners = derived.get(pa)?.runners ?? { first: null, second: null, third: null };
    if (pa.runners && JSON.stringify(startRunners) !== JSON.stringify(pa.runners)) runnersNormalized++;
    const next: PlateAppearance = {
      ...pa,
      batter_id: atk(pa.batter_id),
      runs: (pa.runs ?? []).map((r) => {
        // 責任投手=守備側スロット。自軍守備half(=相手攻撃)なら自軍参照、自軍攻撃halfに相手投手の明示は現データ0件＝出たら人手判断
        let resp = r.responsible_pitcher_id ?? null;
        if (resp) {
          if (kingsAttack) throw new MigrationError(gid, `自軍攻撃halfに相手責任投手の明示 ${resp}（想定外・人手判断）`);
          resp = own(resp);
        }
        return { ...r, runner_id: r.runner_id != null ? atk(r.runner_id) : null, responsible_pitcher_id: resp };
      }),
      baserunning_during: (pa.baserunning_during ?? []).map((ev) => ({
        ...ev,
        runners: (ev.runners ?? []).map(mv),
        fielding: ev.fielding
          ? { ...ev.fielding, outs: (ev.fielding.outs ?? []).map((o) => ({ ...o, runner_id: o.runner_id ? atk(o.runner_id) : o.runner_id })) }
          : ev.fielding,
      })),
      baserunning_after: (pa.baserunning_after ?? []).map(mv),
      fielding: pa.fielding
        ? { ...pa.fielding, outs: (pa.fielding.outs ?? []).map((o) => ({ ...o, runner_id: o.runner_id ? atk(o.runner_id) : o.runner_id })) }
        : pa.fielding,
      pinch_runner: pa.pinch_runner ? { ...pa.pinch_runner, runner_id: atk(pa.pinch_runner.runner_id) } : pa.pinch_runner,
    };
    if (!kingsAttack) {
      const slot = oppSlotOf(pa.batter_id);
      if (slot === null) throw new MigrationError(gid, `相手打者に想定外のID: ${pa.batter_id}`);
      next.opponent_slot = slot;
      oppSlots.push(slot);
    }
    delete next.pitcher_id; // 投捕はスナップ解決一本(§9.2)
    delete next.catcher_id;
    delete next.runners; // 保存走者スナップ廃止(§9.2)
    return next;
  });

  // ---- 5) lineup_snapshots / pitching 書き換え、attendance/additional_players 廃止 ----
  const snaps: LineupSnapshot[] = (doc.lineup_snapshots ?? []).map((s) => ({
    ...s,
    roster: (s.roster ?? []).map(({ stat_scope: _s, include_in_season: _i, ...r }) => ({ ...r, player_id: own(r.player_id) })),
    lineup: (s.lineup ?? []).map((l) => ({ ...l, player_id: own(l.player_id) })),
  }));
  const pitching = (doc.pitching ?? []).map((p) => ({ ...p, pitcher_id: own(p.pitcher_id) }));

  const out: GameDoc = {
    ...doc,
    participants,
    lineup_snapshots: snaps,
    plate_appearances: pas,
    ...(doc.pitching ? { pitching } : {}),
  };
  delete out.attendance;
  delete out.additional_players;

  return { doc: out, report: { game_id: gid, idMap, participants, attendanceAdded, oppSlots, runnersNormalized } };
}

// ---------------------------------------------------------------------------
// 検証（§9.8）: 数値0差分（全scope・キー翻訳）＋属性突合
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  notes: string[]; // 合格だが報告すべき事実(出欠補完など)
}

/** 旧boxの行キー → 新boxの行キー（own=そのまま / guest=game:pid）。 */
function translateKey(gameId: string, idMap: Map<string, string>, oldKey: string): string {
  return isP(oldKey) ? oldKey : `${gameId}:${idMap.get(oldKey) ?? "?"}`;
}

export function verifyMigration(
  oldDoc: GameDoc,
  newDoc: GameDoc,
  report: MigrationReport,
  opts: { masterIds?: Set<string> } = {}
): VerifyResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const gid = oldDoc.game.id;

  // ---- 数値0差分（打撃/投手/守備・全scope・キー翻訳して突き合わせ） ----
  const bOld = aggregateGame(oldDoc);
  const bNew = aggregateGameP(newDoc);
  const canon = (rows: { player_id: string }[]) =>
    JSON.stringify([...rows].sort((a, b) => a.player_id.localeCompare(b.player_id)));
  for (const section of ["batting", "pitching", "fielding"] as const) {
    const oldRows = bOld[section].map((r) => ({ ...r, player_id: translateKey(gid, report.idMap, r.player_id) }));
    const a = canon(oldRows);
    const b = canon(bNew[section]);
    if (a !== b) errors.push(`${section}: 0差分不成立\n  old(翻訳後)=${a}\n  new=${b}`);
  }

  // ---- (a) 新docの自軍side参照が全て participants に包含 ----
  const pids = new Set(report.participants.map((p) => p.id));
  for (const pa of newDoc.plate_appearances) {
    for (const id of ownSidePaIds(newDoc, pa)) {
      if (!pids.has(id)) errors.push(`(a) 自軍side参照 ${id} が participants に無い (${pa.inning}回${pa.half} order${pa.order})`);
    }
  }
  for (const s of newDoc.lineup_snapshots ?? []) {
    for (const r of s.roster ?? []) if (!pids.has(r.player_id)) errors.push(`(a) roster参照 ${r.player_id} が participants に無い`);
    for (const l of s.lineup ?? []) if (!pids.has(l.player_id)) errors.push(`(a) lineup参照 ${l.player_id} が participants に無い`);
  }
  for (const p of newDoc.pitching ?? []) if (!pids.has(p.pitcher_id)) errors.push(`(a) 投手記録参照 ${p.pitcher_id} が participants に無い`);

  // ---- (b) roster link の player_id が選手マスタに実在 ----
  if (opts.masterIds) {
    for (const p of report.participants) {
      if (p.link.kind === "roster" && !opts.masterIds.has(p.link.player_id)) {
        errors.push(`(b) roster link ${p.link.player_id} が選手マスタに無い`);
      }
    }
  }

  // ---- (c) guest名が実名（合成名でない・空でない） ----
  for (const p of report.participants) {
    if (p.link.kind === "guest") {
      const nm = p.link.name ?? "";
      if (!nm || /^助っ人\d*$/.test(nm)) errors.push(`(c) guest ${p.id} の名前が実名でない: "${nm}"`);
    }
  }

  // ---- (d) 旧接頭辞scope ＝ 新link導出scope 全件一致 ----
  for (const [old, nid] of report.idMap) {
    const part = report.participants.find((p) => p.id === nid)!;
    const oldScope = isP(old) ? "own" : "guest";
    const newScope = part.link.kind === "roster" ? "own" : "guest";
    if (oldScope !== newScope) errors.push(`(d) scope不一致: ${old}(${oldScope}) → ${nid}(${newScope})`);
  }

  // ---- 出欠scopeパリティ（旧attendance.scope ＝ participants.link導出scope） ----
  //   status(played/bench)のパリティは廃止(participants在籍=出席・派生概念を持たない)。
  const att = new Map((oldDoc.attendance ?? []).map((a) => [a.player_id, a]));
  for (const [old, nid] of report.idMap) {
    const part = report.participants.find((p) => p.id === nid)!;
    const a = att.get(old);
    if (a) {
      const derived = part.link.kind === "roster" ? "own" : "guest";
      if (a.scope !== derived) errors.push(`出欠scope不一致: ${old} 旧${a.scope} → 導出${derived}`);
    }
  }
  if (report.attendanceAdded.length) notes.push(`出欠補完(試合データに出現・出欠に無し): ${report.attendanceAdded.join(", ")}`);
  if (report.runnersNormalized > 0) notes.push(`保存走者スナップ廃止(うち導出値と不一致=書き込み側バグ痕跡: ${report.runnersNormalized}打席)`);

  // ---- 相手打順の転記検証: 新opponent_slot ＝ 旧O数字 ----
  const oldOpp = oldDoc.plate_appearances.filter((p) => battingTeam(oldDoc, p.half) !== "kings");
  const newOpp = newDoc.plate_appearances.filter((p) => battingTeam(newDoc, p.half) !== "kings");
  if (oldOpp.length !== newOpp.length) errors.push(`相手PA数不一致: ${oldOpp.length} → ${newOpp.length}`);
  for (let i = 0; i < Math.min(oldOpp.length, newOpp.length); i++) {
    const want = oppSlotOf(oldOpp[i].batter_id);
    if (newOpp[i].opponent_slot !== want) {
      errors.push(`opponent_slot不一致 (${oldOpp[i].inning}回${oldOpp[i].half} order${oldOpp[i].order}): 旧${oldOpp[i].batter_id}→期待${want} 実際${newOpp[i].opponent_slot}`);
    }
  }

  // ---- 廃止フィールドの残存チェック ----
  if (newDoc.attendance) errors.push("attendance が残存");
  if (newDoc.additional_players) errors.push("additional_players が残存");
  for (const pa of newDoc.plate_appearances) {
    if (pa.pitcher_id !== undefined) errors.push(`pitcher_id 残存 (${pa.inning}回${pa.half} order${pa.order})`);
    if (pa.catcher_id !== undefined) errors.push(`catcher_id 残存 (${pa.inning}回${pa.half} order${pa.order})`);
    if (pa.runners !== undefined) errors.push(`runners(保存走者スナップ) 残存 (${pa.inning}回${pa.half} order${pa.order})`);
  }
  for (const s of newDoc.lineup_snapshots ?? []) {
    for (const r of s.roster ?? []) {
      if (r.stat_scope !== undefined || r.include_in_season !== undefined) errors.push("roster死フラグ残存");
    }
  }

  return { ok: errors.length === 0, errors, notes };
}
