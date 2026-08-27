import { loadGames } from "@/lib/db/games";
import { loadPlayers, loadPlayerMap } from "@/lib/db/players";
import { aggregateSeasonP } from "@/lib/agg/participants";
import { avg, obp, slg, ops, era, fpct } from "@/lib/agg/types";
import { displayResult } from "@/lib/agg";
import { SortableTable, type Column } from "@/components/SortableTable";
import { listSeasons, resolveSeason, seasonOf } from "@/lib/season";
import { SeasonNav } from "@/components/SeasonNav";
import { playerName } from "@/lib/names";

// Atlas を実行時に読むため動的レンダリング（ビルド時にDB接続しない）
export const dynamic = "force-dynamic";

const BAT_COLS: Column[] = [
  { key: "name", label: "選手", left: true },
  { key: "g", label: "試" }, { key: "pa", label: "打席" }, { key: "ab", label: "打数" },
  { key: "h", label: "安打" }, { key: "b2", label: "二" }, { key: "b3", label: "三" }, { key: "hr", label: "本" },
  { key: "rbi", label: "打点" }, { key: "r", label: "得点" }, { key: "bb", label: "四球" }, { key: "hbp", label: "死球" },
  { key: "k", label: "三振" }, { key: "sb", label: "盗塁" },
  { key: "avg", label: "打率", format: "rate3" }, { key: "obp", label: "出塁", format: "rate3" },
  { key: "slg", label: "長打", format: "rate3" }, { key: "ops", label: "OPS", format: "rate3" },
];
const PIT_COLS: Column[] = [
  { key: "name", label: "選手", left: true },
  { key: "g", label: "登板" }, { key: "ip", label: "投球回", format: "ip" }, { key: "bf", label: "対打者" },
  { key: "h", label: "被安打" }, { key: "hr", label: "被本" }, { key: "k", label: "奪三振" },
  { key: "bb", label: "与四球" }, { key: "hbp", label: "与死球" }, { key: "r", label: "失点" },
  { key: "er", label: "自責" }, { key: "era", label: "防御率", format: "fixed2" },
];
const FLD_COLS: Column[] = [
  { key: "name", label: "選手", left: true },
  { key: "g", label: "試" }, { key: "po", label: "刺殺" }, { key: "a", label: "捕殺" },
  { key: "e", label: "失策" }, { key: "tc", label: "守備機会" }, { key: "fpct", label: "守備率", format: "rate3" },
];

export default async function SeasonPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season } = await searchParams;
  const all = await loadGames();
  const seasons = listSeasons(all.map((g) => g.game.date));
  const current = resolveSeason(seasons, season);
  const games = all.filter((g) => seasonOf(g.game.date) === current);
  const players = await loadPlayers();
  const masterMap = await loadPlayerMap(); // 種別(type)参照用: 新助っ人(roster link→マスタ種別 "guest")を隠す判定に使う
  const s = aggregateSeasonP(games); // §9: scope/合算キーは participants 解決(roster=マスタIDでクロス試合合算)
  const name = (id: string) => playerName(id, players);

  // 助っ人(ゲスト)を隠す = 正選手のみ表示。判定はマスタ種別 type==="guest" の一本。
  //   [§12 P5] 移行(P4)完了により現公開版に guest link は無く scope==="guest" は発生しない
  //     ＝暫定の scope 併用は不要(3表とも一貫)。※過去版プレビュー(?gen=N)の旧guest linkは集計層が scope で
  //     扱う(歴史版互換・撤去しない)が、このシーズン一覧は公開版のみを読むため種別一本で足りる。
  const isGuest = (line: { player_id: string }) =>
    masterMap.get(line.player_id)?.type === "guest";

  const batRows = s.batting.filter((b) => !isGuest(b)).map((b) => ({
    name: name(b.player_id), g: b.g, pa: b.pa, ab: b.ab, h: b.h, b2: b.b2, b3: b.b3, hr: b.hr,
    rbi: b.rbi, r: b.r, bb: b.bb, hbp: b.hbp, k: b.k, sb: b.sb,
    avg: avg(b), obp: obp(b), slg: slg(b), ops: ops(b),
  }));
  const pitRows = s.pitching.filter((p) => !isGuest(p)).map((p) => ({
    name: name(p.player_id), g: p.g, ip: p.outs, bf: p.bf, h: p.h, hr: p.hr, k: p.k,
    // [クラスタA] er/防御率 は不明(null)を「—」で表示(0.00 の捏造をしない)。不明混在のシーズン合算も null→「—」。
    bb: p.bb, hbp: p.hbp, r: p.r, er: p.er ?? "—", era: era(p) ?? "—",
  }));
  const fldRows = s.fielding.filter((f) => !isGuest(f)).map((f) => ({
    name: name(f.player_id), g: f.g, po: f.po, a: f.a, e: f.e, tc: f.tc, fpct: fpct(f),
  }));

  return (
    <div>
      <h1>{current}年 シーズン成績</h1>
      <SeasonNav seasons={seasons} current={current} basePath="/season" />
      <p className="muted">
        {games.length} 試合（{games.filter((g) => displayResult(g)?.outcome === "win").length} 勝）
        ・各表のヘッダをクリックで並べ替え
      </p>

      <h2>打撃</h2>
      <SortableTable columns={BAT_COLS} rows={batRows} initialKey="avg" storageKey="season-bat" />

      <h2>投手</h2>
      <SortableTable columns={PIT_COLS} rows={pitRows} initialKey="ip" storageKey="season-pit" />

      <h2>守備</h2>
      <SortableTable columns={FLD_COLS} rows={fldRows} initialKey="tc" storageKey="season-fld" />
    </div>
  );
}
