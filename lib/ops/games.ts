/**
 * 試合データの操作レイヤ。Atlas を正本に書き込む。管理UIとAI入力の双方がこれを呼ぶ。
 * 入力はWebで完結させる(ノート=AI集計・スコア入力・手修正)。JSON取込はWeb機能ではない
 * (旧形式データの移行は scripts/import_game.ts＝単独のマイグレーションスクリプト)。
 */
import { loadGames, loadGame, loadWorking, commitGameDoc, discardDrafts, draftGameIds, loadVersion, publicGen, currentGen, deleteGameCompletely, GenConflictError } from "@/lib/db/games";
import { clearNote } from "@/lib/db/notes";
import { loadPlayers, loadPlayerMap, deletePlayer } from "@/lib/db/players";
import { createGuestPlayer } from "./players";
import { docNameResolver } from "@/lib/names";
import { applyValidation } from "./validate";
import { gameState, deriveNextPA, kingsBatHalf, lineupSlots, resolvePATarget, deriveRuns, foldRunners, resolveBaserunningIds, mergeManualRuns } from "./gamestate";
import { outsMade, effectiveSnapshot, posMap } from "@/lib/agg";
import { ownSidePaIds } from "@/lib/sides";
import type {
  GameDoc, Game, GameResult, EditSource, VersionInput, Half, PlateAppearance,
  ResultCode, Fielding, RunEvent, BaserunMove, BaserunDuring, Annotation, PositionId,
  LineupSnapshot, LineupEntry, RosterEntry, Participant, PitchingRecord, Runners, RunOverride,
  DirectStatLine, DirectBatting, DirectPitching, DirectFielding,
} from "@/lib/types/v2";

// ===== 新規試合IDの採番 =====
// 試合IDは不透明な一意キー(値を解析しない)。GitHubの短縮commit hash風の短い16進ランダムにする。
// 旧データの日付ベースID("G20260614")も、この新hexID("3f8a2c9e1b")も、どちらも有効(検証は URLセーフのみ強制)。

/** 短い16進ランダムID(10桁)を1つ生成する。crypto はサーバ(Node)/テスト(vitest)双方でグローバル利用可。 */
export function generateGameId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 衝突しない新規試合IDを採番する。生成→公開版(loadGame)に既存が無いか確認→在れば再生成(数回リトライ)。
 * gen は差し替え可能(テストで衝突経路を検証するため。既定=generateGameId)。
 */
export async function newGameId(gen: () => string = generateGameId): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const id = gen();
    if (!(await loadGame(id))) return id;
  }
  throw new Error("試合IDの採番に失敗しました(衝突が続きました)");
}

/** コミットの共通オプション。UI=既定(admin/manual/非draft)、AI=draft:true＋edit_source/input を渡す。 */
export interface CommitOpts {
  source?: string; // updated_by (当面 admin)
  draft?: boolean;
  base_gen?: number;
  edit_source?: EditSource; // どの機能で編集したか(既定 manual)
  input?: VersionInput | null; // その版を生んだ変更リソース(正本)
  replace?: boolean; // true=メタだけ残しクリアした状態から積む(AI集計=全置換)。1版で丸ごと差し替える
}
const co = (o: CommitOpts) => ({
  source: o.source ?? "admin",
  draft: o.draft ?? false,
  base_gen: o.base_gen,
  edit_source: o.edit_source ?? ("manual" as EditSource),
  input: o.input ?? null,
});

/** 一覧用に各試合のメタ(game)だけ返す */
export async function listGameMeta(): Promise<Game[]> {
  const games = await loadGames();
  return games.map((d) => d.game).sort((a, b) => b.date.localeCompare(a.date));
}

