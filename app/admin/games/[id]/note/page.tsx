import { loadNote } from "@/lib/db/notes";
import { loadWorking, publicGen } from "@/lib/db/games";
import { loadPlayers } from "@/lib/db/players";
import { batterLabel, playLine } from "@/lib/textlog";
import { derivePAStates } from "@/lib/ops/gamestate";
import { docNameResolver } from "@/lib/names";
import NoteClient from "./NoteClient";

export const dynamic = "force-dynamic";

export default async function NotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { id } = await params;
  const editParam = (await searchParams).edit;
  const [note, w, players, pubGen] = await Promise.all([loadNote(id), loadWorking(id), loadPlayers(), publicGen(id)]);
  const published = pubGen > 0; // 公開済み(=版履歴に公開版がある)なら、ノート空欄時に安心の一文を出す

  // ?edit=回-表裏-order → その打席を指す文言をノートの初期値に種付け(=テキスト遷移編集の起点)。
  //   変更は1打席に限らない(波及してよい)。種付けは ingestDelta が食う自由文の頭出しに過ぎない。
  //   「他の編集がある」=下書きがある/編集中ノートが残っているときは種付けせずエラー(破棄してから)。
  let seedError: string | null = null;
  let initialNote = note;
  if (editParam && w) {
    if (w.draft || note.trim() !== "") {
      seedError = "未確定の集計結果、または編集中のノートがあるため、打席の頭出しはできません。上の「確定（公開）」または「未確定の集計結果を破棄」を実行してから、もう一度お試しください。";
    } else {
      const [iStr, half, oStr] = editParam.split("-");
      const inning = Number(iStr), order = Number(oStr);
      if (inning && (half === "top" || half === "bottom") && order) {
        const target = w.doc.plate_appearances.find((p) => p.inning === inning && p.half === half && p.order === order);
        if (target) {
          const nameOf = docNameResolver(w.doc, players); // §9: participants が名前の正本
          const st = derivePAStates(w.doc).get(target);
          const lbl = `${inning}回${half === "top" ? "表" : "裏"}${order}番目`;
          initialNote = `${lbl}（${batterLabel(target, nameOf)}・${playLine(target, st?.outs ?? target.outs ?? 0)}）を `;
        }
      }
    }
  }

  return (
    <div>
      <p className="muted"><b>自由形式</b>で試合の記録を書く/貼って「AI集計」→ AIが内容を判断して試合結果として保存します。曖昧な情報は後から修正・追加できます。（テキストスコアで打席の「修正」を押すと、その打席を指す文がここに入ります）</p>
      <NoteClient gameId={id} initialNote={initialNote} seedError={seedError} published={published} />
    </div>
  );
}
