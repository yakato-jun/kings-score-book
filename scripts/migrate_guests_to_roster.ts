/**
 * [§12.3 助っ人一本化 データ移行] 既存 guest link → 「種別助っ人のマスタ登録＋link を player_id 参照へ付け替え」。
 *   1回・非破壊(commitGameDoc append・履歴リセットしない=§9移行と別)・冪等(origin lookup)。
 *
 * ★最重要(read-only 保証): ドライランは一切 DB write を呼ばない。players upsert(writePlayer) / commitGameDoc は
 *   全て下段の `if (APPLY) { … }` の内側だけに置く。上段のループはメモリ適用＋純関数検証(集計)のみ＝読み取りのみ。
 *
 * ドライラン(既定): Atlas games を走査 → 各 doc に migrateGuestsToRoster をメモリ適用 → 集計して表示
 *   (総guestリンク数・作成予定の助っ人マスタ数・was復元数・冪等再利用数・unresolved 一覧)。何も書かない。
 * --apply: 新マスタを players に upsert(origin付き) → 各 doc を commitGameDoc で非破壊append(edit_source:"migration")。
 *   先端が下書きの試合は skip・guest link 0 の試合は skip(冪等)・verify fail>0 は適用しない(中断)。
 *   allocate は nextPlayerId をバッチ内カウンタで前進(逐次採番の競合回避)。
 *
 * 実行(ドライラン): node --env-file=.env.local --import tsx scripts/migrate_guests_to_roster.ts
 * 実行(適用):       node --env-file=.env.local --import tsx scripts/migrate_guests_to_roster.ts --apply
 */
import { getClient, getDb } from "../lib/db/mongo";
import { loadPlayerMap, writePlayer } from "../lib/db/players";
import { commitGameDoc, pendingDraftGameIds } from "../lib/db/games";
import { migrateGuestsToRoster, verifyGuestsToRoster, type GuestMigrationSeed } from "../lib/migrate/guests_to_roster";
import type { GameDoc, Player } from "../lib/types/v2";

const APPLY = process.argv.includes("--apply");

/**
 * 種別guestの新マスタを採番する allocator。P### の連番をバッチ内カウンタで前進させる
 *   (Atlas 逐次 upsert の往復に依存せずID衝突を避ける)。origin に出自を刻む＝冪等 lookup キー。
 */