/** AI入力の選択肢用: 公開試合＋下書きのみの試合(未公開)を、下書きフラグ付きで返す。 */
export async function listGamesForChat(): Promise<{ id: string; date: string; opponent: string; draft: boolean }[]> {
  const published = await loadGames();
  const pubIds = new Set(published.map((d) => d.game.id));
  const drafts = new Set(await draftGameIds());
  const out = published.map((d) => ({ id: d.game.id, date: d.game.date, opponent: d.game.opponent, draft: drafts.has(d.game.id) }));
  for (const id of drafts) {
    if (pubIds.has(id)) continue; // 公開済みは上で出している
    const w = await loadWorking(id);
    if (w) out.push({ id, date: w.doc.game.date, opponent: w.doc.game.opponent, draft: true });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// ===== 参加者(§9)ヘルパ =====
// participants = 試合の人リスト = 出欠。全試合データはこの不透明IDを参照する(打席データと選手マスタを疎結合に)。

/** 試合ローカルの参加者IDを採番(m1..)。不透明＝意味を持たせない。 */
function nextParticipantId(parts: Participant[]): string {
  let mx = 0;
  for (const p of parts) {
    const m = /^m(\d+)$/.exec(p.id);
    if (m) mx = Math.max(mx, Number(m[1]));
  }
  return `m${mx + 1}`;
}

/** V-B: 同一試合で複数参加者が同じ選手(マスタ)を指すのを禁止(シーズン二重計上の構造的防止)。 */
export function assertNoDuplicateRoster(parts: Participant[]): void {
  const seen = new Map<string, string>();
  for (const p of parts) {
    if (p.link.kind !== "roster") continue;
    const dup = seen.get(p.link.player_id);
    if (dup) throw new Error(`選手 ${p.link.player_id} が同一試合に複数の参加者として登録されています(二重計上防止)`);
    seen.set(p.link.player_id, p.id);
  }
}

/** 試合データ(打席/lineup/投手記録)が参照している参加者ID集合。削除ガードに使う。 */
function referencedParticipantIds(doc: GameDoc): Set<string> {
  const s = new Set<string>();
  for (const pa of doc.plate_appearances) for (const id of ownSidePaIds(doc, pa)) s.add(id);
  for (const snap of doc.lineup_snapshots ?? []) {
    for (const r of snap.roster ?? []) s.add(r.player_id);
    for (const l of snap.lineup ?? []) s.add(l.player_id);
  }
  for (const p of doc.pitching ?? []) s.add(p.pitcher_id);
  // [§0/§11] direct_stats(個人成績・断片)だけを持つ参加者も「参照あり」＝出欠外し/削除で沈黙孤児化させない
  //   (人の明示記録 origin:manual の喪失防止。抜くなら detach で明示的に)。
  for (const ds of doc.direct_stats ?? []) s.add(ds.participant_id);
  return s;
}

export interface GameMetaInput {
  id: string;
  date: string;
  opponent: string;
  league?: string | null;
  home_away: "home" | "away" | null;
  result: GameResult | null;
}

/**
 * メタ情報の編集/新規＝手修正(public版への直コミット)。
 * 公開版(loadGame)を土台にする＝作業中の下書きは巻き込まない。呼び出し側が base_gen(=描画時のpublicGen)を渡すと、
 * 下書きが居る(tip≠publicGen)/他者が更新した場合は GenConflictError で弾かれる＝「下書き中は手修正できない」。
 */
export async function upsertGameMeta(input: GameMetaInput, opts: CommitOpts = {}): Promise<void> {
  // 試合IDは不透明キー＝値(日付形式)は問わず、URLセーフ(1..64字)であることだけ確認する。旧日付ID/新hexID双方を許容。
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) throw new Error(`試合IDが不正です（受領: "${input.id}"）`);
  if (!input.date) throw new Error("日付は必須です");
  if (!input.opponent?.trim()) throw new Error("対戦相手は必須です");

  const existing = await loadGame(input.id); // 公開版を土台に(下書きは土台にしない)
  // 結果は編集対象(スコア/勝敗/決着)以外の既存フィールド(scheduled_innings/line_score)を保持する
  const result: GameResult | null = input.result
    ? { ...existing?.game.result, ...input.result }
    : null;
  const game: Game = {
    id: input.id,
    date: input.date,
    opponent: input.opponent.trim(),
    league: input.league?.trim() || null,
    home_away: input.home_away,
    result,
    note: existing?.game.note ?? null,
  };
  const doc: GameDoc = existing ? { ...existing, game } : emptyDoc(game);
  // [E-1] メタ保存経路も検証を通す(§10.3): 最終スコア(result)を最後に入れた保存でも R4 突合(導出総得点vs申告)を
  //   確実に走らせる。applyValidation は冪等・値は変えず validator 注記のみ再生成する。
  //   nameOf を渡す＝validator注記の人物IDを名前で出す(内部コード非露出)。
  const nameOf = docNameResolver(doc, await loadPlayers());
  await commitGameDoc(applyValidation(doc, nameOf), co({ edit_source: "manual", input: { kind: "manual", text: "メタ情報の編集" }, ...opts }));
}

/**
 * 出欠の設定＝participants を選手マスタ基準でリコンサイル(手修正・public直コミット)。
 * 提出=その選手を出席(=participants在籍)にする(未参加なら参加者を追加)。未提出のマスタ参加者=欠席＝参加者から外す。
 * ただし試合データが参照している参加者は外せない(黙って壊さない)＝「抜く」は参加者操作(detach)で行う。
 * 助っ人(guest)参加者はこのフォームの対象外(触らない)。下書き中は base_gen 楽観ロックで弾かれる。
 * status(played/bench)概念は廃止＝在籍が出席そのもの(出た/出ないは成績有無から導出)。
 */
export async function setAttendance(
  gameId: string,
  entries: { player_id: string }[],
  opts: CommitOpts = {}
): Promise<void> {
  const doc = await loadGame(gameId); // 公開版を土台に(下書きは土台にしない)
  if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
  const parts: Participant[] = [...(doc.participants ?? [])];
  const byMaster = new Map<string, number>();
  parts.forEach((p, i) => {
    if (p.link.kind === "roster") byMaster.set(p.link.player_id, i);
  });
  const submitted = new Set(entries.map((e) => e.player_id));
  for (const mid of submitted) {
    if (!byMaster.has(mid)) {
      parts.push({ id: nextParticipantId(parts), link: { kind: "roster", player_id: mid } });
    }
    // 既に参加者に居る＝出席のまま(在籍が出席・更新不要)
  }
  const referenced = referencedParticipantIds(doc);
  const next: Participant[] = [];
  for (const p of parts) {
    if (p.link.kind === "roster" && !submitted.has(p.link.player_id)) {
      if (referenced.has(p.id)) {
        throw new Error(`この選手は試合データ(打席/守備等)から参照されているため出欠から外せません。「試合から抜く」操作を使ってください`);
      }
      continue; // 欠席＝参加者から外す(参照なしのみ)
    }
    next.push(p);
  }
  assertNoDuplicateRoster(next);
  // [E-1] 出欠保存経路も検証を通す(§10.3・冪等)。R4 等の validator 注記を最新状態で再生成してから公開直コミットする。
  //   nameOf は検証する doc(participants差し替え後)から構築＝注記の人物IDを名前で出す(内部コード非露出)。
  const validated = { ...doc, participants: next };
  const nameOf = docNameResolver(validated, await loadPlayers());
  await commitGameDoc(applyValidation(validated, nameOf), co({ edit_source: "manual", input: { kind: "manual", text: "出欠の編集" }, ...opts }));
}

// ===== 参加者操作(§9.6) =====
// 抜く/差し替え/再リンク/追加/削除＝participants の1エントリ編集。成績は参加者IDを参照するので自動追従する。
// 手修正モデル(public直コミット・edit_source:manual・下書き中は base_gen 楽観ロックで不可)。

/** 参加者エントリを1箇所書き換えて public 直コミットする共通経路。 */
async function commitParticipants(gameId: string, text: string, mutate: (parts: Participant[], doc: GameDoc) => Participant[], opts: CommitOpts): Promise<void> {
  const doc = await loadGame(gameId);
  if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
  const next = mutate([...(doc.participants ?? [])], doc);
  assertNoDuplicateRoster(next); // V-B: コミット前に構造的に防止
  await commitGameDoc({ ...doc, participants: next }, co({ edit_source: "manual", input: { kind: "manual", text }, ...opts }));
}

function findParticipant(parts: Participant[], participantId: string): number {
  const i = parts.findIndex((p) => p.id === participantId);
  if (i < 0) throw new Error("対象の参加者が見つかりません");
  return i;
}

// [§12 P1] detach/relink(per-game のシーズン集計外への出し入れ)は廃止＝シーズン集計外は「種別(guest)」へ一本化。
//   guest{was} を新規に作る経路も無くなる(既存データの guest{was} の読みは維持＝names/集計は P2/P5)。

/** 人の差し替え: この参加者(とその成績)を別のマスタ選手に付け替える。 */
export async function swapParticipant(gameId: string, participantId: string, newPlayerId: string, opts: CommitOpts = {}): Promise<void> {
  const masters = await loadPlayers();
  if (!masters.has(newPlayerId)) throw new Error(`選手 ${newPlayerId} が選手マスタにありません`);
  await commitParticipants(gameId, "参加者の人違いを差し替え", (parts) => {
    const i = findParticipant(parts, participantId);
    parts[i] = { ...parts[i], link: { kind: "roster", player_id: newPlayerId } };
    return parts;
  }, opts);
}

/**
 * 参加者の追加(出席のみ・後から参加など)。参加者に居る＝出席。
 * [§12 P1] マスタ選手(player_id)専用へ改修＝助っ人も種別guestのマスタ選手として player_id で追加する
 *   (助っ人名からの新規作成は呼び出し側で createGuestPlayer→この関数の順に行う)。guest 名インライン生成は廃止。
 */
export async function addParticipant(
  gameId: string,
  input: { player_id: string },
  opts: CommitOpts = {}
): Promise<void> {
  const masters = await loadPlayers();
  await commitParticipants(gameId, "参加者の追加", (parts) => {
    if (!input.player_id) throw new Error("選手(player_id)が必要です");
    if (!masters.has(input.player_id)) throw new Error(`選手 ${input.player_id} が選手マスタにありません`);
    if (parts.some((p) => p.link.kind === "roster" && p.link.player_id === input.player_id)) throw new Error("この選手は既に参加しています");
    parts.push({ id: nextParticipantId(parts), link: { kind: "roster", player_id: input.player_id } });
    return parts;
  }, opts);
}

/** 参加者の削除(=欠席扱い)。試合データが参照している参加者は削除できない(黙って壊さない)。 */
export async function removeParticipant(gameId: string, participantId: string, opts: CommitOpts = {}): Promise<void> {
  await commitParticipants(gameId, "参加者の削除", (parts, doc) => {
    const i = findParticipant(parts, participantId);
    if (referencedParticipantIds(doc).has(participantId)) {
      throw new Error("この参加者は試合データ(打席/守備等)から参照されているため削除できません。「試合から抜く」を使ってください");
    }
    parts.splice(i, 1);
    return parts;
  }, opts);
}

/**
 * [§12 P3] 名寄せ＝選手A(from)の出場を選手B(to)へ付け替える(別々に採番された身元を1つに束ねる)。
 * 主用途は AI の助っ人振り分け失敗のリカバリ＝別人/重複でマスタ助っ人が作られても、後からこれで束ねればよい
 *   (∴ AIの助っ人割り当ては best-effort でよく完璧な同定を作り込まない・§12.2)。
 * from が出場する各試合の participants[].link.player_id を from→to に付け替え、非破壊append(commitParticipants
 *   ＝public直コミット・edit_source:manual)で版を積む。成績は参加者IDを参照するので付け替えに自動追従する。
 * 同一試合に to が既に参加していればその試合は skip(二重計上防止＝人が手動で確認)。from が居ない試合も skip。
 * best-effort＝1試合のコミット失敗(下書き割り込み=楽観ロック競合)でも全体を止めず skip して続行する(非破壊)。
 * [§12 P5] 仕上げ＝付け替え後に from が現公開版のどこからも参照されなくなったら from マスタを players から削除する
 *   (名寄せしても選手マスタに重複行が残る問題の解消)。skip が1件でも有れば from はまだ参照が残るので削除しない。
 * ★歴史版の注記(cosmetic): 付け替えは現公開版のみ(非破壊append)。game_history の過去版は from を参照し続けるため、
 *   from 削除後は過去版プレビュー(?gen=N)で from の名前解決が id 表示になりうる。現行の一覧/試合/シーズン表示は
 *   公開版だけを読むため無影響。
 * @param opts.gameIds 対象試合の限定(未指定＝from が出場する全試合)。
 */
export async function mergePlayer(
  fromPlayerId: string,
  toPlayerId: string,
  opts: { gameIds?: string[] } & CommitOpts = {}
): Promise<{ updatedGames: string[]; skipped: { gameId: string; reason: string }[]; deletedFrom: boolean }> {
  if (!fromPlayerId || !toPlayerId) throw new Error("名寄せ元/名寄せ先の選手IDが必要です");
  if (fromPlayerId === toPlayerId) throw new Error("名寄せ元と名寄せ先が同一です");
  const masters = await loadPlayers();
  if (!masters.has(fromPlayerId)) throw new Error(`選手 ${fromPlayerId} が選手マスタにありません`);
  if (!masters.has(toPlayerId)) throw new Error(`選手 ${toPlayerId} が選手マスタにありません`);

  const { gameIds, ...commitOpts } = opts;
  const requested = gameIds ? new Set(gameIds) : null;
  const isRoster = (p: Participant, pid: string) => p.link.kind === "roster" && p.link.player_id === pid;

  const games = await loadGames();
  // gameIds 指定時はその範囲(from不在も候補に含め skip として報告)。未指定は from が出場する試合のみ(skipノイズを出さない)。
  const candidates = games.filter((d) =>
    requested ? requested.has(d.game.id) : (d.participants ?? []).some((p) => isRoster(p, fromPlayerId)));

  const updatedGames: string[] = [];
  const skipped: { gameId: string; reason: string }[] = [];
  for (const d of candidates) {
    const gameId = d.game.id;
    const parts = d.participants ?? [];
    if (!parts.some((p) => isRoster(p, fromPlayerId))) {
      skipped.push({ gameId, reason: "対象の選手がこの試合に出場していません" });
      continue;
    }
    if (parts.some((p) => isRoster(p, toPlayerId))) {
      skipped.push({ gameId, reason: "付け替え先の選手が既に同じ試合に参加しているため名寄せできません(二重計上防止・手動で確認してください)" });
      continue;
    }
    try {
      // base_gen=publicGen で楽観ロック＝下書きが割り込んでいる試合は公開版を上書きしない(GenConflictErrorでskip)。
      await commitParticipants(
        gameId,
        "選手の名寄せ(別選手へ付け替え)",
        (ps) => ps.map((p) => (isRoster(p, fromPlayerId) ? { ...p, link: { kind: "roster", player_id: toPlayerId } } : p)),
        { ...commitOpts, base_gen: await publicGen(gameId) },
      );
      updatedGames.push(gameId);
    } catch (e) {
      if (e instanceof GenConflictError) {
        skipped.push({ gameId, reason: "この試合は未確定の集計結果があるため名寄せできません(先に確定/破棄してください)" });
        continue;
      }
      throw e;
    }
  }

  // [§12 P5] 統合元マスタの削除＝名寄せの仕上げ。skip 0件(全出場を to へ付け替え切った)＝from の参照が残らない、
  //   の前提で削除する。ただし gameIds 限定で範囲外の試合に from がまだ出ている場合は skip に現れない参照が残るため、
  //   公開版を再読込して from がどこからも参照されていないことを確認してからのみ削除する(参照が残るマスタは消さない)。
  let deletedFrom = false;
  if (skipped.length === 0) {
    const stillReferenced = (await loadGames()).some((d) => (d.participants ?? []).some((p) => isRoster(p, fromPlayerId)));
    if (!stillReferenced) {
      await deletePlayer(fromPlayerId);
      deletedFrom = true;
    }
  }
  return { updatedGames, skipped, deletedFrom };
}

/**
 * 作業中の下書きを確定(publish)＝draft末尾の snapshot を公開版(draft:false)として1版append、games(公開)に反映。
 * squash しない＝draft版(入力付き)は履歴に残す(非破壊)。ノートの凍結/新ソース開始は呼び出し側(route)で。
 */
export async function publishGame(gameId: string, opts: CommitOpts = {}): Promise<void> {
  const w = await loadWorking(gameId);
  if (!w) throw new Error(`試合 ${gameId} が見つかりません`);
  // [E-1] 公開経路が検証を素通りする既存穴を塞ぐ(§10.3): 下書き末尾に最終スコアだけ入れて公開した場合でも
  //   R4 突合(導出総得点vs申告スコア)を必ず評価する。applyValidation は冪等・値は変えず validator 注記のみ再生成。
  //   nameOf を渡す＝validator注記の人物IDを名前で出す(内部コード非露出)。
  const nameOf = docNameResolver(w.doc, await loadPlayers());
  await commitGameDoc(applyValidation(w.doc, nameOf), co({ ...opts, draft: false, edit_source: "publish" }));
}

/**
 * 下書きを破棄＝最後の公開版より上の draft 版(導出物)だけ削除し、公開状態へ戻す。戻り値は削除版数(既存契約のまま)。
 * ノート(=ユーザーの入力・正本)は残す＝直して再集計できる。publish時はノートを消費するので別途クリア。
 * [§12 助っ人ライフサイクル] 破棄する draft 版が参照していた種別guestのマスタ選手は、破棄後に「残存する全データから
 * 参照ゼロ」を確認できたものだけ master からも削除する＝「破棄→集計し直し」のたびに残留guestが新規採番で増殖する根因
 * (破棄されたdraftが作った助っ人マスタの残留)を断つ。名前一致での自動再利用(同一人物の自動同定)はしない＝同じ助っ人が
 * 複数試合に来たら後から名寄せ(mergePlayer)で人が統合する(同姓別人を黙って同一化する事故を構造的に排除)。
 */
export async function discardGame(gameId: string): Promise<number> {
  // 1) 破棄対象(最後の公開版より上の draft 版)の snapshot が参照する guest マスタを削除候補に収集する。
  //    判定は保守的(snapshot の JSON 文字列に id が含まれるか)＝参照形態を列挙して漏らすより広めに拾い、
  //    実際に消すかどうかは破棄後の再読取確認(下)に委ねる。
  //    ★安全性質: 手動でマスタに追加しただけの未参照助っ人は「破棄draftが参照していない」ため
  //    そもそも候補にならず、誤削除され得ない(候補になるのは破棄draftに現れた guest だけ)。
  const pub = await publicGen(gameId);
  const tip = await currentGen(gameId);
  const candidates = new Set<string>();
  if (tip > pub) {
    const guests = [...(await loadPlayerMap()).values()].filter((p) => p.type === "guest");
    if (guests.length > 0) {
      for (let gen = pub + 1; gen <= tip; gen++) {
        const v = await loadVersion(gameId, gen); // 公開版より上は全て draft(=破棄対象)
        if (!v) continue;
        const s = JSON.stringify(v.snapshot);
        for (const g of guests) if (s.includes(g.id)) candidates.add(g.id);
      }
    }
  }
  // 2) 破棄の実行。戻り値(削除版数)と呼び出し契約は従来のまま変えない。
  const removed = await discardDrafts(gameId);
  // 3) 候補のうち「残存する全データから参照ゼロ」を確認できたものだけマスタから削除する。
  //    掃除は best-effort: 破棄自体は既に成功しているので、ここの失敗を呼び出し元へ伝播させない
  //    (成功した破棄が失敗表示になるのを防ぐ)。失敗しても孤児が残るだけ＝清掃スクリプト＋承認で回収できる。
  if (candidates.size > 0) {
    try { await deleteUnreferencedGuests(gameId, candidates); }
    catch (e) { console.error(`discardGame: 助っ人マスタの掃除に失敗(破棄は成功済み): ${String(e)}`); }
  }
  return removed;
}

/**
 * [§12 助っ人ライフサイクル] 候補の guest マスタのうち「残存する全データから参照ゼロ」を確認できたものだけ
 * deletePlayer する。mergePlayer([§12 P5])と同じ「削除前の再読取確認」の流儀＝削除の直前に最新状態を読み直し、
 * どこからも参照されていないと確認できた場合のみ消す(参照が残るマスタは消さない)。
 * 走査対象＝この試合の残存状態(公開版/working)＋他の全試合(公開版＋下書き中の working)。判定は保守的
 * (doc の JSON 文字列に id が含まれるか)＝疑わしきは残す(誤削除より残留が安全。残留は清掃スクリプト
 * scripts/cleanup_orphan_guests.ts＋ユーザー承認で除ける)。
 */
async function deleteUnreferencedGuests(gameId: string, candidates: Set<string>): Promise<void> {
  const texts: string[] = (await loadGames()).map((d) => JSON.stringify(d)); // 全試合の公開版
  // working(下書きの先端)も走査＝未公開の新規試合・下書き作業中の他試合が参照する guest を消さない。
  // gameId 自身も明示的に含める(破棄後の残存状態=公開版と同内容のはずだが、防御的に読み直す)。
  for (const id of new Set([gameId, ...(await draftGameIds())])) {
    const w = await loadWorking(id);
    if (w) texts.push(JSON.stringify(w.doc));
  }
  for (const pid of candidates) {
    if (texts.some((t) => t.includes(pid))) continue; // 参照が残る(疑わしい含む)＝残す
    await deletePlayer(pid);
  }
}

/**
 * 試合まるごと削除(ハード)。公開doc・全版履歴・下書き・編集中ノートを消す。
 * 復元はバックアップからのみ＝UI側で危険確認を必須にする。下書きの有無に関わらず全て消す(意図が「全部消す」だから)。
 */
export async function deleteGame(gameId: string): Promise<{ versions: number }> {
  const r = await deleteGameCompletely(gameId);
  if (!r.existed && r.versions === 0) throw new Error(`試合 ${gameId} が見つかりません`);
  await clearNote(gameId);
  return { versions: r.versions };
}

/**
 * ロールバック＝過去版 gen の snapshot を「最新に積む」(枝分かれさせず履歴の先端へ append)。
 * public直コミット(新版=公開)。base_gen=publicGen で楽観ロック＝下書きがある/他者が更新したら GenConflictError で弾く
 * (手修正と同じ扱い＝先に確定/破棄)。出自は edit_source:"rollback" と input に「gen N へ」を刻んで辿れる。
 */
export async function rollbackGame(gameId: string, gen: number, opts: CommitOpts = {}): Promise<void> {
  const target = await loadVersion(gameId, gen);
  if (!target) throw new Error(`版 gen ${gen} が見つかりません`);
  await commitGameDoc(target.snapshot, co({
    ...opts, draft: false, edit_source: "rollback",
    input: { kind: "manual", text: `gen ${gen} の内容へロールバック` },
    base_gen: await publicGen(gameId),
  }));
}

/**
 * 要確認の「承認(解決)」: 打席に resolved 注記を足す＝「直さずに意図どおりと認める(特別ルール等)」。
 * 元の unclear 注記は監査用に残す。applyValidation 再走でも、resolved の打席は validator がスキップ＝蒸し返さない。
 * working の draft 性を継いでコミット(下書きなら下書き／公開版なら公開直コミット)。
 */
export async function resolveFlag(
  gameId: string,
  addr: { inning: number; half: Half; order: number },
  reason: string,
  rule: string | null,
  opts: CommitOpts = {}
): Promise<void> {
  const w = await loadWorking(gameId);
  if (!w) throw new Error(`試合 ${gameId} が見つかりません`);
  const idx = findPAIndex(w.doc, addr.inning, addr.half, addr.order);
  if (idx < 0) throw new Error("対象の打席が見つかりません");
  const pa = w.doc.plate_appearances[idx];
  // rule有り=validatorのそのルールを承認(再検査でスキップ)。rule無し=AI由来を打席単位で承認。
  const resolved: Annotation = { type: "resolved", detail: reason || "意図どおりとして承認", source: "manual", resolved_by: opts.source ?? "admin", rule: rule ?? null };
  const pas = [...w.doc.plate_appearances];
  pas[idx] = { ...pa, annotations: [...(pa.annotations ?? []), resolved] };
  // resolvedになった打席のvalidatorフラグは消える(skip)。nameOf で注記の人物IDを名前で出す(内部コード非露出)。
  const validated = { ...w.doc, plate_appearances: pas };
  const next = applyValidation(validated, docNameResolver(validated, await loadPlayers()));
  await commitGameDoc(next, co({ ...opts, draft: w.draft, edit_source: "manual", input: { kind: "manual", text: `要確認を承認: ${reason}` }, base_gen: w.gen }));
}

// ===== 差分op(v2) =====
// 「下書き＝操作ストリームの畳み込み」。AIの1返却＝複数opを1世代で原子的に反映する(applyOps)。
// 各opは純粋なリデューサ (doc, args) => doc。途中で throw すれば commit に到達せず=半端が残らない。

export interface LineupRowInput {
  order: number | null; // null = DH制で打順に入らない投手(doc側 LineupEntry.order は元から null 対応・打順導出は order!=null のみ)
  position: string | null; // "1".."9" | "DH" | null
  player_id?: string; // 選手マスタID か 参加者ID
  // [§12 P1] 助っ人名(UI/AI は名前ベースのままでよい)。applyOps のラッパ(resolveGuestNamesInOps)が
  //   createGuestPlayer で種別guestのマスタ選手(player_id)へ解決し、純reducer には player_id だけが渡る。
  guest_name?: string;
}

/** 入力用の走塁移動: runner_id は省略可＝サーバが from塁の走者で確定する(resolveBaserunningIds)。 */
export type BaserunMoveInput = Omit<BaserunMove, "runner_id"> & { runner_id?: string };
/** 入力用の打席中走塁イベント(runners の runner_id 省略可)。 */
export type BaserunDuringInput = Omit<BaserunDuring, "runners"> & { runners?: BaserunMoveInput[] };

/** [C-6/F-2] runs[]の記録帰属の上書き(責任投手のみ)。導出runsへ走者IDキーでマージし、保存は runs に畳む。
 * 自責フラグ(earned)は上書きできない＝常にエンジン導出の近似。自責点の正本は投手記録(doc.pitching §10.3 Phase C差し戻し)。 */
export interface RunOverrideInput {
  runner_id: string;
  responsible_pitcher_id?: string | null;
}

export interface AddPAInput {
  inning?: number;
  half?: Half;
  batter_id?: string; // 省略時は自動(自軍=打順, 相手=打順位置)。投捕は常にスナップショットから導出(§9)
  result: ResultCode;
  complete?: boolean;
  fielding?: Fielding | null;
  baserunning_during?: BaserunDuringInput[];
  baserunning_after?: BaserunMoveInput[];
  note?: string | null;
  annotations?: Annotation[];
  // [C-6] スキーマの事実フィールド全体を受理(§10.3)。runs[] は死に入力のため受けない(エンジン導出が正本)
  dropped_third_strike?: boolean; // 振り逃げ
  intentional?: boolean; // 申告敬遠
  automatic_out?: boolean;
  double_play?: boolean; // 併殺(アウト下限2をエンジンが保証)
  triple_play?: boolean; // 三重殺(アウト下限3)
  batting_slot?: number | null; // 記録値(三分類B)。未指定はサーバ導出
  opponent_slot?: number | null; // 同上(相手打順)。指定時は batter_id もプレースホルダ(oN)へ追従
  outs?: number | null; // [§10.6] 開始時アウトの主張値(4-5アウト回等)。未指定/null=未主張(read時に盤面から導出)
  // [§14.1 研究A] 状態記載(この打席の後のアウト数/走者占有塁)の転記。導出値ではない＝転記のまま保存(R11が導出盤面と突合)
  stated_outs?: number | null; // null/未指定=無記載
  stated_runners?: ("1" | "2" | "3")[] | null; // []=走者なしと記載、null/未指定=無記載
  pinch_runner?: PlateAppearance["pinch_runner"]; // 代走(§9.2拡張済みの型)。runner_id は参加者へ解決(未参加マスタは自動参加)
  run_overrides?: RunOverrideInput[]; // 記録帰属の上書き(責任投手のみ・自責は導出)
  manual_runs?: ManualRunInput[]; // [§0/§11] 得点(走者不明)等の人の明示run。origin:"manual"でPA.runsへ畳む(スイープ非破壊で保持)
}

/** [§0/§11 得点(走者不明)] 人が明示する得点run。runner_id=null=得点者不明(§0-C)。
 * origin:"manual"でPA.runsへ畳まれ、以後の編集/スイープの再導出でも保全される(deriveRuns=autoとマージ)。 */
export interface ManualRunInput {
  runner_id?: string | null; // 既定/得点(走者不明)トグルは null
  rbi?: boolean; // 既定 true(打者に打点を付ける)
}

/** 既存打席の編集(アドレス＝回/表裏/order)。渡したフィールドだけ差し替える。
 * clear_unclear: trueの時だけ未解決の不明瞭(unclear)注記を除去する(§10.3 実バグ②: 暗黙の全消しは廃止。
 * AIの再解釈(打席を意味ごと出し直す)は明示trueで発火し、部分手修正では注記が残る=黙って消えない)。 */
export interface EditPAInput {
  pa_id?: string; // 不変ID(§10.3)。指定時は回/表裏/orderより優先(削除等でorderが振り直されても別打席に化けない)
  inning: number;
  half: Half;
  order: number;
  batter_id?: string;
  result?: ResultCode;
  complete?: boolean;
  fielding?: Fielding | null;
  baserunning_during?: BaserunDuringInput[];
  baserunning_after?: BaserunMoveInput[];
  note?: string | null;
  annotations?: Annotation[];
  clear_unclear?: boolean;
  // [C-6] 受理フィールド拡張(Addと同じ)。batting_slot/opponent_slot は記録値の修復経路(§10.3)
  dropped_third_strike?: boolean;
  intentional?: boolean;
  automatic_out?: boolean;
  double_play?: boolean;
  triple_play?: boolean;
  batting_slot?: number | null;
  opponent_slot?: number | null; // 相手PAで変更時は batter_id もプレースホルダ(oN)へ追従
  outs?: number | null; // [§10.6] 開始時アウトの主張値。null=未主張へ戻す(read時導出)
  // [§14.1 研究A] 状態記載の転記(Addと同じ)。未指定=既存値を保持(部分更新で消さない)・null=無記載へ戻す
  stated_outs?: number | null;
  stated_runners?: ("1" | "2" | "3")[] | null;
  pinch_runner?: PlateAppearance["pinch_runner"] | null;
  run_overrides?: RunOverrideInput[]; // 記録帰属の手動上書き(責任投手のみ)。doc.run_overrides ストアへ永続化される
  // [§0/§11] 手動run(得点(走者不明)等)の全置換。指定時は既存の origin:"manual" run を差し替える(未指定=保持)。
  manual_runs?: ManualRunInput[];
}
/** [F-3] 打席の削除。shift_slots=insertと対称に後続スロットを-1(一巡)シフト(既定true)。 */
export interface RemovePAInput { pa_id?: string; inning: number; half: Half; order: number; shift_slots?: boolean }

/** [C-1] 打席の挿入。after_pa_id=その打席の直後へ(null/未指定=半イニング先頭)。inning/half は必須。 */
export type InsertPAInput = Omit<AddPAInput, "inning" | "half"> & {
  inning: number;
  half: Half;
  after_pa_id?: string | null;
  shift_slots?: boolean; // 既定true: 後続打席のスロットを+1シフト(一巡)。false=据え置き(打順に入らない特殊挿入用)
};

/** [C-2] 交代等の有効タイミング(打席粒度)。before_order 未指定=その半イニングの既存打席数+1(現行既定)。 */
export interface OpTiming { inning: number; half: Half; before_order?: number | null }

/** [C-2] 選手交代: out をラインアップから外し、同じ打順スロット/守備位置に in を入れる。 */
export interface SubstituteInput {
  out: string; // 参加者ID or 選手マスタID
  // in.player_id=未参加マスタなら参加者を自動追加。in.guest_name(助っ人名)は applyOps のラッパが
  // [§12 P1] 種別guestのマスタ選手(player_id)へ解決してから reducer に渡す(guest 参加者の自動生成は廃止)。
  in: { player_id?: string; guest_name?: string };
  position?: string | null; // 指定時は守備位置も変更(未指定=outの位置を引き継ぐ)
  timing: OpTiming;
  reason?: string;
}

/** [C-2] 退場: out をラインアップから外すだけ(打順スロットは欠員=deriveNextPAの欠員スキップが効く)。 */
export interface LeaveGameInput { out: string; timing: OpTiming; reason?: string }

/** [C-3] 打順変更: 指定選手の order だけ差し替える(5-6交換は rows 2件)。 */
export interface ChangeOrderInput {
  rows: { player: string; order: number | null }[]; // player=参加者ID or マスタID
  timing: OpTiming;
}

/** [C-5] 投手記録(投手別の自責点・勝敗S)。doc.pitching の全置換。player=参加者ID or マスタID。 */
export interface PitchingRecordInput {
  player: string;
  earned_runs: number | null; // null=自責不明（decisionだけ付けたい投手＝勝敗Sを保持し er は不明のまま。RunEvent.earned と同イディオム）
  decision?: "W" | "L" | "S" | null;
}

/** 守備位置変更(delta)。1人ぶん＝対象選手(player_id か from_position で特定)を to_position へ。 */
export interface DefenseChangeInput {
  player_id?: string; // 対象選手(P/G-id か名前)
  from_position?: string | null; // 旧守備位置(player_id省略時に現ロスターから対象を解決。例『2->5』『ピッチャー→サード』)
  to_position: string; // 新守備位置 "1".."9"|"DH"
  // [§12 P1] 辞書に無い新しい助っ人の名前。applyOps のラッパ(resolveGuestNamesInOps)が種別guestのマスタ選手
  //   (player_id)へ解決してから reducer に渡る(setStartingLineup/substitutePlayer と同じ流儀)。
  guest_name?: string;
}

/** 1返却で送られてくる操作の判別共用体 */
export type GameOpInput =
  | ({ type: "setGameMeta" } & Partial<GameMetaInput>)
  | { type: "setStartingLineup"; rows: LineupRowInput[] }
  | { type: "changeDefense"; changes: DefenseChangeInput[]; inning?: number; half?: Half; before_order?: number | null }
  | ({ type: "addPlateAppearance" } & AddPAInput)
  | ({ type: "editPlateAppearance" } & EditPAInput)
  | ({ type: "removePlateAppearance" } & RemovePAInput)
  | ({ type: "insertPlateAppearance" } & InsertPAInput)
  | ({ type: "substitutePlayer" } & SubstituteInput)
  | ({ type: "leaveGame" } & LeaveGameInput)
  | ({ type: "changeBattingOrder" } & ChangeOrderInput)
  | { type: "setPitchingRecords"; records: PitchingRecordInput[] }
  | { type: "setDirectStats"; stats: DirectStatLine[] };

function emptyDoc(game: Game): GameDoc {
  return { schema_version: "2.0", game, participants: [], lineup_snapshots: [], plate_appearances: [] };
}

/** メタ情報の部分更新(渡したフィールドだけ変える) */
function reduceSetGameMeta(doc: GameDoc | null, gameId: string, patch: Partial<GameMetaInput>): GameDoc {
  // 試合IDは不透明キー＝URLセーフ(1..64字)のみ強制(日付形式は問わない。旧日付ID/新hexID双方を許容)。
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(gameId)) throw new Error("試合IDが不正です");
  const base: Game = doc?.game ?? { id: gameId, date: "", opponent: "", league: null, home_away: null, result: null };
  const result: GameResult | null = patch.result !== undefined ? (patch.result ? { ...base.result, ...patch.result } : null) : base.result ?? null;
  const game: Game = {
    id: gameId,
    date: patch.date ?? base.date,
    opponent: patch.opponent ?? base.opponent,
    league: patch.league !== undefined ? patch.league?.trim() || null : base.league ?? null,
    home_away: patch.home_away !== undefined ? patch.home_away : base.home_away,
    result,
    note: base.note ?? null,
  };
  return doc ? { ...doc, game } : emptyDoc(game);
}

