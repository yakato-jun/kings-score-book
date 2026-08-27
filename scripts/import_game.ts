/**
 * 旧パイプライン(baseball_score_schema)出力の試合JSON(旧形式)を、§9参加者形式へ移行してAtlasに取り込む。
 * 旧パイプラインは今後も第一級の入力経路＝このスクリプトは使い捨てでなく常用。
 *  - 移行器(migrateToParticipants)＋検証(verifyMigration=数値0差分・属性突合)を必ず通す。検証NGなら書かない。
 *  - 既存試合は「新しい公開版として履歴に積む」(非破壊・履歴は残る)。新規試合は gen1 公開版。
 *  - 先端が下書きの試合は弾く(確定/破棄してから)＝下書きブロックの単一ルールに従う。
 * 実行: node --env-file=.env.local --import tsx scripts/import_game.ts <G20260614|path.json> [...]
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getClient, getDb } from "../lib/db/mongo";
import { currentGen, publicGen, commitGameDoc } from "../lib/db/games";
import { applyValidation } from "../lib/ops/validate";
import { migrateToParticipants, verifyMigration, MigrationError } from "../lib/migrate/participants";
import type { GameDoc, Player } from "../lib/types/v2";

const SRC = process.env.SEED_SOURCE_DIR ?? "../baseball_score_schema/output";
const BACKUP_DIR = process.env.V1_BACKUP_DIR ?? "../baseball_score_schema/output/_v1_backup";

async function guestNamesFor(doc: GameDoc): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const a of doc.additional_players ?? []) {
    if (a.type === "guest" && a.name) names.set(a.id, a.name);
  }
  try {
    const raw = await readFile(resolve(process.cwd(), BACKUP_DIR, `${doc.game.id}.json`), "utf8");
    const bak = JSON.parse(raw) as GameDoc;
    for (const a of bak.additional_players ?? []) {
      if (a.type === "guest" && a.name && !names.has(a.id)) names.set(a.id, a.name);
    }
  } catch {
    // バックアップ無しは許容。実名が引けなければ移行器がハード失敗する(静かな情報喪失を防ぐ)
  }
  return names;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (!args.length) {
    console.log("使い方: node --env-file=.env.local --import tsx scripts/import_game.ts <G20260614|path.json> [...]");
    process.exit(1);
  }
  const db = await getDb();
  const masterIds = new Set((await db.collection<Player>("players").find({}, { projection: { id: 1 } }).toArray()).map((p) => p.id));

  let fail = 0;
  for (const arg of args) {
    // 新IDはランダムhex。この /^G\d{8}$/ は旧日付ファイル名(G20260614.json)前提の移行/取込ツール専用の判定。
    const path = /^G\d{8}$/.test(arg) ? resolve(process.cwd(), SRC, `${arg}.json`) : resolve(process.cwd(), arg);
    const doc = JSON.parse(await readFile(path, "utf8")) as GameDoc;
    const gid = doc.game.id;
    try {
      if (doc.participants?.length) throw new MigrationError(gid, "既に参加者形式です(このスクリプトは旧形式専用)");
      const [tip, pub] = await Promise.all([currentGen(gid), publicGen(gid)]);
      if (tip !== pub) throw new MigrationError(gid, `先端が下書きです(gen${tip})。確定(公開)か破棄をしてから取り込んでください`);

      const { doc: newDoc, report } = migrateToParticipants(doc, await guestNamesFor(doc));
      const v = verifyMigration(doc, newDoc, report, { masterIds });
      if (!v.ok) {
        console.log(`FAIL ${gid}:`);
        for (const e of v.errors) console.log(`  - ${e}`);
        fail++;
        continue;
      }
      const validated = applyValidation(newDoc); // R1-R6を即タグ(要確認はテキスト画面で承認/修正)
      const flags = validated.plate_appearances.reduce((n, p) => n + (p.annotations ?? []).filter((a) => a.type === "unclear").length, 0);
      const { gen } = await commitGameDoc(validated, {
        source: "admin",
        edit_source: "manual",
        input: { kind: "manual", text: `JSON取込: 旧パイプライン ${gid}（参加者形式へ移行）` },
        base_gen: tip,
      });
      const guests = report.participants.filter((p) => p.link.kind === "guest").length;
      console.log(`OK   ${gid}: gen${gen}公開版 参加者${report.participants.length}(助${guests}) PA${newDoc.plate_appearances.length} 要確認${flags} ${v.notes.join(" / ")}`);
    } catch (e) {
      if (e instanceof MigrationError) {
        console.log(`FAIL ${e.message}`);
        fail++;
      } else throw e;
    }
  }
  await (await getClient()).close();
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
