import { notFound } from "next/navigation";
import { loadWorking } from "@/lib/db/games";
import { loadPlayers } from "@/lib/db/players";
import { gameState, deriveNextPA, kingsBatHalf, lineupSlots } from "@/lib/ops/gamestate";
import { docNameResolver } from "@/lib/names";
import { buildPARows, buildCurrentLineup, buildPitcherRows, buildDirectStatRows } from "@/lib/ops/score-view";
import { ScoreInput } from "./ScoreInput";

export const dynamic = "force-dynamic";

const FROM: Record<string, string> = { first: "1", second: "2", third: "3" };

/** スコア入力タブ＝試合データエディタ(§10)。盤面/次打者/全打席の事実・導出プレビューをエンジンで導出しクライアントへ渡す。 */
export default async function ScorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const w = await loadWorking(id);
  if (!w) notFound();
  const doc = w.doc;
  const players = await loadPlayers();
  const nameOf = docNameResolver(doc, players); // §9: participants が名前の正本

  const st = gameState(doc);
  const kb = kingsBatHalf(doc);
  // 表裏それぞれの「次の打席」を導出(フォームで表裏を切り替えても正しい次打者を予告できる)
  const mkNext = (half: "top" | "bottom") => {
    const inning = half === st.half ? st.inning : doc.plate_appearances.filter((p) => p.half === half).reduce((m, p) => Math.max(m, p.inning), 0) + 1;
    const d = deriveNextPA(doc, inning, half);
    return { inning, batterName: d.batter_id ? nameOf(d.batter_id) : null, opponentSlot: d.opponent_slot };
  };
  const nextByHalf = { top: mkNext("top"), bottom: mkNext("bottom") };

  const runners = (["first", "second", "third"] as const)
    .map((b) => ({ from: FROM[b], runner_id: st.runners[b] ?? null }))
    .filter((r) => r.runner_id)
    .map((r) => ({ from: r.from, name: nameOf(r.runner_id!) }));

  const lineup = lineupSlots(doc).map((e) => ({ order: e.order ?? null, position_id: e.position_id ?? null, player_id: e.player_id, name: nameOf(e.player_id) }));
  const hasLineup = lineup.length > 0;

  // §10 エディタ用: 全打席の事実＋導出プレビュー・現在の打順守備・登板投手
  const rows = buildPARows(doc, nameOf);
  const currentLineup = buildCurrentLineup(doc, nameOf);
  const pitchers = buildPitcherRows(doc, nameOf);
  const directStats = buildDirectStatRows(doc, nameOf);

  // 打者候補: この試合の参加者(助っ人含む) ＋ 未参加のマスタ選手(選ぶと自動で参加者に)
  const parts = (doc.participants ?? []).map((p) => ({ id: p.id, name: nameOf(p.id), kind: p.link.kind }));
  const inGame = new Set((doc.participants ?? []).flatMap((p) => (p.link.kind === "roster" ? [p.link.player_id] : [])));
  const masters = [...players].filter(([pid]) => !inGame.has(pid)).map(([pid, name]) => ({ id: pid, name }));

  const g = doc.game;
  const meta = {
    home_away: g.home_away,
    our_score: g.result?.our_score ?? null,
    their_score: g.result?.their_score ?? null,
    outcome: g.result?.outcome ?? null,
    decided_by: g.result?.decided_by ?? null,
    line_score: g.result?.line_score ?? null,
  };

  return (
    <ScoreInput
      gameId={id}
      gen={w.gen}
      hasDraft={w.draft}
      hasLineup={hasLineup}
      situation={{ inning: st.inning, half: st.half, outs: st.outs, kings: st.kings_score, opp: st.opp_score, kingsBatHalf: kb }}
      nextByHalf={nextByHalf}
      runners={runners}
      lineup={lineup}
      rows={rows}
      currentLineup={currentLineup}
      pitchers={pitchers}
      directStats={directStats}
      meta={meta}
      participants={parts}
      masters={masters}
    />
  );
}
