/**
 * [診断・一回きり・読み取りのみ] 指定試合の working doc(下書き)＋ノートを覗き、
 * 得点(runs)の runner_id が null(得点者不明) か、走塁移動(from塁)が記録されているか、
 * unclear注記の内訳を出す。＝「不明瞭」の原因がAIの事実不足(from塁欠落)かエンジン導出かを切り分ける。
 * 実行: node --env-file=.env.local --import tsx scripts/inspect_draft.ts <gameId>
 */
import { getClient } from "../lib/db/mongo";
import { loadWorking } from "../lib/db/games";
import { loadNote } from "../lib/db/notes";
import { loadPlayers } from "../lib/db/players";
import { docNameResolver } from "../lib/names";

const gameId = process.argv[2] ?? "dfc16c689e";

async function main(): Promise<void> {
  const [w, note, players] = await Promise.all([loadWorking(gameId), loadNote(gameId), loadPlayers()]);
  console.log(`=== NOTE (${gameId}) ===`);
  console.log(note?.trim() ? note : "(ノートなし)");

  if (!w) { console.log("\nworking doc なし"); await (await getClient()).close(); return; }
  const doc = w.doc as any;
  console.log(`\n=== DOC gen=${w.gen} draft=${w.draft} ===`);
  console.log(`${doc.game.date} vs ${doc.game.opponent} / home_away=${doc.game.home_away}`);
  const nameOf = docNameResolver(doc, players);
  const nm = (id: any) => (id == null ? "★null(不明)" : (nameOf(id) ?? String(id)));

  let totalRuns = 0, nullRunner = 0, unclearN = 0, moveToHome = 0, moveToHomeNullId = 0;
  console.log(`\n=== 打席 ${doc.plate_appearances.length}件 ===`);
  for (const p of doc.plate_appearances) {
    const H = p.half === "top" ? "表" : "裏";
    console.log(`\n${p.inning}回${H} #${p.order}  打者=${nm(p.batter_id)}  結果=${p.result}`);
    for (const bd of p.baserunning_during ?? []) {
      const rs = (bd.runners ?? []).map((r: any) => `${nm(r.runner_id)} ${r.from ?? "?"}→${r.to ?? "?"}`).join(" / ");
      console.log(`   走塁[中] ${bd.event}: ${rs || "(なし)"}`);
      for (const r of bd.runners ?? []) if (r.to === "home") { moveToHome++; if (r.runner_id == null) moveToHomeNullId++; }
    }
    for (const m of p.baserunning_after ?? []) {
      console.log(`   走塁[後] ${nm(m.runner_id)} ${m.from ?? "?"}→${m.to ?? "?"}`);
      if (m.to === "home") { moveToHome++; if (m.runner_id == null) moveToHomeNullId++; }
    }
    for (const run of p.runs ?? []) {
      totalRuns++; if (run.runner_id == null) nullRunner++;
      console.log(`   ★得点: 生還=${nm(run.runner_id)}  打点=${run.rbi}  自責=${run.earned}`);
    }
    for (const a of p.annotations ?? []) {
      if (a.type === "unclear") unclearN++;
      console.log(`   注記[${a.type}/${a.source ?? "?"}${a.rule ? "/" + a.rule : ""}]: ${a.detail}`);
    }
  }
  console.log(`\n=== 集計 ===`);
  console.log(`得点 総数=${totalRuns} / うち runner_id=null(得点者不明)=${nullRunner}`);
  console.log(`home への走塁移動=${moveToHome} / うち runner_id=null=${moveToHomeNullId}`);
  console.log(`unclear注記=${unclearN}`);
  console.log(`\n判定ヒント: runner_id=null が多い & home移動のrunner_idもnull → AIが from塁/走者を記録できていない(思考の浅さ)。`);
  console.log(`           home移動に runner_id(from塁)はあるのに runs が null/不明 → エンジン導出側の穴。`);
  await (await getClient()).close();
}
main().catch((e) => { console.error(e); process.exit(1); });