/**
 * スタメン登録(seq0)。行の選手参照を参加者に解決(必要なら参加者を追加=マスタID→roster)し、
 * lineup は参加者IDで持つ。lineupに入った参加者は出場(played)へ。lineup外の既存参加者(控え等)は温存する。
 * scope/season の接頭辞推論・attendance/additional_players の生成は §9 で廃止(participants が正本)。
 * [§12 P1] 助っ人も種別guestのマスタ選手(player_id)＝助っ人名は applyOps のラッパで player_id へ解決済み
 *   ＝ここは player_id 一本(guest 参加者の自動生成は無い＝純reducer は doc→doc 純粋)。
 */
function reduceSetStartingLineup(doc: GameDoc, gameId: string, rows: LineupRowInput[], masters: Map<string, string>): GameDoc {
  const parts: Participant[] = [...(doc.participants ?? [])];
  const lineup = rows.map((r) => {
    let pid: string | undefined;
    if (r.player_id) {
      const byId = parts.find((p) => p.id === r.player_id);
      const byMaster = parts.find((p) => p.link.kind === "roster" && p.link.player_id === r.player_id);
      pid = byId?.id ?? byMaster?.id;
      if (!pid) {
        if (!masters.has(r.player_id)) throw new Error(`打順${r.order}: 選手 ${r.player_id} が見つかりません(マスタ未登録)`);
        pid = nextParticipantId(parts);
        parts.push({ id: pid, link: { kind: "roster", player_id: r.player_id } });
      }
    }
    if (!pid) throw new Error(`打順${r.order}: 選手が特定できません(選手IDが必要)`);
    return { order: r.order, position_id: (r.position as PositionId) ?? null, player_id: pid, automatic_out: false };
  });
  assertNoDuplicateRoster(parts);
  // 参加者は温存(lineup外の既存参加者=控えも残す)。lineup入り=出席は participants 在籍で既に表現済み(status概念廃止)。
  const roster: RosterEntry[] = lineup.map((l) => ({ player_id: l.player_id, fielding_team: "N-KINGS", status: "active" }));
  const half: Half = kingsBatHalf(doc);
  const snap: LineupSnapshot = {
    game_id: gameId, team: "N-KINGS", snapshot_id: `${gameId}-NK-00`, seq: 0,
    effective_from: { inning: 1, half, before_order: null }, empty_slot_policy: "skip", roster, lineup, reason: "start",
  };
  const others = (doc.lineup_snapshots ?? []).filter((s) => s.seq !== 0);
  return { ...doc, participants: parts, lineup_snapshots: [snap, ...others] };
}

/**
 * 守備位置変更(delta)。直前(最大seq)のスナップショットを引き継ぎ、該当選手の position だけ差し替えて
 * 新スナップショットを追記する(=スタメンを全置換しない＝他の選手が消えない)。打順は不変。
 * 対象は player_id か from_position(現ロスターの占有者)で特定。スワップでも崩れないよう base に対して先に解決する。
 * [2026-08-18 実障害] 「ベンチ」という機構は存在しない(母集団は participants のみ=出し入れ自由が基本)。
 * 対象がラインアップに居なくてもエラーにせず、その場でラインアップへ加える(形式ルールを課さない・記録どおり)。
 */
export function reduceChangeDefense(doc: GameDoc, gameId: string, changes: DefenseChangeInput[], at: { inning?: number; half?: Half; before_order?: number | null }, masters: Map<string, string> = new Map()): GameDoc {
  const snaps = doc.lineup_snapshots ?? [];
  if (!snaps.length) throw new Error("スタメン未登録のため守備位置変更を適用できません");
  const st = gameState(doc);
  const half: Half = at.half ?? st.half;
  const inning = at.inning && at.inning > 0 ? at.inning : st.inning;
  // [C-4] 打席粒度のタイミング引数: before_order 明示(null含む)を優先。未指定は現行どおり「既存打席数+1」
  //   =遡及修正(記録済み試合の途中交代を後から正しい打席境界に置く)を可能にする。
  const before_order = at.before_order !== undefined
    ? at.before_order
    : (() => { const n = doc.plate_appearances.filter((p) => p.inning === inning && p.half === half).length; return n > 0 ? n + 1 : null; })();
  const effective_from = { inning, half, before_order };
  // [F-1] 土台=timing時点の有効スナップショット(最新seqではない)＝遡及入力でも「その時点」の配置を土台にする。
  const base = effectiveBaseSnapshot(doc, "守備位置変更", effective_from);
  const occupant = (pos?: string | null) => (pos ? base.lineup.find((l) => l.position_id === pos)?.player_id : undefined);
  // (対象player_id, 新position) を base に対して先に解決(applyMoves同様、スワップで破綻させない)
  // player_id 指定の対象は substitutePlayer の in と同じ流儀で参加者に解決する:
  //   未参加のマスタ選手なら参加者を自動追加(守備につく=参加の事実)。masters に無いIDはエラー(誰か分からないものは黙って作らない)。
  const parts: Participant[] = [...(doc.participants ?? [])];
  const moves = changes.map((c) => {
    let pid: string | undefined;
    if (c.player_id) {
      const r = resolveBatter(doc, c.player_id) ?? c.player_id;
      if (base.lineup.some((l) => l.player_id === r)) {
        pid = r; // ラインアップ在籍=従来どおりの位置差し替え(参加者解決は不要)
      } else {
        pid = parts.find((p) => p.id === r)?.id
          ?? parts.find((p) => p.link.kind === "roster" && p.link.player_id === r)?.id; // 同一op内で追加済みのマスタID参照も拾う
        if (!pid) {
          if (!masters.has(r)) throw new Error(`守備位置変更: 選手 ${r} が見つかりません(マスタ未登録)`);
          pid = nextParticipantId(parts);
          parts.push({ id: pid, link: { kind: "roster", player_id: r } });
        }
      }
    } else {
      // from_position 起点(『2->5』)で占有者が特定できない場合は従来どおりエラー(誰か分からないものは黙って作らない)。
      pid = occupant(c.from_position);
    }
    if (!pid) throw new Error("守備位置変更: 対象選手を特定できません(player_id か from_position が必要)");
    return [pid, (c.to_position as PositionId) ?? null] as const;
  });
  assertNoDuplicateRoster(parts); // V-B
  const moveMap = new Map(moves);
  const oldPosOf = new Map(base.lineup.map((l) => [l.player_id, l.position_id])); // カスケード判定用の変更前position
  const lineup: LineupEntry[] = base.lineup.map((l) => (moveMap.has(l.player_id) ? { ...l, position_id: moveMap.get(l.player_id)! } : l));
  // ラインアップ外の対象はその場で加える。order は持たせない=打順は別の事実(打席に立てば box 側の paSlots フォールバックが枠を拾う)。
  // 同一守備位置の重複もここではブロックしない(R9 が要確認を出す=既存の網)。roster は insertRetroSnapshot が newLineup から作る。
  const inLineup = new Set(base.lineup.map((l) => l.player_id));
  const added: LineupEntry[] = []; // その場加入したエントリ(後続スナップショットへの伝播対象)
  for (const [pid, pos] of moveMap) {
    if (!inLineup.has(pid)) {
      const entry: LineupEntry = { order: null, position_id: pos, player_id: pid, automatic_out: false };
      lineup.push(entry);
      added.push(entry);
    }
  }
  // [F-1] カスケード: 後続スナップが同じ選手を「変更前position」のまま持つ場合のみ新positionへ追従(明示変更済みは触らない)。
  // [2026-08-18 遡及の無音欠落] 追加エントリは cascadeAdditions で後続の lineup/roster にも伝播する
  //   (位置差し替えのカスケードだけだと、遡及挿入時に加えた選手が挿入スナップショットにしか載らず、
  //    既存の後続スナップショット時点から黙って消える=守備帰属が途切れるため)。
  // 変更前の比較は ?? null で正規化: 対象が base に居なかった(その場加入)場合 oldPosOf は undefined を返すが、
  // 後続に別opの片次元 placeholder(position:null)で既に居ることがある。null は「そのopが管理しない次元の未指定」
  // であって明示値ではないので、undefined と null を同値に扱い遡及値を運ぶ(でないと後続時点から黙って戻る)。
  const cascade = (later: LineupSnapshot): LineupSnapshot => {
    let changed = false;
    const lu = later.lineup.map((l) => {
      if (moveMap.has(l.player_id) && (l.position_id ?? null) === (oldPosOf.get(l.player_id) ?? null)) { changed = true; return { ...l, position_id: moveMap.get(l.player_id)! }; }
      return l;
    });
    return cascadeAdditions(changed ? { ...later, lineup: lu } : later, added);
  };
  return insertRetroSnapshot({ ...doc, participants: parts }, gameId, base, effective_from, lineup, "defensive_change", cascade);
}

