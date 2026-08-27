/**
 * [清掃・一回きり] どの試合からも参照されていない type==="guest" の選手(残留助っ人マスタ)を一掃する。
 * 過去の「下書き破棄で draft が作った guest マスタが残留 → 作り直しのたびに新規採番で増殖」で溜まった
 * 既存の重複の後始末(going-forward は discardGame が破棄時に掃除するため、以後は溜まらない)。
 *
 * ★運用前提: 実行前に dry-run の一覧をユーザーに提示して承認を得ること(承認なしに --apply しない)。
 *
 * 参照判定は保守的: 全試合のドキュメント(公開版＋下書き中の working=先端)を JSON.stringify して
 * player_id 文字列の包含で判定する(誤検出=残す方向に倒す。参照形態の列挙漏れで消しすぎるより残留が安全)。
 *
 * 既定は dry-run(削除対象の id と名前を表示するだけ・一切書き込まない)。--apply 指定時だけ deletePlayer で削除。
 * 実行: node --env-file=.env.local --import tsx scripts/cleanup_orphan_guests.ts [--apply]
 */
import { getClient } from "../lib/db/mongo";
import { loadGames, loadWorking, draftGameIds } from "../lib/db/games";
import { loadPlayerList, deletePlayer } from "../lib/db/players";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  const guests = (await loadPlayerList()).filter((p) => p.type === "guest");
  if (!guests.length) {
    console.log("種別guestの選手がいません。何もしません。");
    await (await getClient()).close();
    return;
  }

  // 走査対象: 全試合の公開版＋下書きを持つ試合の working(先端)＝未公開の新規試合の下書きも含める。
  // 下書きの無い試合は working=公開版なので loadGames で網羅済み。
  const texts: string[] = (await loadGames()).map((d) => JSON.stringify(d));
  for (const id of await draftGameIds()) {
    const w = await loadWorking(id);
    if (w) texts.push(JSON.stringify(w.doc));
  }
  // 包含判定(保守的): どこか1試合にでも id が現れる guest は「参照あり」として残す(疑わしきは残す)。
  const orphans = guests.filter((g) => !texts.some((t) => t.includes(g.id)));

  console.log(`種別guest ${guests.length}名 / 参照あり ${guests.length - orphans.length}名 / 未参照(削除対象) ${orphans.length}名`);
  for (const g of orphans) console.log(`  ${g.id} ${g.name}`);

  if (!APPLY) {
    console.log("\n--- dry-run(何も削除していません)。一覧をユーザーに提示し、承認を得てから --apply で削除 ---");
    await (await getClient()).close();
    return;
  }

  for (const g of orphans) {
    await deletePlayer(g.id);
    console.log(`DELETED ${g.id} ${g.name}`);
  }
  console.log(`\n=== 削除完了: ${orphans.length}名 ===`);
  await (await getClient()).close();
}
main().catch((e) => { console.error(e); process.exit(1); });
