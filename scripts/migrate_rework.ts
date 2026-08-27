/**
 * [§10.6 非破壊リワークの移行] 既に participants 化済み(post-flip)の Atlas 試合を、非破壊リワークの新表現へ移す。
 *  (13) runs[].responsible_pitcher_id(元記録) → doc.run_overrides(manual)へ保全し runs[] を auto専用に空ける。
 *  (14) 保存 outs(導出値): 導出開始アウトと一致→null戻し / 食い違い(DP/特別ルール)→保存維持+flag。
 *  (15) 機械回転された打順スロットは出自マーカーが無く自動判別不能＝黙って正規化しない(触らない・要人手)。
 *
 * ★非破壊: aggregateGameP(own集計) が移行前後でバイト一致することをゲートにする(値を壊さない)。加えて新たに立つ flag を報告。
 * 既定は dry-run(読み取り＋検証のみ)。--apply で「新しい公開版」を append(履歴はリセットしない=追記専用)。
 * 実行: node --env-file=.env.local --import tsx scripts/migrate_rework.ts [--apply]
 */
import { getClient, getDb } from "../lib/db/mongo";
import type { GameDoc, GameVersion } from "../lib/types/v2";
import { migrateRunOverridesOuts } from "../lib/migrate/rework";
import { aggregateGameP } from "../lib/agg/participants";
import { applyValidation, unresolvedUnclear } from "../lib/ops/validate";

const APPLY = process.argv.includes("--apply");

const unresolvedCount = (doc: GameDoc): number =>
  doc.plate_appearances.reduce((n, p) => n + unresolvedUnclear(p).length, 0);

async function main(): Promise<void> {
  const db = await getDb();
  const games = await db.collection<GameDoc>("games").find({}, { projection: { _id: 0 } }).sort({ "game.date": 1 }).toArray();
  const hist = db.collection<GameVersion>("game_history");
  const tips = await hist
    .aggregate<{ _id: string; gen: number; draft: boolean }>([
      { $sort: { gen: -1 } },
      { $group: { _id: "$game_id", gen: { $first: "$gen" }, draft: { $first: "$draft" } } },
    ])
    .toArray();
  const tipBy = new Map(tips.map((t) => [t._id, t]));

  let ok = 0, fail = 0, skipped = 0;
  const apply: { doc: GameDoc; gen: number }[] = [];
  for (const doc of games) {
    const gid = doc.game.id;
    const tip = tipBy.get(gid);
    if (tip?.draft) { console.log(`SKIP ${gid}: 先端が下書き(確定/破棄してから)`); skipped++; continue; }
    if (doc.run_overrides !== undefined) { console.log(`SKIP ${gid}: 既に移行済み(run_overrides あり)`); skipped++; continue; }

    const beforeBox = JSON.stringify(aggregateGameP(doc));
    const beforeFlags = unresolvedCount(applyValidation(doc));
    const { doc: migrated, report } = migrateRunOverridesOuts(doc);
    const afterDoc = applyValidation(migrated); // 新flag(outs食い違い等)を surface
    const afterBox = JSON.stringify(aggregateGameP(afterDoc));
    const afterFlags = unresolvedCount(afterDoc);

    if (beforeBox !== afterBox) {
      console.log(`FAIL ${gid}: own集計が移行前後で不一致(値を壊している)`);
      fail++;
      continue;
    }
    const newFlags = afterFlags - beforeFlags;
    console.log(
      `OK   ${gid}: 責任投手→override ${report.responsible_moved} / outs null戻し ${report.outs_nulled} / outs保持+flag ${report.outs_kept_flagged} / 新flag ${newFlags >= 0 ? "+" : ""}${newFlags}`
    );
    apply.push({ doc: afterDoc, gen: (tip?.gen ?? 0) + 1 });
    ok++;
  }
  console.log(`\n結果: OK ${ok} / FAIL ${fail} / SKIP ${skipped} (全${games.length}試合) ${APPLY ? "[APPLY]" : "[dry-run]"}`);

  if (APPLY) {
    if (fail > 0) { console.log("FAIL がある間は適用しない(own集計一致が前提)"); process.exitCode = 1; }
    else {
      for (const { doc: nd, gen } of apply) {
        const gid = nd.game.id;
        await db.collection<GameDoc>("games").replaceOne({ "game.id": gid }, nd, { upsert: true });
        const v: GameVersion = {
          game_id: gid, gen, draft: false, snapshot: nd,
          updated_at: new Date().toISOString(), updated_by: "admin", edit_source: "manual",
          input: { kind: "manual", text: "非破壊リワークへの移行(§10.6: 責任投手→run_overrides / outs主張値化)" },
        };
        await hist.insertOne(v); // 追記(履歴リセットしない)
        console.log(`APPLIED ${gid}: 新しい公開版 gen${gen} を追記`);
      }
    }
  }

  await (await getClient()).close();
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
