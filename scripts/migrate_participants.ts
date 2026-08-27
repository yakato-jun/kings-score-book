/**
 * [§9.7] 参加者ID層への移行スクリプト。既定は dry-run（Atlas読み取りのみ・書き込み無し）。
 *  - 対象: Atlas games コレクション（公開版=正本）。先端がdraftの試合は報告して除外。
 *  - guest名の解決順: 現docの additional_players → _v1_backup/G{id}.json → ハード失敗。
 *  - 検証: verifyMigration（数値0差分・全scope＋属性突合(a)-(d)＋出欠パリティ＋opponent_slot転記＋残存なし）。
 *  - --apply 指定時のみ永続化: games を移行docへ置換し、game_history を全削除→移行docを gen1 公開版でシード
 *    （履歴リセット。バックアップ前提の運用判断による）。
 * 実行: node --env-file=.env.local --import tsx scripts/migrate_participants.ts [--apply]
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getClient, getDb } from "../lib/db/mongo";
import type { GameDoc, GameVersion, Player } from "../lib/types/v2";
import { migrateToParticipants, verifyMigration, MigrationError } from "../lib/migrate/participants";

const BACKUP_DIR = process.env.V1_BACKUP_DIR ?? "../baseball_score_schema/output/_v1_backup";
const APPLY = process.argv.includes("--apply");

async function guestNamesFor(doc: GameDoc): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  // 1) 現doc の additional_players（新しい試合はここに実名がある）
  for (const a of doc.additional_players ?? []) {
    if (a.type === "guest" && a.name) names.set(a.id, a.name);
  }
  // 2) _v1_backup（初期移行で additional_players が落ちた試合の実名回収）
  try {
    const raw = await readFile(resolve(process.cwd(), BACKUP_DIR, `${doc.game.id}.json`), "utf8");
    const bak = JSON.parse(raw) as GameDoc;
    for (const a of bak.additional_players ?? []) {
      if (a.type === "guest" && a.name && !names.has(a.id)) names.set(a.id, a.name);
    }
  } catch {
    // バックアップ無しは許容（実名が現docにあれば足りる）。足りなければ移行器がハード失敗する。
  }
  return names;
}

async function main(): Promise<void> {
  const db = await getDb();
  const games = await db.collection<GameDoc>("games").find({}, { projection: { _id: 0 } }).sort({ "game.date": 1 }).toArray();
  const masterIds = new Set((await db.collection<Player>("players").find({}, { projection: { id: 1 } }).toArray()).map((p) => p.id));

  // 先端がdraftの試合は移行対象外（先に確定/破棄が必要）
  const hist = db.collection<GameVersion>("game_history");
  const tips = await hist
    .aggregate<{ _id: string; draft: boolean }>([
      { $sort: { gen: -1 } },
      { $group: { _id: "$game_id", draft: { $first: "$draft" } } },
    ])
    .toArray();
  const pendingDraft = new Set(tips.filter((t) => t.draft).map((t) => t._id));

  let ok = 0, fail = 0, skipped = 0;
  const migrated: GameDoc[] = [];
  for (const doc of games) {
    const gid = doc.game.id;
    if (pendingDraft.has(gid)) {
      console.log(`SKIP ${gid}: 先端が下書き（確定/破棄してから）`);
      skipped++;
      continue;
    }
    if (doc.participants?.length) {
      console.log(`SKIP ${gid}: 既に移行済み`);
      skipped++;
      continue;
    }
    try {
      const names = await guestNamesFor(doc);
      const { doc: newDoc, report } = migrateToParticipants(doc, names);
      const v = verifyMigration(doc, newDoc, report, { masterIds });
      const guests = report.participants.filter((p) => p.link.kind === "guest").length;
      const rosters = report.participants.filter((p) => p.link.kind === "roster").length;
      if (v.ok) {
        console.log(`OK   ${gid}: 参加者${report.participants.length}(正${rosters}/助${guests}) 相手PA${report.oppSlots.length} ${v.notes.join(" / ")}`);
        migrated.push(newDoc);
        ok++;
      } else {
        console.log(`FAIL ${gid}:`);
        for (const e of v.errors) console.log(`  - ${e}`);
        fail++;
      }
    } catch (e) {
      if (e instanceof MigrationError) {
        console.log(`FAIL ${gid}: ${e.message}`);
        fail++;
      } else throw e;
    }
  }
  console.log(`\n結果: OK ${ok} / FAIL ${fail} / SKIP ${skipped} (全${games.length}試合) ${APPLY ? "[APPLY]" : "[dry-run]"}`);

  if (APPLY) {
    if (fail > 0 || skipped > 0) {
      console.log("FAIL/SKIP がある間は適用しない（全試合OKが前提）");
      process.exitCode = 1;
    } else {
      for (const nd of migrated) {
        const gid = nd.game.id;
        await db.collection<GameDoc>("games").replaceOne({ "game.id": gid }, nd, { upsert: true });
        await hist.deleteMany({ game_id: gid }); // 履歴リセット（バックアップ前提の運用判断）
        const seed: GameVersion = {
          game_id: gid,
          gen: 1,
          draft: false,
          snapshot: nd,
          updated_at: new Date().toISOString(),
          updated_by: "admin",
          edit_source: "manual",
          input: { kind: "manual", text: "参加者ID層への移行（§9）" },
        };
        await hist.insertOne(seed);
        console.log(`APPLIED ${gid}: games更新・履歴リセット→gen1公開版`);
      }
    }
  }

  await (await getClient()).close();
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
