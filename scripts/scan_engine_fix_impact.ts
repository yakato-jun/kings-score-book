/**
 * [診断・読み取りのみ] 物理順修正(2026-08: 先行走者のafter → 打者配置 → 打者自身のafter)の影響スキャン。
 * 全試合(公開版 + working=下書き先端)の各打席について、
 *  (1) 保存済み moves から新エンジンで deriveScorers(check)/deriveRuns(fill) を再計算し、
 *      保存されている runs[] の (runner_id集合, 件数) と比較 → 差分がある打席を列挙
 *  (2) resolveBaserunningIds(respectIds:true) の再解決で runner_id が変わる move を列挙(スイープを流した時の変化の事前確認)
 * DBへの書込は一切しない(保存は書き換えない)。
 * 実行: node --env-file=.env.local --import tsx scripts/scan_engine_fix_impact.ts
 */
import { getClient } from "../lib/db/mongo";
import { loadGames, loadWorking, draftGameIds } from "../lib/db/games";
import { foldRunners, deriveScorers, deriveRuns, resolveBaserunningIds } from "../lib/ops/gamestate";
import type { GameDoc, PlateAppearance, Runners, BaserunMove } from "../lib/types/v2";

const EMPTY: Runners = { first: null, second: null, third: null };
const H = (h: string) => (h === "top" ? "表" : "裏");

/** runner_id の集合表示(順不同比較のためソート・null=得点者不明もそのまま出す)。件数も添える */
const setStr = (ids: (string | null | undefined)[]): string =>
  `{${ids.map((x) => x ?? "null").sort().join(",")}}(${ids.length}件)`;

interface Tally { pas: number; runsDiff: number; moveDiff: number; moveDiffFresh: number }

function scanDoc(label: string, doc: GameDoc, tally: Tally): void {
  // 開始時盤面は保存値でなく半イニングごとの畳み込みで導出(=エンジンの読み方 derivePAStates と同一)
  const byHalf = new Map<string, PlateAppearance[]>();
  for (const p of doc.plate_appearances ?? []) {
    const k = `${p.inning}-${p.half}`;
    (byHalf.get(k) ?? byHalf.set(k, []).get(k)!).push(p);
  }
  for (const list of byHalf.values()) {
    const ordered = [...list].sort((a, b) => a.order - b.order);
    let board: Runners = EMPTY;
    for (const p of ordered) {
      tally.pas++;
      const where = `${label}/${p.inning}回${H(p.half)}/#${p.order}`;
      // (1) 保存 runs[] vs 新エンジン再計算(fill=deriveRuns / check=deriveScorers)。
      //    origin:"manual" の得点(人の明示記録)は再導出で変化しない保全対象なので比較から除外(偽差分ノイズ対策)。
      const saved = setStr((p.runs ?? []).filter((x) => (x as { origin?: string }).origin !== "manual").map((x) => x.runner_id));
      const fill = setStr(deriveRuns(board, p).map((x) => x.runner_id));
      const check = setStr(deriveScorers(board, p));
      if (saved !== fill || saved !== check) {
        tally.runsDiff++;
        console.log(`[runs]  ${where}: 保存=${saved} 再計算fill=${fill} 再計算check=${check}`);
      }
      // (2a) respectIds 再解決(スイープ経路)で runner_id が変わる move=スイープを流した時に実際に変わる分。
      // (2b) ★素の再解決(respectIds無し=新規入力と同じ「保存IDを信用しない」解決)との差分=破損候補。
      //    旧エンジンが打者IDを走者moveに誤保存したケース(実戦例#5型)は respectIds が「打者は常に在塁」で
      //    尊重してしまい(2a)では差分0になる(レビューmajor指摘)。(2b)は手動編集で意図的に上書きしたIDも
      //    差分に出る可能性があるため「候補(要目視)」として区別して列挙する。
      const flat = (q: PlateAppearance): { tag: string; m: BaserunMove }[] => [
        ...(q.baserunning_during ?? []).flatMap((ev, i) =>
          (ev.runners ?? []).map((m, j) => ({ tag: `during#${i}.${j}(${ev.event})`, m }))),
        ...(q.baserunning_after ?? []).map((m, j) => ({ tag: `after#${j}`, m })),
      ];
      const before = flat(p);
      for (const [mode, re] of [["respect", resolveBaserunningIds(board, p, { respectIds: true })], ["fresh", resolveBaserunningIds(board, p)]] as const) {
        const afterFix = flat(re);
        for (let i = 0; i < before.length; i++) {
          const a = before[i].m.runner_id ?? null;
          const b = afterFix[i]?.m.runner_id ?? null;
          if (a !== b) {
            if (mode === "respect") tally.moveDiff++; else tally.moveDiffFresh++;
            console.log(`[moves:${mode}] ${where} ${before[i].tag} ${before[i].m.from ?? "?"}→${before[i].m.to}: 保存=${a ?? "null"} 再解決=${b ?? "null"}`);
          }
        }
      }
      board = foldRunners(board, p); // 次打席の開始盤面(新エンジンで進める)
    }
  }
}

async function main(): Promise<void> {
  const tally: Tally = { pas: 0, runsDiff: 0, moveDiff: 0, moveDiffFresh: 0 };
  let docs = 0;
  for (const doc of await loadGames()) {
    scanDoc(doc.game.id, doc, tally);
    docs++;
  }
  // working: 先端が下書きの試合のみ追加スキャン(先端=公開なら上の公開版と同一なので二重に読まない)
  for (const id of await draftGameIds()) {
    const w = await loadWorking(id);
    if (w?.draft) {
      scanDoc(`${id}(working)`, w.doc, tally);
      docs++;
    }
  }
  console.log("\n=== サマリ ===");
  console.log(`スキャン: ${docs} doc / ${tally.pas} 打席`);
  console.log(`runs差分(保存 vs 新エンジン再計算): ${tally.runsDiff} 打席`);
  console.log(`respectIds再解決で runner_id が変わる move(スイープで実際に変わる分): ${tally.moveDiff} 件`);
  console.log(`素の再解決との差分(破損候補・要目視。手動上書きの正当な差も含み得る): ${tally.moveDiffFresh} 件`);
  await (await getClient()).close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
