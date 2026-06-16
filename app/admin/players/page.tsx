import Link from "next/link";
import { revalidatePath } from "next/cache";
import { listPlayers, nextPlayerId, upsertPlayer } from "@/lib/ops/players";

export const dynamic = "force-dynamic";

// Server Action: 新規/編集 共通。操作レイヤ upsertPlayer を呼ぶだけ（AIも同じ関数を使う）。
async function savePlayer(formData: FormData) {
  "use server";
  await upsertPlayer({
    id: String(formData.get("id") ?? ""),
    name: String(formData.get("name") ?? ""),
    type: String(formData.get("type") ?? ""),
  });
  revalidatePath("/admin/players");
}

export default async function PlayersAdmin() {
  const players = await listPlayers();
  const suggestId = await nextPlayerId();

  return (
    <div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        <Link href="/admin">← 管理</Link>
      </p>
      <h1>選手マスタ</h1>
      <p className="muted">名前は機密のため Atlas の players コレクションに保存されます（リポジトリ外）。</p>

      <div className="adminlist">
        {players.map((p) => (
          <form key={p.id} action={savePlayer} className="adminrow">
            <span className="pid">{p.id}</span>
            <input type="hidden" name="id" value={p.id} />
            <input name="name" defaultValue={p.name} className="iname" aria-label="名前" />
            <input name="type" defaultValue={p.type ?? ""} className="itype" placeholder="種別" aria-label="種別" />
            <button>保存</button>
          </form>
        ))}
      </div>

      <h2>新規追加</h2>
      <form action={savePlayer} className="adminrow">
        <input name="id" defaultValue={suggestId} className="pid" aria-label="ID" />
        <input name="name" placeholder="名前" required className="iname" aria-label="名前" />
        <input name="type" placeholder="種別(任意)" className="itype" aria-label="種別" />
        <button>追加</button>
      </form>
      <p className="muted" style={{ marginTop: "0.75rem" }}>
        ID は P001 形式。既存IDで保存すると上書き（編集）、新しいIDなら追加になります。
      </p>
    </div>
  );
}