// ===== 交代系op(§10.3 Phase C / F-1 遡及安全)共通ヘルパ =====

const efHalfRank = (h: Half) => (h === "top" ? 0 : 1);
/** 有効位置(inning, halfRank, before_order??0)の辞書順比較。 */
function cmpEffPos(a: LineupSnapshot["effective_from"], b: LineupSnapshot["effective_from"]): number {
  return a.inning - b.inning || efHalfRank(a.half) - efHalfRank(b.half) || (a.before_order ?? 0) - (b.before_order ?? 0);
}

/** タイミング(打席粒度)→effective_from。before_order 未指定=その半イニングの既存打席数+1(現行既定)。 */
function resolveEffectiveFrom(doc: GameDoc, timing: OpTiming): LineupSnapshot["effective_from"] {
  if (!timing?.inning || !timing?.half) throw new Error("タイミング(回・表裏)が必要です");
  if (timing.before_order !== undefined) return { inning: timing.inning, half: timing.half, before_order: timing.before_order };
  const n = doc.plate_appearances.filter((p) => p.inning === timing.inning && p.half === timing.half).length;
  return { inning: timing.inning, half: timing.half, before_order: n > 0 ? n + 1 : null };
}

/**
 * [F-1] timing時点の有効スナップショットを土台に取る。latestSnapshot(最大seq)を土台にすると、遡及入力時に
 * 「後の変更を含むlineup」が土台になり、間の打席の投手/守備帰属が壊れる(§10.3差し戻し)。
 */
function effectiveBaseSnapshot(doc: GameDoc, what: string, effective_from: LineupSnapshot["effective_from"]): LineupSnapshot {
  const snaps = doc.lineup_snapshots ?? [];
  if (!snaps.length) throw new Error(`スタメン未登録のため${what}を適用できません`);
  const base = effectiveSnapshot(snaps, effective_from.inning, effective_from.half, effective_from.before_order ?? 0);
  if (!base) throw new Error(`スタメン未登録のため${what}を適用できません`);
  return base;
}

/**
 * [2026-08-18 遡及の無音欠落] 追加エントリの後続伝播。遡及挿入でその場加入した選手(ラインアップ外→参加ベースで追加)を、
 * 既存の後続スナップショットの lineup/roster にも追加する。substitutePlayer の in/out 置換カスケードと同じ
 * 「後続へ差分を運ぶ」流儀＝カスケードが既存エントリの差し替えしか扱わないと、挿入スナップショットにしか
 * 選手が載らず後続時点から黙って消える(守備帰属が途切れる)。後続に既に居る選手は触らない(明示変更済みを壊さない)。
 */
function cascadeAdditions(later: LineupSnapshot, added: LineupEntry[]): LineupSnapshot {
  if (!added.length) return later;
  let lineup = later.lineup;
  let roster = later.roster;
  for (const a of added) {
    if (!lineup.some((l) => l.player_id === a.player_id)) lineup = [...lineup, { ...a }];
    if (!roster.some((r) => r.player_id === a.player_id)) roster = [...roster, { player_id: a.player_id, fielding_team: "N-KINGS", status: "active" }];
  }
  return lineup === later.lineup && roster === later.roster ? later : { ...later, lineup, roster };
}

/**
 * [F-1 §10.3] 交代系opの遡及安全な挿入。
 *  1) base(=timing時点の有効スナップショット)から作った新スナップショットを追記
 *  2) 全スナップショットを有効位置順(seq0=試合開始は常に先頭)にソートし seq/snapshot_id を 0..N で振り直す。
 *     effectiveSnapshot は「有効な中で最大seq」を選ぶので、seq順=有効位置順なら遡及挿入が後続を誤って影にしない。
 *  3) 挿入点より有効位置が後のスナップショットへ差分をカスケード(後続が同じ枠を明示変更済みなら cascade 側で触らない)。
 */
function insertRetroSnapshot(
  doc: GameDoc, gameId: string, base: LineupSnapshot,
  effective_from: LineupSnapshot["effective_from"], newLineup: LineupEntry[], reason: string,
  cascade: (later: LineupSnapshot) => LineupSnapshot,
): GameDoc {
  const snaps = doc.lineup_snapshots ?? [];
  const roster: RosterEntry[] = newLineup.map((l) =>
    base.roster.find((r) => r.player_id === l.player_id) ?? { player_id: l.player_id, fielding_team: "N-KINGS", status: "active" });
  const inserted: LineupSnapshot = {
    game_id: gameId, team: "N-KINGS", snapshot_id: "", seq: -1,
    effective_from, empty_slot_policy: base.empty_slot_policy ?? "skip", roster, lineup: newLineup, reason,
  };
  // カスケード: 挿入点より有効位置が後(strictly)の非start snapshotへ差分適用。
  const cascaded = snaps.map((s) => (s.seq !== 0 && cmpEffPos(s.effective_from, effective_from) > 0 ? cascade(s) : s));
  // 有効位置順で seq/snapshot_id を 0..N に振り直す(startは常に先頭・同位置は元の順序を保つ安定ソート)。
  const startFirst = (s: LineupSnapshot) => (s.seq === 0 ? 0 : 1);
  const ordered = [...cascaded, inserted]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => startFirst(a.s) - startFirst(b.s) || cmpEffPos(a.s.effective_from, b.s.effective_from) || a.i - b.i)
    .map(({ s }, seq) => ({ ...s, seq, snapshot_id: `${gameId}-NK-${String(seq).padStart(2, "0")}` }));
  return { ...doc, lineup_snapshots: ordered };
}

/**
 * [C-2/F-1] 選手交代: out の打順スロット/守備位置に in を入れた遡及安全な新スナップショットを追記。
 * in が未参加のマスタ選手なら参加者を自動追加(交代出場=参加の事実)＋V-B。
 * [§12 P1] 助っ人も種別guestのマスタ選手(player_id)＝in.guest_name は applyOps のラッパで player_id へ解決済み。
 * out の参加者はそのまま残す(出欠は事実)。out が(timing時点の)ラインアップに居なければエラー(黙って無反映にしない)。
 */
function reduceSubstitutePlayer(doc: GameDoc, gameId: string, input: SubstituteInput, masters: Map<string, string>): GameDoc {
  const effective_from = resolveEffectiveFrom(doc, input.timing);
  const base = effectiveBaseSnapshot(doc, "選手交代", effective_from);
  const outId = resolveBatter(doc, input.out) ?? input.out;
  const outEntry = base.lineup.find((l) => l.player_id === outId);
  if (!outEntry) throw new Error("選手交代: 交代で退く選手が現在のラインアップに居ません");
  // in の参加者解決(未参加マスタは自動追加=出場の事実)
  let parts: Participant[] = [...(doc.participants ?? [])];
  let inId: string | undefined;
  if (input.in?.player_id) {
    const raw = input.in.player_id;
    inId = parts.find((p) => p.id === raw)?.id ?? parts.find((p) => p.link.kind === "roster" && p.link.player_id === raw)?.id;
    if (!inId) {
      if (!masters.has(raw)) throw new Error(`選手交代: 選手 ${raw} が見つかりません(マスタ未登録)`);
      inId = nextParticipantId(parts);
      parts.push({ id: inId, link: { kind: "roster", player_id: raw } });
    }
  } else {
    throw new Error("選手交代: 交代で入る選手(選手ID)が必要です");
  }
  assertNoDuplicateRoster(parts); // V-B
  if (inId === outId) throw new Error("選手交代: 同じ選手同士は交代できません");
  if (base.lineup.some((l) => l.player_id === inId)) throw new Error("選手交代: 交代で入る選手は既にラインアップに居ます(守備位置の変更は守備交代で)");
  // 交代出場=participants 在籍で出席は既に表現済み(status概念廃止)。out の参加者もそのまま残す(出欠は事実)。
  const lineup = base.lineup.map((l) =>
    l.player_id === outId
      ? { ...l, player_id: inId!, position_id: input.position !== undefined ? ((input.position as PositionId) ?? null) : l.position_id }
      : l);
  // [F-1] カスケード: 後続に out がまだ居れば in へ置換(order/positionはその後続の値を維持)。居なければ後で別交代済み=触らない。
  const cascade = (later: LineupSnapshot): LineupSnapshot => {
    const inLu = later.lineup.some((l) => l.player_id === outId);
    const inRo = later.roster.some((r) => r.player_id === outId);
    if (!inLu && !inRo) return later;
    return {
      ...later,
      lineup: later.lineup.map((l) => (l.player_id === outId ? { ...l, player_id: inId! } : l)),
      roster: later.roster.map((r) => (r.player_id === outId ? { ...r, player_id: inId! } : r)),
    };
  };
  return insertRetroSnapshot({ ...doc, participants: parts }, gameId, base, effective_from, lineup, input.reason ?? "substitution", cascade);
}

/** [C-2/F-1] 退場: out をラインアップから外すだけの遡及安全な新スナップショット(スロットは欠員=次打者導出がスキップ)。 */
function reduceLeaveGame(doc: GameDoc, gameId: string, input: LeaveGameInput): GameDoc {
  const effective_from = resolveEffectiveFrom(doc, input.timing);
  const base = effectiveBaseSnapshot(doc, "退場", effective_from);
  const outId = resolveBatter(doc, input.out) ?? input.out;
  if (!base.lineup.some((l) => l.player_id === outId)) throw new Error("退場: 対象選手が現在のラインアップに居ません");
  const lineup = base.lineup.filter((l) => l.player_id !== outId);
  // [F-1] カスケード: 後続に out がまだ居れば除去(後で別交代で消えていれば触らない)。
  const cascade = (later: LineupSnapshot): LineupSnapshot =>
    later.lineup.some((l) => l.player_id === outId) ? { ...later, lineup: later.lineup.filter((l) => l.player_id !== outId) } : later;
  return insertRetroSnapshot(doc, gameId, base, effective_from, lineup, input.reason ?? "left", cascade);
}

/**
 * [C-3/F-1] 打順変更: 指定選手の order だけ差し替えた遡及安全な新スナップショット(reason:"order_change")。
 * 5番6番交換は rows 2件で表現。同一 order の重複が生じたらエラー(片側だけの変更で二重スロットを作らせない)。
 * [2026-08-18 参加ベース化] 対象がラインアップに居なくてもエラーにしない=「どの打順枠か」は参加/守備位置と並ぶ
 * 独立した事実(「ベンチ」という機構は無い=母集団は participants のみ・出し入れ自由)。reduceChangeDefense の
 * 新経路と同流儀で参加者解決し、position_id:null(位置はその後の changeDefense が与える)で枠へ加える。
 * masters に無いIDは従来どおりエラー(誰か分からないものは黙って作らない)。
 */
function reduceChangeBattingOrder(doc: GameDoc, gameId: string, input: ChangeOrderInput, masters: Map<string, string> = new Map()): GameDoc {
  if (!input.rows?.length) throw new Error("打順変更: 対象の選手が指定されていません");
  const effective_from = resolveEffectiveFrom(doc, input.timing);
  const base = effectiveBaseSnapshot(doc, "打順変更", effective_from);
  const parts: Participant[] = [...(doc.participants ?? [])];
  const moves = new Map<string, number | null>();
  const addedMap = new Map<string, LineupEntry>(); // その場加入(後続伝播対象)。Mapで同一選手の重複行を自然に統合(後勝ち=movesと同じ)
  for (const row of input.rows) {
    let pid = resolveBatter(doc, row.player) ?? row.player;
    if (!base.lineup.some((l) => l.player_id === pid)) {
      // ラインアップ外=参加者解決してその場で枠へ加える(未参加のマスタ選手は参加者を自動追加=枠に入る=参加の事実)。
      const found = parts.find((p) => p.id === pid)?.id
        ?? parts.find((p) => p.link.kind === "roster" && p.link.player_id === pid)?.id; // 同一op内で追加済みのマスタID参照も拾う
      if (found) {
        pid = found;
      } else {
        if (!masters.has(pid)) throw new Error(`打順変更: 選手 ${pid} が見つかりません(マスタ未登録)`);
        const nid = nextParticipantId(parts);
        parts.push({ id: nid, link: { kind: "roster", player_id: pid } });
        pid = nid;
      }
      addedMap.set(pid, { order: row.order, position_id: null, player_id: pid, automatic_out: false });
    }
    moves.set(pid, row.order);
  }
  const added = [...addedMap.values()];
  assertNoDuplicateRoster(parts); // V-B
  const oldOrderOf = new Map(base.lineup.map((l) => [l.player_id, l.order])); // カスケード判定用の変更前order
  const lineup = [...base.lineup.map((l) => (moves.has(l.player_id) ? { ...l, order: moves.get(l.player_id)! } : l)), ...added];
  // 同一orderの重複はエラー(黙って壊さない)
  const seen = new Map<number, string>();
  for (const l of lineup) {
    if (l.order == null) continue;
    if (seen.has(l.order)) throw new Error(`打順変更: 打順${l.order}が重複します(交換は2人ぶんを同時に指定してください)`);
    seen.set(l.order, l.player_id);
  }
  // [F-1] カスケード: 後続が対象選手を「変更前order」のまま持つ場合のみ新orderへ(既に別値=後で更に変更済み=触らない)。
  //   比較は ?? null 正規化(その場加入=oldは undefined、後続の position/order null は「管理外次元のplaceholder」=同値扱い。
  //   changeDefense 側カスケードと同じ理由=でないと遡及値が後続時点から黙って戻る)。
  // [2026-08-18 遡及の無音欠落] 追加エントリは cascadeAdditions で後続の lineup/roster にも伝播(changeDefense と同じ穴を塞ぐ)。
  // [打順の後続占有] カスケード先で同じ order を別選手が明示保持している場合、その後続時点の明示が勝つ=
  //   運んだ order は null に落とす(枠は物理的に1人。後続の明示変更=「枠を引き継いだ」の意味。二重占有を黙って作らない)。
  const yieldToLaterOwner = (lu: LineupEntry[]): LineupEntry[] => {
    const targets = new Set([...moves.keys(), ...added.map((a) => a.player_id)]);
    let yielded = false;
    const out = lu.map((l) => {
      if (l.order == null || !targets.has(l.player_id)) return l;
      const owner = lu.find((x) => x.player_id !== l.player_id && x.order === l.order && !targets.has(x.player_id));
      if (!owner) return l;
      yielded = true;
      return { ...l, order: null };
    });
    return yielded ? out : lu;
  };
  const cascade = (later: LineupSnapshot): LineupSnapshot => {
    let changed = false;
    const lu = later.lineup.map((l) => {
      if (moves.has(l.player_id) && (l.order ?? null) === (oldOrderOf.get(l.player_id) ?? null)) { changed = true; return { ...l, order: moves.get(l.player_id)! }; }
      return l;
    });
    const withAdds = cascadeAdditions(changed ? { ...later, lineup: lu } : later, added);
    const resolved = yieldToLaterOwner(withAdds.lineup);
    return resolved === withAdds.lineup ? withAdds : { ...withAdds, lineup: resolved };
  };
  return insertRetroSnapshot({ ...doc, participants: parts }, gameId, base, effective_from, lineup, "order_change", cascade);
}

