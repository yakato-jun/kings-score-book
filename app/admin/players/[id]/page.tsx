import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { listPlayers, upsertPlayer } from "@/lib/ops/players";
import { MergePlayerControl } from "./MergePlayerControl";

export const dynamic = "force-dynamic";

// [§12] 助っ人＝種別 "guest"、正選手＝それ以外(既存 member/空 も正選手扱い＝値を狭めない)。
const isGuest = (t?: string) => (t ?? "").trim() === "guest";

// 「選手を選択→編集画面」の編集画面。1人分の名前・種別を編集する(一覧は読み取り専用)。
export default async function PlayerEdit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const players = await listPlayers();
  const found = players.find((p) => p.id === id);
  if (!found) notFound();
  const player = found; // notFound()後の narrowed 値を const に固定(Server Action closure 内でも Player 型を保つ)
  // 名寄せ先候補は自分以外の全選手(名前で選ぶ・内部コードは見せない)。助っ人↔正選手のどちらへも寄せられる。
  const targets = players.filter((p) => p.id !== player.id).map((p) => ({ id: p.id, name: p.name }));

  // Server Action: この選手1人分を保存(upsertPlayer で名前・種別を上書き)。origin(出自)は保持＝非破壊。
  async function savePlayer(formData: FormData) {
    "use server";
    await upsertPlayer({
      id: player.id,
      name: String(formData.get("name") ?? ""),
      type: String(formData.get("type") ?? ""), // "guest"(助っ人) | 既存の非guest値(正選手・値を狭めない)
      origin: player.origin,
    });
    revalidatePath("/admin/players");
    revalidatePath(`/admin/players/${player.id}`);
  }

  return (
    <div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        <Link href="/admin/players">← 選手マスタ</Link>
      </p>
      <h1>選手の編集</h1>

      <form action={savePlayer} className="adminform">
        <label>名前<input name="name" defaultValue={player.name} required /></label>
        {/* 種別＝2択(正選手/助っ人)。正選手は既存の非guest値を保持し値を狭めない(guestのみ "guest")。 */}
        <label>種別
          <select name="type" defaultValue={isGuest(player.type) ? "guest" : (player.type?.trim() || "regular")}>
            <option value={player.type?.trim() && !isGuest(player.type) ? player.type.trim() : "regular"}>正選手</option>
            <option value="guest">助っ人</option>
          </select>
        </label>
        <button>保存</button>
      </form>

      <h2>別の選手に名寄せ（統合）</h2>
      <p className="muted">この選手の全出場を選んだ選手へ移し、1人にまとめます（過去の成績も統合先へ移動）。統合後この選手は一覧から消えます。</p>
      <MergePlayerControl player={{ id: player.id, name: player.name }} targets={targets} />
    </div>
  );
}
