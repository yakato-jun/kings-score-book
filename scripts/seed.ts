/**
 * v2 試合doc を MongoDB Atlas へ取り込む seed スクリプト。
 * 取り込み元（機密・リポ外）: SEED_SOURCE_DIR（既定 ../baseball_score_schema/output）
 * 実行: npm run seed   （.env.local に MONGODB_URI が必要）
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getClient, getDb } from "../lib/db/mongo";
import type { GameDoc } from "../lib/types/v2";

const SRC = process.env.SEED_SOURCE_DIR ?? "../baseball_score_schema/output";

async function main(): Promise<void> {
  const dir = resolve(process.cwd(), SRC);
  const files = (await readdir(dir)).filter((f) => /^G\d{8}\.json$/.test(f));
  const db = await getDb();
  const col = db.collection<GameDoc>("games");
  let n = 0;
  for (const f of files) {
    const doc = JSON.parse(await readFile(join(dir, f), "utf8")) as GameDoc;
    await col.replaceOne({ "game.id": doc.game.id }, doc, { upsert: true });
    n++;
  }
  console.log(`seeded ${n} games from ${dir}`);
  await (await getClient()).close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
