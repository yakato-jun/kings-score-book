import { loadGames } from "@/lib/db/games";
import { loadPlayers } from "@/lib/db/players";
import { aggregateSeason } from "@/lib/agg";
import { avg, obp, slg, ops, era, fpct } from "@/lib/agg/types";
import { SortableTable, type Column } from "@/components/SortableTable";

// Atlas を実行時に読むため動的レンダリング（ビルド時にDB接続しない）
export const dynamic = "force-dynamic";

const SEASON = "2026";

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

export default async function SeasonPage() {
  const games = (await loadGames()).filter((g) => g.game.date.startsWith(SEASON));
  const players = await loadPlayers();
  const s = aggregateSeason(games);
  const name = (id: string) => players.get(id) ?? id;

  // 自軍(own)のみ表示。ゲスト(助っ人)は除外。
  const batRows = s.batting.filter((b) => b.scope === "own").map((b) => ({
    name: name(b.player_id), g: b.g, pa: b.pa, ab: b.ab, h: b.h, b2: b.b2, b3: b.b3, hr: b.hr,
    rbi: b.rbi, r: b.r, bb: b.bb, hbp: b.hbp, k: b.k, sb: b.sb,
    avg: avg(b), obp: obp(b), slg: slg(b), ops: ops(b),
  }));
  const pitRows = s.pitching.filter((p) => p.scope === "own").map((p) => ({
    name: name(p.player_id), g: p.g, ip: p.outs, bf: p.bf, h: p.h, hr: p.hr, k: p.k,
    bb: p.bb, hbp: p.hbp, r: p.r, er: p.er, era: era(p),
  }));
  const fldRows = s.fielding.filter((f) => f.scope === "own").map((f) => ({
    name: name(f.player_id), g: f.g, po: f.po, a: f.a, e: f.e, tc: f.tc, fpct: fpct(f),
  }));

  return (
    <div>
      <h1>{SEASON} シーズン成績</h1>
      <p className="muted">
        {games.length} 試合（{games.filter((g) => g.game.result?.outcome === "win").length} 勝）
        ・各表のヘッダをクリックで並べ替え
      </p>

      <h2>打撃</h2>
      <SortableTable columns={BAT_COLS} rows={batRows} initialKey="pa" />

      <h2>投手</h2>
      <SortableTable columns={PIT_COLS} rows={pitRows} initialKey="ip" />

      <h2>守備</h2>
      <SortableTable columns={FLD_COLS} rows={fldRows} initialKey="tc" />
    </div>
  );
}