/**
 * [C-5] 投手記録(投手別の自責点・勝敗S)＝doc.pitching の全置換。記録値(三分類B)。
 * player は参加者へ解決する。参加者に居なければエラー(登板していない投手に記録は付かない＝自動参加はしない)。
 */
function reduceSetPitchingRecords(doc: GameDoc, records: PitchingRecordInput[]): GameDoc {
  const parts = doc.participants ?? [];
  const seen = new Set<string>();
  const pitching: PitchingRecord[] = (records ?? []).map((r) => {
    const pid = resolveBatter(doc, r.player) ?? r.player;
    if (!parts.some((p) => p.id === pid)) throw new Error(`投手記録: 「${r.player}」はこの試合の参加者に居ません(登板した投手は出欠/交代で先に参加者にしてください)`);
    if (seen.has(pid)) throw new Error("投手記録: 同じ投手が複数行あります");
    seen.add(pid);
    // [クラスタA minor①] earned_runs は number(0以上) か null(不明)。null=自責不明を第一級表現(勝敗Sだけ付けたい投手を落とさない)。
    //   ただし自責も勝敗Sも無い空record は意味が無いので従来どおり拒否。
    if (r.earned_runs !== null && (typeof r.earned_runs !== "number" || r.earned_runs < 0)) throw new Error("投手記録: 自責点は0以上の数値または不明(null)が必要です");
    if (r.earned_runs === null && r.decision == null) throw new Error("投手記録: 自責点も勝敗Sも無い記録は作れません");
    return { pitcher_id: pid, earned_runs: r.earned_runs, ...(r.decision !== undefined ? { decision: r.decision } : {}) };
  });
  return { ...doc, pitching };
}

/** 数値フィールドだけを持つ疎オブジェクトを正規化(空/非数値キーを落とす。decisionは非null文字列を残す)。全空なら undefined。 */
function pruneNumeric<T>(o: T | null | undefined): Partial<T> | undefined {
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (k === "decision") { if (v != null) out[k] = v; continue; }
    if (typeof v === "number" && !Number.isNaN(v)) out[k] = v;
  }
  return Object.keys(out).length ? (out as Partial<T>) : undefined;
}

/**
 * [§0/§11 断片試合] doc.direct_stats を全置換(setPitchingRecords 同型)。
 *  - origin は "manual" に強制(人の明示＝導出射程外)。
 *  - **V-D**: participant_id がこの試合の参加者に無ければ書込時 throw で拒否(幽霊guest行を根絶・reduceSetPitchingRecords と同型)。
 *  - 空欄=None＝0埋めしない: 全フィールド空の line と空の sub-object は落とす(疎入力を保つ)。
 */
function reduceSetDirectStats(doc: GameDoc, stats: DirectStatLine[]): GameDoc {
  const parts = doc.participants ?? [];
  const seen = new Set<string>();
  const direct_stats: DirectStatLine[] = [];
  for (const s of stats ?? []) {
    const pid = resolveBatter(doc, s.participant_id) ?? s.participant_id;
    if (!parts.some((p) => p.id === pid)) throw new Error(`個人成績(断片): 「${s.participant_id}」はこの試合の参加者に居ません(出欠で先に参加者にしてください)`);
    if (seen.has(pid)) throw new Error("個人成績(断片): 同じ選手が複数行あります");
    seen.add(pid);
    const batting = pruneNumeric<DirectBatting>(s.batting);
    const pitching = pruneNumeric<DirectPitching>(s.pitching);
    const fielding = pruneNumeric<DirectFielding>(s.fielding);
    const hasNote = s.note != null && s.note !== "";
    const hasAnn = !!s.annotations?.length;
    if (!batting && !pitching && !fielding && !hasNote && !hasAnn) continue; // 全空の line は保存しない(疎入力)
    direct_stats.push({
      participant_id: pid,
      ...(batting ? { batting } : {}),
      ...(pitching ? { pitching } : {}),
      ...(fielding ? { fielding } : {}),
      origin: "manual", // 常に manual に強制
      ...(hasNote ? { note: s.note } : {}),
      ...(hasAnn ? { annotations: s.annotations } : {}),
    });
  }
  return { ...doc, direct_stats };
}

/** [§0/§11] manual_runs 入力 → origin:"manual" の RunEvent 群。runner_id=null=得点(走者不明)。rbi 既定 true。 */
function buildManualRuns(input?: ManualRunInput[]): RunEvent[] {
  return (input ?? []).map((m) => ({
    runner_id: m.runner_id ?? null,
    rbi: m.rbi !== false, // 既定 true(打者に打点を付ける)
    // [クラスタA A4] 人の明示run(得点)は自責か否かを主張していない＝null(不明)。runner_id=null と平行。0/確定に潰さない。
    earned: null,
    cause: "other" as const,
    origin: "manual" as const,
  }));
}

/**
 * 人物参照の解決(§9): 参照言語(参加者ID / 選手マスタID / 助っ人名 / "GUEST:名前")→その試合の参加者ID。
 * IDの接頭辞で身元を推論しない＝参加者リストのメンバーシップで解決する。
 * 未解決はそのまま返す(弾かずvalidatorがR2タグ＝雑な入力を黙って受け入れも握り潰しもしない)。
 */
function resolveBatter(doc: GameDoc, raw?: string): string | undefined {
  if (!raw) return undefined;
  const parts = doc.participants ?? [];
  if (parts.some((p) => p.id === raw)) return raw; // 既に参加者ID
  const byMaster = parts.find((p) => p.link.kind === "roster" && p.link.player_id === raw);
  if (byMaster) return byMaster.id; // 選手マスタIDでの参照
  const name = raw.replace(/^GUEST:\s*/i, "").trim();
  const byName = parts.find((p) => p.link.kind === "guest" && p.link.name === name);
  return byName ? byName.id : raw;
}

/**
 * 打者参照が「マスタに実在するがこの試合に未参加」の選手なら、参加者を自動追加して解決する(代打等)。
 * 打席に立つ＝参加の事実そのもの(出欠=participants)なので、参加者の自動追加は出欠の自動記帳と同義。
 */
function ensureBatterParticipant(doc: GameDoc, raw: string | undefined, masters: Map<string, string>): { doc: GameDoc; id?: string } {
  if (!raw) return { doc };
  const r = resolveBatter(doc, raw);
  const parts = doc.participants ?? [];
  if (r && parts.some((p) => p.id === r)) return { doc, id: r };
  if (masters.has(raw)) {
    const next = [...parts];
    const nid = nextParticipantId(next);
    next.push({ id: nid, link: { kind: "roster", player_id: raw } });
    assertNoDuplicateRoster(next);
    return { doc: { ...doc, participants: next }, id: nid };
  }
  return { doc, id: r }; // 未解決(相手プレースホルダ含む)はそのまま
}

/** 打席内の全 runner_id(run_overrides/baserunning/代走/打球アウト) も同様に解決する(走塁が助っ人名のままにならないように)。 */
function normRunnerIds<T extends AddPAInput | EditPAInput>(doc: GameDoc, input: T): T {
  const r = (id?: string | null) => (id ? resolveBatter(doc, id) ?? id : id) as string;
  // 打球アウトの走者(fielding.outs)も人物参照=同じ解決を通す。ここだけ解決が抜けると、AIがマスタID(P011等)を
  // 几帳面に埋めるモデル(Sol実測)で全打席がR2「未登録の選手ID」化する(2026-08-22 実障害)。
  // 型は構造的に受ける: 打席直下(Fielding=hit_to必須)と打席中イベント(BaserunDuring.fielding)で形が違うため。
  const fo = <F extends { outs?: { at: string; type: string; runner_id?: string | null }[] } | null | undefined>(f: F): F =>
    (f?.outs ? { ...f, outs: f.outs.map((o) => ({ ...o, runner_id: r(o.runner_id) })) } : f);
  return {
    ...input,
    fielding: fo(input.fielding),
    run_overrides: input.run_overrides?.map((x) => ({ ...x, runner_id: r(x.runner_id), ...(x.responsible_pitcher_id ? { responsible_pitcher_id: r(x.responsible_pitcher_id) } : {}) })),
    baserunning_after: input.baserunning_after?.map((m) => ({ ...m, runner_id: r(m.runner_id) })),
    baserunning_during: input.baserunning_during?.map((ev) => ({ ...ev, runners: ev.runners?.map((m) => ({ ...m, runner_id: r(m.runner_id) })), fielding: fo(ev.fielding) })),
    pinch_runner: input.pinch_runner
      ? { ...input.pinch_runner, runner_id: r(input.pinch_runner.runner_id), ...(input.pinch_runner.replaced_id ? { replaced_id: r(input.pinch_runner.replaced_id) } : {}) }
      : input.pinch_runner,
  };
}

/**
 * [§10.6] run_overrides＝記録帰属(責任投手)の手動上書き＝人の明示(記録値)。
 * runs[](auto導出)へ畳まず doc レベルの run_overrides ストア(pa_idキー)へ永続化する＝自動と手動の同居を解消。
 * read(集計/検査/表示)時に deriveResponsiblePitchers が auto 導出へ最優先で被せる。自責フラグ(earned)は導出の近似(正本=投手記録)。
 */
function overrideRunsAt(doc0: GameDoc, index: number, overrides?: RunOverrideInput[]): GameDoc {
  if (!overrides?.length) return doc0;
  // 対象PAへ不変IDを確保(run_overrides は pa_id キー。新規打席はここで採番し、末尾の ensurePAIds が再採番しない)。
  const doc = ensurePAIds(doc0);
  const pa = doc.plate_appearances[index];
  const paId = pa.id!;
  const store: RunOverride[] = [...(doc.run_overrides ?? [])];
  for (const o of overrides) {
    const entry: RunOverride = { pa_id: paId, runner_id: o.runner_id, responsible_pitcher_id: o.responsible_pitcher_id ?? null, origin: "manual" };
    const j = store.findIndex((s) => s.pa_id === paId && s.runner_id === o.runner_id);
    if (j >= 0) store[j] = entry; else store.push(entry);
  }
  return { ...doc, run_overrides: store };
}

/** [C-6] Add/Edit/Insert 共通: 入力の事実フィールド(振り逃げ/申告敬遠/自動アウト/代走)を PA へ写す。 */
function assignPAFactFields(pa: PlateAppearance, input: AddPAInput | EditPAInput): PlateAppearance {
  const next = { ...pa };
  if (input.dropped_third_strike !== undefined) next.dropped_third_strike = input.dropped_third_strike;
  if (input.intentional !== undefined) next.intentional = input.intentional;
  if (input.automatic_out !== undefined) next.automatic_out = input.automatic_out;
  if (input.double_play !== undefined) next.double_play = input.double_play;
  if (input.triple_play !== undefined) next.triple_play = input.triple_play;
  if (input.pinch_runner !== undefined) next.pinch_runner = input.pinch_runner;
  // [§10.6] 開始時アウトの明示入力(主張値=4-5アウト回/特別ルール)。number=保持(sweepは上書きしない)/null=未主張(read時導出)。
  if (input.outs !== undefined) next.outs = input.outs;
  // [§14.1 研究A・見送り中] stated_*(状態記載の転記)は搬送しない=保存経路ごと不活性。
  //   検証済みのR11(validate.ts)とテストは研究成果として残置。再開時はAIスキーマ公開+ここで input.stated_* を運ぶ(DESIGN §14.1)。
  return next;
}

/**
 * 打席を1件追加。order/打順/開始時アウト/(省略時の)打者はサーバが導出。
 * §9: 投捕は保存しない(スナップ解決一本)・開始時走者も保存しない(毎回導出が正本)・
 * 側は打者の参加者メンバーシップで判定(接頭辞は見ない)・相手は opponent_slot＋プレースホルダ。
 */
