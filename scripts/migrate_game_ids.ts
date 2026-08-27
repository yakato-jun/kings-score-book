/**
 * 試合IDを日付ベース(G+YYYYMMDD)から short-hex ランダムID へ移行する一回限りの移行スクリプト。
 * 参照4コレクションを old->new で更新: games(game.id) / game_history(game_id + snapshot.game.id)
 *   / game_notes(game_id) / chat_jobs(game_id)。
 * 併せて DELETE_IDS(テストの合流ダブルヘッダー等)を全コレクションから削除する。
 *
 * 実行(dry-run/表示のみ):
 *   node --env-file=.env.local --import tsx scripts/migrate_game_ids.ts
 * 実行(実適用):
 *   node --env-file=.env.local --import tsx scripts/migrate_game_ids.ts --apply
 */
import { getDb } from "../lib/db/mongo";
import { generateGameId } from "../lib/ops/games";

const APPLY = process.argv.includes("--apply");
const DELETE_IDS = ["G20260705"]; // 7/5 合流テストデータ(ダブルヘッダー衝突)を削除

const HIST = "game_history";
const isDateId = (id: string) => /^G\d{8}$/.test(id);

async function main() {
  const db = await getDb();
  const gamesCol = db.collection("games");
  const histCol = db.collection(HIST);
  const notesCol = db.collection("game_notes");
  const jobsCol = db.collection("chat_jobs");

  const counts = async (id: string) => ({
    hist: await histCol.countDocuments({ game_id: id }),
    notes: await notesCol.countDocuments({ game_id: id }),
    jobs: await jobsCol.countDocuments({ game_id: id }),
  });

  const all = await gamesCol
    .find({}, { projection: { _id: 0, "game.id": 1, "game.date": 1, "game.opponent": 1 } })
    .toArray();
  console.log(`=== 全 ${all.length} 試合 ===`);
  for (const g of all) console.log(`  ${g.game.id}  ${g.game.date}  ${g.game.opponent}`);

  console.log(`\n=== 削除対象(テストデータ) ===`);
  for (const id of DELETE_IDS) {
    const c = await counts(id);
    console.log(`  ${id}: games=${all.some((g) => g.game.id === id) ? 1 : 0} history=${c.hist} notes=${c.notes} jobs=${c.jobs}`);
  }

  // 移行対象 = 日付ベースID かつ 削除対象でない
  const targets = all.filter((g) => isDateId(g.game.id) && !DELETE_IDS.includes(g.game.id));
  const existing = new Set(all.map((g) => g.game.id));
  const mapping = new Map<string, string>();
  for (const g of targets) {
    let nid: string;
    do { nid = generateGameId(); } while (existing.has(nid) || [...mapping.values()].includes(nid));
    mapping.set(g.game.id, nid);
    existing.add(nid);
  }
  console.log(`\n=== 移行対象 ${targets.length} 試合 (日付ID → short-hex) ===`);
  for (const g of targets) {
    const c = await counts(g.game.id);
    console.log(`  ${g.game.id} (${g.game.date} ${g.game.opponent}) -> ${mapping.get(g.game.id)}   [history=${c.hist} notes=${c.notes} jobs=${c.jobs}]`);
  }
  const already = all.filter((g) => !isDateId(g.game.id) && !DELETE_IDS.includes(g.game.id));
  if (already.length) console.log(`\n(既に非日付ID ${already.length}件はスキップ: ${already.map((g) => g.game.id).join(", ")})`);

  if (!APPLY) {
    console.log(`\n--- dry-run(表示のみ)。適用するには --apply を付けて再実行 ---`);
    process.exit(0);
  }

  console.log(`\n=== 適用開始 ===`);
  for (const id of DELETE_IDS) {
    const g = await gamesCol.deleteOne({ "game.id": id });
    const h = await histCol.deleteMany({ game_id: id });
    const n = await notesCol.deleteMany({ game_id: id });
    const j = await jobsCol.deleteMany({ game_id: id });
    console.log(`  削除 ${id}: games=${g.deletedCount} history=${h.deletedCount} notes=${n.deletedCount} jobs=${j.deletedCount}`);
  }
  for (const [oldId, newId] of mapping) {
    const g = await gamesCol.updateOne({ "game.id": oldId }, { $set: { "game.id": newId } });
    const h = await histCol.updateMany({ game_id: oldId }, { $set: { game_id: newId, "snapshot.game.id": newId } });
    const n = await notesCol.updateMany({ game_id: oldId }, { $set: { game_id: newId } });
    const j = await jobsCol.updateMany({ game_id: oldId }, { $set: { game_id: newId } });
    console.log(`  移行 ${oldId} -> ${newId}: games=${g.modifiedCount} history=${h.modifiedCount} notes=${n.modifiedCount} jobs=${j.modifiedCount}`);
  }
  console.log(`\n=== 適用完了 ===`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
