/**
 * 集計エンジンの検証用ダンプ。output/G2026*.json を集計し、
 * 1選手1試合のボックススコアと シーズン合計を JSON に書き出す。
 * Python 側で 2026集計.xlsx(検証済み正解) と突き合わせる。
 * 実行: node --import tsx scripts/verify_agg.ts
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { aggregateGame, aggregateSeason } from "../lib/agg";
import type { GameDoc } from "../lib/types/v2";

const SRC = process.env.SEED_SOURCE_DIR ?? "../baseball_score_schema/output";
const OUT = process.env.VERIFY_OUT ?? "../engine_box.json";

async function main(): Promise<void> {
  const dir = resolve(process.cwd(), SRC);
  const files = (await readdir(dir))
    .filter((f) => /^G2026\d{4}\.json$/.test(f)) // 2026のみ(検証対象)
    .sort();
  const docs: GameDoc[] = [];
  for (const f of files) {
    docs.push(JSON.parse(await readFile(join(dir, f), "utf8")) as GameDoc);
  }
  const games = docs.map((d) => aggregateGame(d));
  const season = aggregateSeason(docs);
  const out = resolve(process.cwd(), OUT);
  await writeFile(out, JSON.stringify({ games, season }, null, 2), "utf8");
  console.log(`aggregated ${docs.length} games → ${out}`);
  console.log(`season: 打者${season.batting.length} 投手${season.pitching.length} 守備${season.fielding.length} 出欠${season.attendance.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
