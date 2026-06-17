import Link from "next/link";
import { loadNote } from "@/lib/db/notes";
import { loadWorking, loadGame } from "@/lib/db/games";
import { loadPlayers } from "@/lib/db/players";
import { batterLabel, playLine } from "@/lib/textlog";
import { derivePAStates } from "@/lib/ops/gamestate";
import { playerName } from "@/lib/names";
import NoteClient, { type EditTarget } from "./NoteClient";

export const dynamic = "force-dynamic";

export default async function NotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { id } = await params;
  const editParam = (await searchParams).edit;
  const [note, w, pub, players] = await Promise.all([loadNote(id), loadWorking(id), loadGame(id), loadPlayers()]);
  const g = w?.doc.game ?? pub?.game;
  const label = g ? `${g.date}　${g.opponent}` : id;

  // ?edit=回-表裏-order → 対象打席の現在の記録を編集画面に渡す
  let editTarget: EditTarget | null = null;
  if (editParam && w) {
    const [iStr, half, oStr] = editParam.split("-");
    const inning = Number(iStr), order = Number(oStr);
    if (inning && (half === "top" || half === "bottom") && order) {
      const target = w.doc.plate_appearances.find((p) => p.inning === inning && p.half === half && p.order === order);
      if (target) {
        const addl = new Map((w.doc.additional_players ?? []).map((a) => [a.id, a.name]));
        const nameOf = (pid: string) => addl.get(pid) ?? playerName(pid, players);
        const st = derivePAStates(w.doc).get(target);
        editTarget = {
          inning, half, order,
          label: `${inning}回${half === "top" ? "表" : "裏"} ${order}番目`,
          batter: batterLabel(target, nameOf),
          play: playLine(target, st?.outs ?? target.outs),
        };
      }
    }
  }

  return (
    <div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        <Link href={`/admin/games/${id}`}>← 試合管理</Link>　/　<Link href={`/games/${id}/text?preview=1`}>テキストスコア</Link>
      </p>
      <h1>ノート入力　<span className="muted">{label}</span></h1>
      <p className="muted">試合のメモを貼る/書く → <b>AI集計</b>で下書きに反映。曖昧な箇所はテキストスコアの「修正」から<b>AI修正</b>で直します。</p>
      <NoteClient gameId={id} initialNote={note} editTarget={editTarget} />
    </div>
  );
}
