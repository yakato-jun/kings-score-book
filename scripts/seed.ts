/**
 * v2 試合doc と 選手マスタ を MongoDB Atlas へ取り込む seed スクリプト。
 * 取り込み元（機密・リポ外）:
 *   - 試合: SEED_SOURCE_DIR（既定 ../baseball_score_schema/output）
 *   - 選手: PLAYERS_SOURCE（既定 ../baseball_score_schema/data/players.json）
 * 実行: npm run seed   （.env.local に MONGODB_URI が必要）
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getClient, getDb } from "../lib/db/mongo";
import type { GameDoc, Player } from "../lib/types/v2";

const SRC = process.env.SEED_SOURCE_DIR ?? "../baseball_score_schema/output";
const PLAYERS = process.env.PLAYERS_SOURCE ?? "../baseball_score_schema/data/players.json";

async function main(): Promise<void> {
  const db = await getDb();

  // 試合
  const dir = resolve(process.cwd(), SRC);
  // 新IDはランダムhex。この /^G\d{8}\.json$/ は旧日付ファイル名(G20260614.json)前提のシード用フィルタ(挙動は変更なし)。
  const files = (await readdir(dir)).filter((f) => /^G\d{8}\.json$/.test(f));
  const games = db.collection<GameDoc>("games");
  for (const f of files) {
    const doc = JSON.parse(await readFile(join(dir, f), "utf8")) as GameDoc;
    await games.replaceOne({ "game.id": doc.game.id }, doc, { upsert: true });
  }
  console.log(`seeded ${files.length} games`);

  // 選手マスタ
  const pdata = JSON.parse(await readFile(resolve(process.cwd(), PLAYERS), "utf8")) as { players: Player[] };
  const players = db.collection<Player>("players");
  for (const p of pdata.players) {
    await players.replaceOne({ id: p.id }, p, { upsert: true });
  }
  console.log(`seeded ${pdata.players.length} players`);

  await (await getClient()).close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