function reduceAddPA(doc0: GameDoc, rawInput: AddPAInput, masters: Map<string, string>): { doc: GameDoc; placed: { inning: number; half: Half; order: number } } {
  const ens = ensureBatterParticipant(doc0, rawInput.batter_id, masters); // 代打等=未参加のマスタ選手を自動参加
  // 代走(pinch_runner)も未参加マスタなら自動参加(塁に立つ=参加の事実。打者と同じ扱い)
  const doc = ensureBatterParticipant(ens.doc, rawInput.pinch_runner?.runner_id, masters).doc;
  const input = normRunnerIds(doc, rawInput);
  const raw = ens.id;
  // どの half-inning に置くかはサーバが決める(形式ルールは課さない＝側で決める)。
  // 側=打者が参加者(自軍側リスト)なら自軍、プレースホルダ(oN)なら相手、未指定は直前の側を継続。
  const isKingsBatter = !!raw && (doc.participants ?? []).some((p) => p.id === raw);
  const side = input.half !== undefined ? undefined
    : input.batter_id === undefined ? undefined
    : isKingsBatter ? ("kings" as const)
    : /^o\d+$/.test(input.batter_id) ? ("opponent" as const)
    : ("kings" as const); // 未解決の自軍風参照(validatorがR2タグ)も自軍側に置く
  const { inning, half } = resolvePATarget(doc, { inning: input.inning, half: input.half, side });
  const d = deriveNextPA(doc, inning, half);
  const isKingsHalf = half === kingsBatHalf(doc);
  // スロットは記録値(§10.3三分類B): 入力指定を優先、未指定はサーバ導出。相手はスロット指定時 batter_id も oN へ追従。
  const batting_slot = isKingsHalf && input.batting_slot !== undefined ? input.batting_slot : d.batting_slot;
  const opponent_slot = !isKingsHalf && input.opponent_slot !== undefined ? input.opponent_slot : d.opponent_slot;
  // 自軍攻撃なら明示打者→打順。相手攻撃は選手を追跡しない=プレースホルダ(oN)一本。
  const batter_id = isKingsHalf ? (raw ?? d.batter_id) : (opponent_slot != null ? `o${opponent_slot}` : d.batter_id);
  if (!batter_id) throw new Error("打者が特定できません(打順未登録なら batter_id を指定)");
  let pa: PlateAppearance = {
    inning, half, order: d.order, batting_slot,
    ...(opponent_slot != null ? { opponent_slot } : {}),
    outs: null, batter_id, // [§10.6] outsは未主張=null(read時に導出)。input.outs 明示時のみ assignPAFactFields が主張値を入れる
    result: input.result, complete: input.complete ?? true,
    runs: [], fielding: input.fielding ?? null,
    // runner_id省略の入力は直後の resolveBaserunningIds が from塁の走者で確定する
    baserunning_during: (input.baserunning_during ?? []) as BaserunDuring[],
    baserunning_after: (input.baserunning_after ?? []) as BaserunMove[],
    note: input.note ?? null,
    ...(input.annotations?.length ? { annotations: input.annotations } : {}),
  };
  pa = assignPAFactFields(pa, input); // [C-6] 振り逃げ/申告敬遠/自動アウト/代走/(§10.6)outs主張
  const resolved = resolveBaserunningIds(d.runners, pa); // 走塁runner_idをfrom-baseで確定(新規入力=IDを信用しない解決)
  // runs[]はエンジンが導出(得点者/打点)。[§0/§11] manual_runs(得点(走者不明)等)は origin:"manual" で畳み込み保全する。
  const finalPa = { ...resolved, runs: mergeManualRuns(deriveRuns(d.runners, resolved), buildManualRuns(input.manual_runs)) };
  // スイープ(§10.6): この追加打席のみ再導出(reDerive)。下流の別打席は非破壊で保持・order連番のみ振り直し。
  let next = sweepHalfInning({ ...doc, plate_appearances: [...doc.plate_appearances, finalPa] }, inning, half, new Set([finalPa]), masters);
  next = overrideRunsAt(next, next.plate_appearances.length - 1, input.run_overrides); // [§10.6] 責任投手の手動上書き→doc.run_overrides
  return { doc: next, placed: { inning, half, order: d.order } };
}

function findPAIndex(doc: GameDoc, inning: number, half: Half, order: number): number {
  return doc.plate_appearances.findIndex((p) => p.inning === inning && p.half === half && p.order === order);
}

/** §10.3 打席不変ID(b1..)の遅延採番。op適用のたびに未採番の打席へ振る(旧データは初回opで自動移行)。 */
function ensurePAIds(doc: GameDoc): GameDoc {
  let mx = 0;
  for (const p of doc.plate_appearances) {
    const m = /^b(\d+)$/.exec(p.id ?? "");
    if (m) mx = Math.max(mx, Number(m[1]));
  }
  let changed = false;
  const pas = doc.plate_appearances.map((p) => {
    if (p.id) return p;
    changed = true;
    return { ...p, id: `b${++mx}` };
  });
  return changed ? { ...doc, plate_appearances: pas } : doc;
}

/** 打席のアドレス解決: 不変ID(pa_id)優先。無ければ(回/表裏/order)。IDが見つからない=画面が古い(削除済み等)。 */
function locatePA(doc: GameDoc, input: { pa_id?: string; inning: number; half: Half; order: number }): number {
  if (input.pa_id) {
    const i = doc.plate_appearances.findIndex((p) => p.id === input.pa_id);
    if (i < 0) throw new Error("対象の打席が見つかりません（削除済みか、画面が古い可能性）。再読み込みしてください");
    return i;
  }
  return findPAIndex(doc, input.inning, input.half, input.order);
}

/**
 * [§10.6 非破壊スイープ] 打席の追加/編集/挿入/削除の後、当該半イニングを先頭から走査する。
 *  維持: (i) order連番の振り直し(k+1)。
 *  非破壊(撤去した破壊): 保存 runs[](正本・manual含む) と 保存 outs(主張値) を上書きしない。
 *    再導出は reDerive に含まれる打席(=今回の編集/追加/挿入対象)のみ。下流の別打席は保存値を保持する
 *    (幽霊得点=上流編集で盤面から消えた走者の生還は「黙って0にする」のでなく保持し、R1/R3 が食い違いを flag する)。
 *  責任投手は sweep では書かない＝read時(deriveResponsiblePitchers)へ移動(§10.6 item9)。手動上書きは doc.run_overrides。
 *  outs はここでは触らない＝主張値/未設定のまま(read時に derivePAStates が未設定を盤面から導出)(§10.6 item7)。
 * @param reDerive 再導出を許可する打席(オブジェクト同一性)。未指定=どの打席も再導出しない(order振り直しのみ)。
 * @param masters 走者ID再解決の注記を名前で出すためのマスタ(任意)。未指定=IDのまま(内部コード非露出は呼び出し側が masters を渡す)。
 */
function sweepHalfInning(doc: GameDoc, inning: number, half: Half, reDerive?: Set<PlateAppearance>, masters?: Map<string, string>): GameDoc {
  const targets = doc.plate_appearances
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p.inning === inning && x.p.half === half)
    .sort((a, b) => a.p.order - b.p.order);
  if (!targets.length) return doc;
  const pas = [...doc.plate_appearances];
  let board: Runners = { first: null, second: null, third: null };
  targets.forEach(({ p, i }, k) => {
    let next: PlateAppearance = { ...p, order: k + 1 }; // order連番の振り直しのみ(outs/runsは非破壊で保持)
    if (reDerive?.has(p)) {
      // この打席のみ再導出(編集/追加/挿入対象)。下流の別打席(保存runs=manual含む)は保持し上書きしない。
      const prev = p;
      next = resolveBaserunningIds(board, next, { respectIds: true });
      // 走者IDの変化を positional 差分で検出 → 守備アウト側へ追従＋要確認(食い違いを黙って通さない)
      const renames = new Map<string, string>();
      const diffMoves = (a?: { runner_id: string }[] | null, b?: { runner_id: string }[] | null) => {
        (a ?? []).forEach((m, j) => {
          const nb = (b ?? [])[j];
          if (nb && m.runner_id && nb.runner_id && m.runner_id !== nb.runner_id) renames.set(m.runner_id, nb.runner_id);
        });
      };
      diffMoves(prev.baserunning_after, next.baserunning_after);
      (prev.baserunning_during ?? []).forEach((ev, j) => diffMoves(ev.runners, next.baserunning_during?.[j]?.runners));
      if (renames.size) {
        const ren = (id?: string | null) => (id && renames.has(id) ? renames.get(id)! : id);
        if (next.fielding?.outs?.length) {
          next = { ...next, fielding: { ...next.fielding, outs: next.fielding.outs.map((o) => ({ ...o, runner_id: ren(o.runner_id) })) } };
        }
        if (next.baserunning_during?.some((ev) => ev.fielding?.outs?.length)) {
          next = { ...next, baserunning_during: next.baserunning_during!.map((ev) => (ev.fielding?.outs?.length ? { ...ev, fielding: { ...ev.fielding, outs: ev.fielding.outs.map((o) => ({ ...o, runner_id: ren(o.runner_id) })) } } : ev)) };
        }
        // [[feedback_no_internal_codes_to_user]] 走者ID(参加者ID m9 等)を生で出さず名前で示す。
        //   masters 未注入時のみ id へフォールバック(純ロジック経路)。oN(相手プレースホルダ)は「相手N番」に解決される。
        const nameOf = masters ? docNameResolver(doc, masters) : (id: string) => id;
        const detail = `走者を盤面に追従して再解決: ${[...renames.entries()].map(([a, b]) => `${nameOf(a)}→${nameOf(b)}`).join(", ")}（上流の変更の波及。違っていれば修正してください）`;
        next = { ...next, annotations: [...(next.annotations ?? []), { type: "unclear", detail, source: "manual" }] };
      }
      // runs再生成(origin=auto)。責任投手は書かない＝read時に導出。
      // [§0/§11 非破壊] 前バージョンの origin:"manual" run(得点(走者不明)等・人の明示)は
      //   再導出(auto)結果とマージして保全する(黙って消さない)。null-manual は常に保持・runner_idキーで重複回避。
      next = { ...next, runs: mergeManualRuns(deriveRuns(board, next), prev.runs) };
    }
    pas[i] = next;
    board = foldRunners(board, next);
  });
  return { ...doc, plate_appearances: pas };
}

/** 既存打席を編集。渡したフィールドだけ差し替え、注記未指定なら不明瞭(unclear)は解決済みとして除去。 */
function reduceEditPA(doc0: GameDoc, rawInput: EditPAInput, masters: Map<string, string>): GameDoc {
  const ens = ensureBatterParticipant(doc0, rawInput.batter_id, masters); // 打者差し替え先が未参加マスタ選手なら自動参加
  // 代走(pinch_runner)も未参加マスタなら自動参加(塁に立つ=参加の事実)
  const doc = ensureBatterParticipant(ens.doc, rawInput.pinch_runner?.runner_id, masters).doc;
  const input = normRunnerIds(doc, rawInput);
  const idx = locatePA(doc, input); // 不変ID優先(§10.3)
  if (idx < 0) throw new Error(`${input.inning}回${input.half === "top" ? "表" : "裏"} ${input.order}番目の打席が見つかりません`);
  const cur = doc.plate_appearances[idx];
  let next: PlateAppearance = { ...cur };
  if (input.batter_id !== undefined) next.batter_id = ens.id ?? input.batter_id;
  if (input.result !== undefined) next.result = input.result;
  if (input.complete !== undefined) next.complete = input.complete;
  if (input.fielding !== undefined) next.fielding = input.fielding;
  // runner_id省略の入力は直後の resolveBaserunningIds が from塁の走者で確定する
  if (input.baserunning_during !== undefined) next.baserunning_during = input.baserunning_during as BaserunDuring[];
  if (input.baserunning_after !== undefined) next.baserunning_after = input.baserunning_after as BaserunMove[];
  if (input.note !== undefined) next.note = input.note;
  // [クラスタB2] 機械生成の不明瞭注記＝source:"validator"(applyValidationが冪等再生成)/ source:"ai"(同AI経路が再付与)。
  //   これらは編集で落としても情報損失が無い(すぐ再生成される)。逆に source:"manual" の unclear(人/移行が明示保持した
  //   「要確認」・§10.6のrename注記等)や type:"resolved" の承認(人が明示した永続注記)は温存＝機械編集が人の明示を黙って破壊しない。
  const isMachineUnclear = (a: Annotation) => a.type === "unclear" && (a.source === "validator" || a.source === "ai");
  if (input.annotations !== undefined) {
    // annotations明示(AI再解釈でaiUnclear併発 / addManualNote等)経路。全置換でなくマージ:
    //   人明示注記(manual unclear・resolved・manual・other)は温存し、機械生成unclearだけ input.annotations(新しい注記)で入替。
    //   同一内容(type/detail/source/rule)の二重付与は避ける。→ clear_unclear経路と「人明示は温存・機械生成は入替」で一貫。
    const kept = (next.annotations ?? []).filter((a) => !isMachineUnclear(a));
    const same = (x: Annotation, y: Annotation) => x.type === y.type && x.detail === y.detail && x.source === y.source && (x.rule ?? null) === (y.rule ?? null);
    next.annotations = [...kept, ...input.annotations.filter((a) => !kept.some((k) => same(k, a)))];
  }
  // clear_unclear(AI再解釈がannotations無しで送る場合)経路も同じ判定＝validator/ai由来だけ解決扱い・manualは温存。
  else if (input.clear_unclear && next.annotations?.length)
    next.annotations = next.annotations.filter((a) => !isMachineUnclear(a));
  next = assignPAFactFields(next, input); // [C-6] 振り逃げ/申告敬遠/自動アウト/代走
  // [C-6] スロット=記録値の修復経路(§10.3)。相手PAの opponent_slot 変更は batter_id(プレースホルダ oN)も追従。
  if (input.batting_slot !== undefined) next.batting_slot = input.batting_slot;
  if (input.opponent_slot !== undefined) {
    next.opponent_slot = input.opponent_slot;
    if (cur.half !== kingsBatHalf(doc) && input.opponent_slot != null) next.batter_id = `o${input.opponent_slot}`;
  }
  // [§0/§11] manual_runs 明示時は origin:"manual" run を全置換(auto は直後のスイープが再導出する)。
  //   未指定なら既存の manual run はそのまま(スイープが非破壊で保全)。
  if (input.manual_runs !== undefined) {
    next.runs = [...next.runs.filter((r) => r.origin !== "manual"), ...buildManualRuns(input.manual_runs)];
  }
  const pas = [...doc.plate_appearances];
  pas[idx] = next;
  // スイープ(§10.6 非破壊): 編集した当該打席のみ再導出(reDerive)。同半イニングの下流の別打席は保存 runs[](manual含む)/outs を
  //   そのまま保持し上書きしない。上流編集で盤面から消えた走者の生還(幽霊得点)は黙って0にせず保持し、R1/R3 が食い違いを flag する。
  const swept = sweepHalfInning({ ...doc, plate_appearances: pas }, cur.inning, cur.half, new Set([next]), masters);
  // [§10.6] run_overrides: 責任投手の手動上書きを doc.run_overrides へ永続化(runs[]へ畳まない)
  return overrideRunsAt(swept, idx, input.run_overrides);
}

/** 既存打席を削除し、その half-inning の order を 1..N に振り直す。
 * 交代スナップショットの有効境界(before_order)も同じ半イニング内で再マップする
 * (§10.3 実バグ①: 削除した打席より後ろを指す境界は1つ繰り上げないと、以降の投手成績・守備帰属が1打席ズレる)。
 * [F-3] shift_slots(既定true)＝insertと対称に、削除PAより後(同攻撃側・回またぎ)の打順スロットを-1(一巡)戻す
 *   (相手PAは batter_id=oN も追従)。insert(shift)→remove(shift)の往復でスロットが恒等に戻る。 */
function reduceRemovePA(doc: GameDoc, input: RemovePAInput): GameDoc {
  const idx = locatePA(doc, input); // 不変ID優先(§10.3)
  if (idx < 0) throw new Error(`${input.inning}回${input.half === "top" ? "表" : "裏"} ${input.order}番目の打席が見つかりません`);
  const target = doc.plate_appearances[idx];
  const { inning, half, order } = target; // 対象の現在アドレス(pa_id指定時はinput側が古い可能性)
  const remaining = doc.plate_appearances.filter((_, i) => i !== idx);
  // 同じ half-inning を order 連番に振り直す(歯抜け回避)
  const renumber = new Map<PlateAppearance, number>();
  remaining.filter((p) => p.inning === inning && p.half === half).sort((a, b) => a.order - b.order)
    .forEach((p, i) => renumber.set(p, i + 1));
  // [§10.6 item11] 後続打席のスロット機械回転(unbump/mod9)は撤去＝観測記録値(打順スロット)を機械再計算しない(データ破壊防止)。
  //   order連番の詰め直しと交代境界の再マップは維持。
  const pas = remaining.map((p) => renumber.has(p) ? { ...p, order: renumber.get(p)! } : p);
  // 交代境界の再マップ: 削除打席より後ろ(before_order > 削除order)は繰り上げ。==削除order は次の打席(同番号を継承)を指すので不変。
  const snaps = (doc.lineup_snapshots ?? []).map((s) => {
    const ef = s.effective_from;
    if (ef.inning === inning && ef.half === half && ef.before_order != null && ef.before_order > order) {
      return { ...s, effective_from: { ...ef, before_order: ef.before_order - 1 } };
    }
    return s;
  });
  // スイープ(§10.6 非破壊): 削除で上流盤面が変わっても下流の別打席は再導出せず保存 runs[]/outs を保持(reDeriveなし)。
  //   盤面から消えた走者の生還(幽霊得点)は黙って0にせず保持し、R1/R3 が食い違いを flag する。order連番のみ振り直し。
  return sweepHalfInning({ ...doc, plate_appearances: pas, lineup_snapshots: snaps }, inning, half);
}