function makeAllocator(players: Map<string, Player>): (seed: GuestMigrationSeed) => Player {
  let n = 0;
  for (const id of players.keys()) {
    const m = /^P(\d{3})$/.exec(id);
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return (seed: GuestMigrationSeed): Player => {
    n += 1;
    return {
      id: "P" + String(n).padStart(3, "0"),
      name: seed.name,
      type: "guest",
      origin: { kind: "guest_migration", game_id: seed.game_id, participant_id: seed.participant_id },
    };
  };
}

async function main(): Promise<void> {
  const db = await getDb();
  const games = await db.collection<GameDoc>("games").find({}, { projection: { _id: 0 } }).sort({ "game.date": 1 }).toArray();
  const players = await loadPlayerMap(); // Map<string, Player>(type/origin 込み・読み取り)
  const pendingDraft = await pendingDraftGameIds(); // 先端が下書きの試合(移行対象外)
  const allocate = makeAllocator(players); // バッチ全体で1つ(採番カウンタを共有＝ID衝突回避)

  // ---- 上段: 計画(メモリ適用)＋検証。ここでは一切書き込まない(read-only) ----
  const plan: { doc: GameDoc; newMasters: Player[] }[] = [];
  let totalGuestLinks = 0, totalWasRestored = 0, totalNew = 0, totalReused = 0;
  let skippedDraft = 0, skippedNoGuest = 0, verifyFails = 0;
  const allUnresolved: { game_id: string; participant_id: string }[] = [];

  for (const doc of games) {
    const gid = doc.game.id;
    if (pendingDraft.has(gid)) {
      console.log(`SKIP ${gid}: 先端が下書き(確定/破棄してから)`);
      skippedDraft++;
      continue;
    }
    // guest link 0 の試合は移行不要＝skip(冪等: 適用済みの試合も guest 0 でここに落ちる)。
    if (!(doc.participants ?? []).some((p) => p.link.kind === "guest")) {
      skippedNoGuest++;
      continue;
    }

    const { doc: newDoc, newMasters, report } = migrateGuestsToRoster(doc, players, allocate);

    // 検証は純関数(集計のみ・DB非依存)。新マスタを含めた masters で 0差分＋翻訳先実在を確認。
    const vMasters = new Map(players);
    for (const m of newMasters) vMasters.set(m.id, m);
    const v = verifyGuestsToRoster(doc, newDoc, vMasters);

    totalGuestLinks += report.guestLinks;
    totalWasRestored += report.wasRestored;
    totalNew += report.newMasters;
    totalReused += report.idempotentReused;
    allUnresolved.push(...report.unresolved);

    if (!v.ok) {
      console.log(`FAIL ${gid}: 検証NG(0差分不成立)`);
      for (const d of v.diffs) console.log(`  - ${d}`);
      verifyFails++;
      continue; // 計画に載せない＝この試合は適用対象外
    }
    console.log(
      `OK   ${gid}: guest${report.guestLinks}(新規${report.newMasters}/再利用${report.idempotentReused}/was復元${report.wasRestored}) ` +
        `未解決${report.unresolved.length} [翻訳 純${v.pureGuestKeys}/was${v.wasRestoredKeys}]`,
    );

    // 冪等索引の前進(メモリのみ・書き込みではない): 以後の試合の origin lookup / allocator と辻褄を合わせる。
    for (const m of newMasters) players.set(m.id, m);
    plan.push({ doc: newDoc, newMasters });
  }

  // ---- 集計サマリ(ドライラン/適用 共通) ----
  console.log(`\n=== サマリ ${APPLY ? "[APPLY]" : "[dry-run]"} ===`);
  console.log(`対象試合(guestあり): ${plan.length + verifyFails}  / skip(下書き ${skippedDraft} + guest0 ${skippedNoGuest})  / 全${games.length}試合`);
  console.log(`総guestリンク: ${totalGuestLinks}  作成予定マスタ: ${totalNew}  was復元: ${totalWasRestored}  冪等再利用: ${totalReused}`);
  console.log(`検証FAIL: ${verifyFails}`);
  if (allUnresolved.length) {
    console.log(`未解決(人手対応・連番マスタを黙って作らない) ${allUnresolved.length}件:`);
    for (const u of allUnresolved) console.log(`  - game_id=${u.game_id} participant_id=${u.participant_id}`);
  } else {
    console.log(`未解決: 0件`);
  }

  // ---- 下段: ここより下だけが書き込み。--apply 未指定なら一切書かずに終了 ----
  if (!APPLY) {
    console.log(`\n--- dry-run(何も書き込んでいません)。適用するには --apply を付けて再実行 ---`);
    await (await getClient()).close();
    return;
  }
  if (verifyFails > 0) {
    console.log(`\n検証FAILがある間は適用しない(全試合0差分が前提)。中断します。`);
    process.exitCode = 1;
    await (await getClient()).close();
    return;
  }

  console.log(`\n=== 適用開始 ===`);
  for (const { doc, newMasters } of plan) {
    // 新助っ人マスタを先に upsert(origin付き)＝link の付け替え先を実在させてからコミットする。
    for (const m of newMasters) await writePlayer(m);
    // 非破壊append(履歴リセットしない): 新しい公開版を1版積む。games(公開doc)も commitGameDoc が更新する。
    await commitGameDoc(doc, {
      source: "admin",
      draft: false,
      edit_source: "migration",
      input: { kind: "manual", text: "§12 助っ人＝種別付きマスタ選手への一本化(guest link→roster付け替え)" },
    });
    console.log(`APPLIED ${doc.game.id}: 新マスタ${newMasters.length}件 upsert＋新しい公開版を追記`);
  }
  console.log(`\n=== 適用完了 ===`);
  await (await getClient()).close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