/**
 * [C-1] 打席の挿入(記録漏れの後入れ)。after_pa_id の直後(null/未指定=半イニング先頭)へ置き、
 *  (1) 後続打席の order を+1 (2) 挿入位置より後を指す交代境界(before_order)を+1で再マップ
 *  (3) スロットは記録値: 挿入PAは入力優先・未指定は直前打席のスロット+1(一巡)。後続打席のスロットは
 *      shift_slots(既定true)で+1シフト(一巡・相手PAは batter_id=oN も追従)。falseは据え置き(特殊挿入用)
 *  (4) スイープで盤面・保存アウト・runs を再導出。不変IDは applyOps 末尾の ensurePAIds が採番する。
 */
function reduceInsertPA(doc0: GameDoc, rawInput: InsertPAInput, masters: Map<string, string>): { doc: GameDoc; placed: { inning: number; half: Half; order: number } } {
  if (!rawInput.inning || !rawInput.half) throw new Error("挿入には回(inning)と表裏(half)の指定が必要です");
  const ens = ensureBatterParticipant(doc0, rawInput.batter_id, masters); // 未参加マスタ選手は自動参加
  const doc = ensureBatterParticipant(ens.doc, rawInput.pinch_runner?.runner_id, masters).doc;
  const input = normRunnerIds(doc, rawInput) as InsertPAInput;
  const { inning, half } = input;
  // 挿入位置(=新PAが得るorder): after_pa_id の直後 / null・未指定=先頭
  let insertOrder = 1;
  if (input.after_pa_id) {
    const anchor = doc.plate_appearances.find((p) => p.id === input.after_pa_id);
    if (!anchor) throw new Error("挿入位置の打席が見つかりません（削除済みか、画面が古い可能性）。再読み込みしてください");
    if (anchor.inning !== inning || anchor.half !== half) throw new Error("挿入位置の打席が指定の半イニングにありません");
    insertOrder = anchor.order + 1;
  }
  const isKingsHalf = half === kingsBatHalf(doc);
  // 挿入PA自身の既定スロット導出用の上限(有効スナップショットの実打順数。無ければ9)。deriveNextPA同流の assist(この新PA限定の提案)。
  const effSnap = effectiveSnapshot(doc.lineup_snapshots ?? [], inning, half, insertOrder);
  const slots = [...(effSnap?.lineup ?? [])].filter((e) => e.order != null).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const maxSlot = isKingsHalf ? (slots.length ? Math.max(...slots.map((s) => s.order ?? 0)) : 9) : 9;
  const bump = (slot: number) => (slot % maxSlot) + 1;
  // (1) 後続打席: 同半イニングは order+1。
  // [§10.6 item11] 後続打席の打順スロット機械回転(bump/mod9)は撤去＝観測事実(記録値)を機械再計算しない(データ破壊防止)。
  //   挿入PA自身の既定スロット(下の defaultSlot)は新PA限定の assist なので維持。
  const pas = doc.plate_appearances.map((p) =>
    (p.inning === inning && p.half === half && p.order >= insertOrder) ? { ...p, order: p.order + 1 } : p
  );
  // (2) 交代境界の再マップ: 挿入位置より後(before_order > 挿入order)を+1。==挿入order は新PAの直前を指し続ける(不変)。
  const snaps = (doc.lineup_snapshots ?? []).map((s) => {
    const ef = s.effective_from;
    if (ef.inning === inning && ef.half === half && ef.before_order != null && ef.before_order > insertOrder) {
      return { ...s, effective_from: { ...ef, before_order: ef.before_order + 1 } };
    }
    return s;
  });
  // 挿入PAのスロット: 入力指定を優先。未指定は「直前打席(同じ攻撃側)のスロット+1(一巡)」、直前が無ければ先頭スロット。
  const chronoBefore = doc.plate_appearances
    .filter((p) => p.half === half && (p.inning < inning || (p.inning === inning && p.order < insertOrder)))
    .sort((a, b) => a.inning - b.inning || a.order - b.order)
    .at(-1);
  const defaultSlot = (prev: number | null | undefined, head: number): number => (prev != null ? bump(prev) : head);
  const batting_slot = isKingsHalf
    ? (input.batting_slot !== undefined ? input.batting_slot : defaultSlot(chronoBefore?.batting_slot, slots[0]?.order ?? 1))
    : null;
  const opponent_slot = !isKingsHalf
    ? (input.opponent_slot !== undefined ? input.opponent_slot : defaultSlot(chronoBefore?.opponent_slot, 1))
    : null;
  // 打者: 自軍=明示 > スロット占有者(有効スナップショット)。相手=プレースホルダ(oN)。
  let batter_id: string | undefined;
  if (isKingsHalf) {
    batter_id = ens.id ?? (batting_slot != null ? slots.find((s) => s.order === batting_slot)?.player_id : undefined);
  } else {
    batter_id = opponent_slot != null ? `o${opponent_slot}` : undefined;
  }
  if (!batter_id) throw new Error("打者が特定できません(打順未登録なら batter_id を指定)");
  let pa: PlateAppearance = {
    inning, half, order: insertOrder, batting_slot,
    ...(opponent_slot != null ? { opponent_slot } : {}),
    outs: null, batter_id, // [§10.6] outsは未主張=null(read時導出)。走者/runsはスイープが挿入位置の盤面から再導出
    result: input.result, complete: input.complete ?? true,
    runs: [], fielding: input.fielding ?? null,
    baserunning_during: (input.baserunning_during ?? []) as BaserunDuring[],
    baserunning_after: (input.baserunning_after ?? []) as BaserunMove[],
    note: input.note ?? null,
    ...(input.annotations?.length ? { annotations: input.annotations } : {}),
  };
  pa = assignPAFactFields(pa, input); // [C-6] 振り逃げ/申告敬遠/自動アウト/代走/(§10.6)outs主張
  // [§0/§11] 挿入PAでも manual_runs(得点(走者不明)等)を origin:"manual" で種として畳む(reduceAddPAと対称)。
  //   直後のスイープが reDerive でこの打席を再導出する際、mergeManualRuns(deriveRuns, prev.runs) が
  //   この manual run を保全する(走者不明得点を挿入経由でも失わない)。
  if (input.manual_runs?.length) pa = { ...pa, runs: buildManualRuns(input.manual_runs) };
  // (4) スイープ(§10.6 非破壊): 挿入したこの打席のみ再導出(order/走者ID/runs)。下流の別打席は保存値を保持・order連番のみ振り直し。
  let next = sweepHalfInning({ ...doc, plate_appearances: [...pas, pa], lineup_snapshots: snaps }, inning, half, new Set([pa]), masters);
  next = overrideRunsAt(next, next.plate_appearances.length - 1, input.run_overrides); // [§10.6] 責任投手の手動上書き→doc.run_overrides
  return { doc: next, placed: { inning, half, order: insertOrder } };
}

/**
 * [F-4] AI全置換(replace)後の再グラフト。全置換は旧docをメタだけ残して捨てるため、旧docにしか無い
 * (a)投手記録(自責/勝敗S)・(b)ベンチのみ参加者(出欠)・(c)個人成績(断片)direct_stats が無音で消える/別人へ化ける。
 * これを人物同定で救う(旧participant_id は再採番で別人の同IDに化けるため、生の値では引き継げない)。
 *  (a) 旧pitching を 旧participant→人物(roster:player_id / guest:name)→新participantの同一人物→新ID へ再マップ。
 *      引き継げた record だけ新docへ。引き継げない record は試合末尾打席に unclear 注記(打席ゼロなら諦めてdrop)。
 *  (b) 新docに同一人物が居ない旧participant を participant として再追加(出欠=第一級の保全＝participantsに残す)。V-B を通す。
 *  (c) 旧direct_stats(origin:manual=人の明示記録)を同一人物の新ID((a)と同じ人物同定・(b)で再追加した人物も含む)へ
 *      再マップ＝ID再採番で別人へ誤帰属(捏造)させない。同定不能(純助っ人・名前なし)は drop せず末尾打席に注記。
 */
function regraftAfterReplace(oldDoc: GameDoc, newDoc: GameDoc, masters: Map<string, string>): GameDoc {
  const oldParts = oldDoc.participants ?? [];
  const newParts = [...(newDoc.participants ?? [])];
  // 人物キー: roster=選手マスタID / guest=名前。純助っ人(名前なし)は同定不能=null。
  const keyOf = (link: Participant["link"]): string | null =>
    link.kind === "roster" ? `r:${link.player_id}` : (link.name ? `g:${link.name}` : null);
  const nameOf = (link: Participant["link"]): string =>
    link.kind === "roster" ? (masters.get(link.player_id) ?? link.player_id) : (link.name ?? "助っ人");
  const newByPerson = new Map<string, string>(); // 人物→新参加者ID(最初の1件)
  for (const p of newParts) { const k = keyOf(p.link); if (k && !newByPerson.has(k)) newByPerson.set(k, p.id); }
  const oldById = new Map(oldParts.map((p) => [p.id, p]));

  // (a) 投手記録を同一人物の新IDへ再マップ。
  const carried: PitchingRecord[] = [];
  const lost: string[] = [];
  for (const rec of oldDoc.pitching ?? []) {
    const op = oldById.get(rec.pitcher_id);
    const k = op ? keyOf(op.link) : null;
    const nid = k ? newByPerson.get(k) : undefined;
    if (nid) carried.push({ ...rec, pitcher_id: nid });
    else lost.push(op ? nameOf(op.link) : rec.pitcher_id);
  }

  // (b) 新docに同一人物が居ない旧participantを participant として再追加(出欠=第一級の保全＝participantsに残す)。
  //     再追加IDを人物キーで引けるようにして(c)direct_stats の再グラフト先にする(ノートから消えた人物の明示記録を新participantへ繋ぎ直す)。
  const seen = new Set<string>(newByPerson.keys());
  const readd: Participant[] = [];
  const readdByPerson = new Map<string, string>(); // 再追加した人物→新ID
  for (const op of oldParts) {
    const k = keyOf(op.link);
    if (!k || seen.has(k)) continue; // 同定不能(純助っ人)/既に新docに居る=再追加しない
    seen.add(k);
    const nid = nextParticipantId([...newParts, ...readd]);
    readd.push({ id: nid, link: op.link });
    readdByPerson.set(k, nid);
  }
  const participants = [...newParts, ...readd];
  assertNoDuplicateRoster(participants); // V-B

  // (c) 個人成績(断片)を同一人物の新ID(既存 or (b)再追加)へ再マップ＝ID再採番で別人に合算(捏造)させない。
  const carriedDirect: DirectStatLine[] = [];
  const lostDirect: string[] = [];
  for (const ds of oldDoc.direct_stats ?? []) {
    const op = oldById.get(ds.participant_id);
    const k = op ? keyOf(op.link) : null;
    const nid = k ? (newByPerson.get(k) ?? readdByPerson.get(k)) : undefined;
    if (nid) carriedDirect.push({ ...ds, participant_id: nid });
    else lostDirect.push(op ? nameOf(op.link) : ds.participant_id); // 同定不能(純助っ人・名前なし)は注記でdrop
  }

  // 引き継げなかった記録(投手記録・個人成績断片)を試合末尾打席へ unclear 注記(打席ゼロなら諦めてdrop=消失許容・テストで挙動固定)。
  let pas = newDoc.plate_appearances;
  const lostNotes: string[] = [];
  if (lost.length) lostNotes.push(`投手記録(自責/勝敗)を引き継げませんでした: ${lost.join(", ")}`);
  if (lostDirect.length) lostNotes.push(`個人成績(断片)を引き継げませんでした: ${lostDirect.join(", ")}`);
  if (lostNotes.length) {
    const rank = (h: Half) => (h === "top" ? 0 : 1);
    let idx = -1;
    pas.forEach((p, i) => { if (idx < 0 || (p.inning - pas[idx].inning || rank(p.half) - rank(pas[idx].half) || p.order - pas[idx].order) > 0) idx = i; });
    if (idx >= 0) {
      const notes: Annotation[] = lostNotes.map((detail) => ({ type: "unclear", source: "manual", detail }));
      pas = pas.map((p, i) => (i === idx ? { ...p, annotations: [...(p.annotations ?? []), ...notes] } : p));
    }
  }
  // 新docに(op由来の)投手記録/個人成績が既にあればそれを尊重し、無いときだけ再グラフト分を入れる
  //   (setPitchingRecords/setDirectStats は全置換op＝新docの明示があればそれが正)。
  const keepCarried = !(newDoc.pitching?.length) && carried.length > 0;
  const keepDirect = !(newDoc.direct_stats?.length) && carriedDirect.length > 0;

  // [メタ保全] AI全置換はメタ(game)を旧docから引き継いで積むが、ノートが黙っている区分/先後/対戦相手は
  //   reduceSetGameMeta で AI が出した null/空 に潰れ、手入力メタを無音で上書きしてしまう。
  //   ノート沈黙(=AI導出が null/空)のフィールドは旧doc(集計前=手入力)の値を復元する＝手入力メタの非破壊マージ
  //   (「ノートに練習試合と書けば区分は更新／触れなければ手入力を残す」)。
  //   result は結果導出＋上書きチェックボックスで別管理・date は試合の同一性のため対象外(触らない)。
  const blank = (v: unknown): boolean => v == null || (typeof v === "string" && v.trim() === "");
  const oldGame = oldDoc.game;
  const newGame = newDoc.game;
  const mergedGame: Game = {
    ...newGame,
    opponent: blank(newGame.opponent) ? oldGame.opponent : newGame.opponent,
    league: blank(newGame.league) ? (oldGame.league ?? null) : newGame.league,
    home_away: blank(newGame.home_away) ? oldGame.home_away : newGame.home_away,
  };

  return {
    ...newDoc, game: mergedGame, participants, plate_appearances: pas,
    ...(keepCarried ? { pitching: carried } : {}),
    ...(keepDirect ? { direct_stats: carriedDirect } : {}),
  };
}

/**
 * [§12 P1] 参加者化の境界での助っ人解決(async op ラッパ)。op 中の guest_name(名前)を
 * 「種別guestのマスタ選手(player_id)」へ解決/新規作成し、op を player_id 参照へ書き換える。
 * マスタ書込(createGuestPlayer)はここで行い、純reducer(reduce*)には player_id だけが渡る(doc→doc 純粋性を保つ)。
 * best-effort＝重複防止は作り込まない(同名の別マスタは許容・後から mergePlayer で名寄せ)。
 * 解決した player_id は masters(メモリ)にも載せ、reducer の存在チェック(masters.has)を通す。
 */
async function resolveGuestNamesInOps(ops: GameOpInput[], masters: Map<string, string>): Promise<GameOpInput[]> {
  const cache = new Map<string, string>(); // 名前→player_id(同一コール内で同名を二度解決しない・基本の名前解決)
  const idFor = async (name: string): Promise<string> => {
    const nm = name.trim();
    const hit = cache.get(nm);
    if (hit) return hit;
    const p = await createGuestPlayer(nm);
    cache.set(nm, p.id);
    masters.set(p.id, p.name); // reducer の masters.has(player_id) を通す
    return p.id;
  };
  const out: GameOpInput[] = [];
  for (const op of ops) {
    if (op.type === "setStartingLineup") {
      const rows: LineupRowInput[] = [];
      for (const r of op.rows ?? []) {
        const g = r.player_id ? "" : r.guest_name?.trim();
        rows.push(g ? { order: r.order, position: r.position, player_id: await idFor(g) } : r);
      }
      out.push({ ...op, rows });
    } else if (op.type === "substitutePlayer") {
      const g = op.in?.player_id ? "" : op.in?.guest_name?.trim();
      out.push(g ? { ...op, in: { player_id: await idFor(g) } } : op);
    } else if (op.type === "changeDefense") {
      // 守備位置変更も参加ベース化で助っ人の初登場経路になった＝setStartingLineup/substitutePlayer と同じ流儀で解決。
      const changes: DefenseChangeInput[] = [];
      for (const c of op.changes ?? []) {
        const g = c.player_id ? "" : c.guest_name?.trim();
        changes.push(g ? { from_position: c.from_position, to_position: c.to_position, player_id: await idFor(g) } : c);
      }
      out.push({ ...op, changes });
    } else {
      out.push(op);
    }
  }
  // [§12 P1追補] 打席の打者参照の名前解決(2パス目・決定的な完全一致のみ)。
  // 同じ集計の中で新規作成された助っ人は、AIの辞書(コール前のマスタ)に存在せず P-id で参照できない=
  // 打席には生の名前が来る。しかも「作り直す」は破棄時掃除(discardGame)がその助っ人を消すため、
  // やり直しても毎回同じ未登録ID(R2)が再現するループになる(2026-08-08 実障害)。
  // スタメン/交代の解決で masters(新規作成分を含む)が出揃った後に解決するのが正しい順序。
  // changeDefense/changeBattingOrder の人物参照も同じ理由で対象(枠/位置の対象に新規助っ人が名前で来る)。
  // ★コール内キャッシュ(この集計で作成した助っ人の名前→id)を最優先: 同一集計内の同名は同一人物が自明
  //   (2026-08-18 実障害: AIが辞書に居る助っ人を guest_name で出す→同名マスタがもう1人でき、汎用リゾルバが
  //    「同名複数=曖昧」で手を引き、守備変更の名前参照が未解決のままエラー全損。コール内で作った本人へ寄せれば
  //    決定的。重複マスタ自体は既存の設計どおり後始末=破棄時掃除/名寄せ)。
  const general = buildBatterNameResolver(masters);
  const resolveName = (raw: string) => cache.get(raw.trim()) ?? general(raw);
  return out.map((op) => {
    if ((op.type === "addPlateAppearance" || op.type === "editPlateAppearance") && op.batter_id)
      return { ...op, batter_id: resolveName(op.batter_id) };
    if (op.type === "changeDefense")
      return { ...op, changes: (op.changes ?? []).map((c) => (c.player_id ? { ...c, player_id: resolveName(c.player_id) } : c)) };
    if (op.type === "changeBattingOrder")
      return { ...op, rows: (op.rows ?? []).map((r) => ({ ...r, player: resolveName(r.player) })) };
    return op;
  });
}

/**
 * [§12 P1追補] 打者参照の名前→player_id 解決器(決定的・完全一致のみ)。
 * 既知ID(masters のキー)はそのまま。フルネーム完全一致が一意ならその id、次に姓(先頭トークン)完全一致が
 * 一意ならその id。同名複数(曖昧)・不一致は触らない=未登録IDとして R2 の網に残す(自動同定・fuzzyはしない)。
 * 相手プレースホルダ(相手N番/oN)や参加者ID(m系)は名前に一致しないため素通り=無害。
 */
export function buildBatterNameResolver(masters: Map<string, string>): (raw: string) => string {
  const full = new Map<string, string | null>(); // null=同名複数(曖昧なので解決しない)
  const sur = new Map<string, string | null>();
  for (const [id, nm] of masters) {
    const f = nm.trim();
    if (!f) continue;
    full.set(f, full.has(f) ? null : id);
    const s = f.split(/\s+/)[0];
    if (s) sur.set(s, sur.has(s) ? null : id);
  }
  return (raw: string) => {
    const nm = raw.trim();
    if (masters.has(nm)) return raw; // 既にID
    return full.get(nm) ?? sur.get(nm) ?? raw;
  };
}

/**
 * 操作の配列を1世代で原子的に反映(AIの1返却＝これ1回)。
 * 作業中(下書き)を1回ロード→順に畳む→1回 commit。base_gen で楽観ロック。
 * 戻り値は各opの人間向け要約(画面の「反映しました」用)。
 */
export async function applyOps(gameId: string, ops: GameOpInput[], opts: CommitOpts = {}): Promise<string[]> {
  const w = await loadWorking(gameId);
  const masters = await loadPlayers(); // 人物参照の解決(マスタID→参加者の自動追加)に使う
  // [§12 P1] 助っ人名→種別guestマスタ選手(player_id)へ解決(参加者化の境界)。以降 reducer は player_id 一本。
  const resolvedOps = await resolveGuestNamesInOps(ops, masters);
  let doc: GameDoc | null = w?.doc ?? null;
  const oldDoc: GameDoc | null = opts.replace ? doc : null; // [F-4] 全置換前の旧doc(投手記録・ベンチ参加者の再グラフト用)
  // 全置換(AI集計): メタ(game)だけ残して打席/スナップショット/参加者/投手記録をクリアした状態から積む＝1版で丸ごと差し替え。
  // [C-5] doc.pitching もクリア: 旧参加者IDの投手記録が新participantsへ誤解決する時限爆弾の除去(§10.3)。畳み込み後に F-4 が同一人物へ再グラフト。
  // [§0/§11] doc.direct_stats も同様にクリア: 残置すると旧participant_id(m1..)が再採番後の別人へ誤帰属(捏造)。F-4 が同一人物へ再グラフト。
  if (opts.replace && doc) {
    const { attendance: _a, additional_players: _b, pitching: _c, direct_stats: _d, ...rest } = doc; // 旧形式フィールド/宙吊り記録は復活させない
    doc = { ...rest, plate_appearances: [], lineup_snapshots: [], participants: [] };
  }
  const summaries: string[] = [];
  for (const op of resolvedOps) {
    if (op.type === "setGameMeta") {
      const { type, ...patch } = op; void type;
      doc = reduceSetGameMeta(doc, gameId, patch);
      summaries.push("メタ情報を更新しました");
    } else if (op.type === "setStartingLineup") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      doc = reduceSetStartingLineup(doc, gameId, op.rows ?? [], masters);
      summaries.push(`スタメン${(op.rows ?? []).length}人を登録しました`);
    } else if (op.type === "changeDefense") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      // 失敗時は「どの場面のopか」をエラーに前置(1op失敗=集計全体が破棄されるため、原因の場面特定が命綱)
      try { doc = reduceChangeDefense(doc, gameId, op.changes ?? [], { inning: op.inning, half: op.half, before_order: op.before_order }, masters); }
      catch (e) { throw new Error(`${op.inning && op.half ? `${op.inning}回${op.half === "top" ? "表" : "裏"}の` : ""}${(e as Error).message}（対象: ${(op.changes ?? []).map((c) => c.player_id ?? c.from_position ?? "?").join("、")}）`); }
      summaries.push(`守備位置変更(${(op.changes ?? []).length}件)を反映しました`);
    } else if (op.type === "addPlateAppearance") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      const { type, ...input } = op; void type;
      const r = reduceAddPA(doc, input as AddPAInput, masters);
      doc = r.doc;
      summaries.push(`${r.placed.inning}回${r.placed.half === "top" ? "表" : "裏"} ${r.placed.order}人目の打席を追加しました`);
    } else if (op.type === "editPlateAppearance") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      const { type, ...input } = op; void type;
      doc = reduceEditPA(doc, input as EditPAInput, masters);
      summaries.push(`${input.inning}回${input.half === "top" ? "表" : "裏"} ${input.order}番目の打席を修正しました`);
    } else if (op.type === "removePlateAppearance") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      const { type, ...input } = op; void type;
      doc = reduceRemovePA(doc, input as RemovePAInput);
      summaries.push(`${input.inning}回${input.half === "top" ? "表" : "裏"} ${input.order}番目の打席を削除しました`);
    } else if (op.type === "insertPlateAppearance") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      const { type, ...input } = op; void type;
      const r = reduceInsertPA(doc, input as InsertPAInput, masters);
      doc = r.doc;
      summaries.push(`${r.placed.inning}回${r.placed.half === "top" ? "表" : "裏"} ${r.placed.order}番目に打席を挿入しました`);
    } else if (op.type === "substitutePlayer") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      const { type, ...input } = op; void type;
      // 失敗時は「どの場面のopか」をエラーに前置(changeDefense と同じ理由)
      try { doc = reduceSubstitutePlayer(doc, gameId, input as SubstituteInput, masters); }
      catch (e) { throw new Error(`${input.timing?.inning ? `${input.timing.inning}回${input.timing.half === "top" ? "表" : "裏"}の` : ""}${(e as Error).message}（out: ${input.out ?? "?"}）`); }
      summaries.push(`選手交代を反映しました(${input.timing.inning}回${input.timing.half === "top" ? "表" : "裏"}から)`);
    } else if (op.type === "leaveGame") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      const { type, ...input } = op; void type;
      doc = reduceLeaveGame(doc, gameId, input as LeaveGameInput);
      summaries.push(`選手の退場を反映しました(${input.timing.inning}回${input.timing.half === "top" ? "表" : "裏"}から)`);
    } else if (op.type === "changeBattingOrder") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      const { type, ...input } = op; void type;
      // 失敗時は「どの場面のopか」をエラーに前置(changeDefense と同じ理由=1op失敗で集計全体が破棄されるため場面特定が命綱)
      try { doc = reduceChangeBattingOrder(doc, gameId, input as ChangeOrderInput, masters); }
      catch (e) { throw new Error(`${input.timing?.inning ? `${input.timing.inning}回${input.timing.half === "top" ? "表" : "裏"}の` : ""}${(e as Error).message}（対象: ${(input.rows ?? []).map((r) => r.player).join("、") || "?"}）`); }
      summaries.push(`打順変更(${(input.rows ?? []).length}件)を反映しました`);
    } else if (op.type === "setPitchingRecords") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      doc = reduceSetPitchingRecords(doc, op.records ?? []);
      summaries.push(`投手記録(${(op.records ?? []).length}人)を設定しました`);
    } else if (op.type === "setDirectStats") {
      if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
      doc = reduceSetDirectStats(doc, op.stats ?? []);
      summaries.push(`個人成績(断片)を${(doc.direct_stats ?? []).length}件設定しました`);
    } else {
      throw new Error(`未知の操作: ${(op as { type?: string }).type}`);
    }
  }
  if (!doc) throw new Error("適用できる操作がありません");
  if (oldDoc && doc) doc = regraftAfterReplace(oldDoc, doc, masters); // [F-4] 投手記録・ベンチのみ参加者の無音消失を防ぐ(applyValidation前)
  doc = ensurePAIds(doc); // 不変ID(§10.3)の遅延採番(旧データはopのたび自動移行)
  // ルールベース事後検査で矛盾を不明瞭タグに(冪等・値は変えない)＝要確認として浮上、解決は人が行う。
  //   nameOf(=masters は上でロード済)で注記の人物IDを名前で出す(内部コード非露出)。
  doc = applyValidation(doc, docNameResolver(doc, masters));
  // §10.3 実バグ④: 呼び出し側のgen(描画時)を優先=真の楽観ロック。未指定時のみロード時genへフォールバック
  // (??必須: gen=0=履歴前シードがある)。旧実装は常にロード時genで上書きし、呼び出し側指定を握り潰していた。
  await commitGameDoc(doc, co({ ...opts, base_gen: opts.base_gen ?? w?.gen }));
  return summaries;
}

/** 単発の薄いラッパ(管理UI等から1操作だけ呼ぶ用)。中身は applyOps と同じ原子経路。 */
export async function setGameMeta(gameId: string, patch: Partial<GameMetaInput>, opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "setGameMeta", ...patch }], opts);
}
export async function setStartingLineup(gameId: string, rows: LineupRowInput[], opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "setStartingLineup", rows }], opts);
}
export async function addPlateAppearance(gameId: string, input: AddPAInput, opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "addPlateAppearance", ...input }], opts);
}
export async function insertPlateAppearance(gameId: string, input: InsertPAInput, opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "insertPlateAppearance", ...input }], opts);
}
export async function substitutePlayer(gameId: string, input: SubstituteInput, opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "substitutePlayer", ...input }], opts);
}
export async function leaveGame(gameId: string, input: LeaveGameInput, opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "leaveGame", ...input }], opts);
}
export async function changeBattingOrder(gameId: string, input: ChangeOrderInput, opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "changeBattingOrder", ...input }], opts);
}
export async function setPitchingRecords(gameId: string, records: PitchingRecordInput[], opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "setPitchingRecords", records }], opts);
}
export async function setDirectStats(gameId: string, stats: DirectStatLine[], opts: CommitOpts = {}): Promise<void> {
  await applyOps(gameId, [{ type: "setDirectStats", stats }], opts);
}

/** 軽量サマリ(対象1試合のみ): メタ＋オーダー＋現在状態。AI入力の参照用(全打席は返さない)。 */
export async function getGameSummary(gameId: string) {
  const w = await loadWorking(gameId);
  if (!w) return null;
  const doc = w.doc;
  const masters = await loadPlayers();
  // 参加者の表示名解決(roster=マスタ名/guest=link.name)。AIには名前で見せる(内部コードを一次言語にしない)
  const partName = new Map<string, string>();
  for (const p of doc.participants ?? []) {
    partName.set(p.id, p.link.kind === "roster" ? (masters.get(p.link.player_id) ?? p.link.player_id) : (p.link.name ?? "助っ人"));
  }
  const nameOf = (id: string) => partName.get(id) ?? id;
  // 記録済み打席のダイジェスト(=再入力禁止の根拠)。AIが会話履歴の過去分を二重登録しないために渡す。
  const recorded = [...doc.plate_appearances]
    .sort((a, b) => a.inning - b.inning || (a.half === "top" ? 0 : 1) - (b.half === "top" ? 0 : 1) || a.order - b.order)
    .map((p) => `${p.inning}${p.half === "top" ? "表" : "裏"}#${p.order} ${p.opponent_slot != null ? `相手${p.opponent_slot}番` : nameOf(p.batter_id)} ${p.result}${p.note ? `(${p.note})` : ""}`);
  return {
    id: doc.game.id, date: doc.game.date, opponent: doc.game.opponent, league: doc.game.league, home_away: doc.game.home_away, result: doc.game.result,
    lineup: lineupSlots(doc).map((e) => ({ order: e.order, position_id: e.position_id, player_id: e.player_id, name: nameOf(e.player_id) })),
    participants: (doc.participants ?? []).map((p) => ({ id: p.id, name: nameOf(p.id), kind: p.link.kind })),
    state: gameState(doc),
    recorded,
    draft: w.draft, gen: w.gen,
  };
}

// JSON取込(importGameDoc)はデバッグ用だったためWeb機能から撤去(2026-07-13)。
// 旧形式JSONの取込は単独スクリプト scripts/import_game.ts（マイグレーション用・移行器＋検証ゲート経由）のみ。
