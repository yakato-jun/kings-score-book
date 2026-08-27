import Link from "next/link";
import { revalidatePath } from "next/cache";
import { listPlayers, nextPlayerId, upsertPlayer } from "@/lib/ops/players";

export const dynamic = "force-dynamic";

// [§12] 助っ人＝種別 "guest"、正選手＝それ以外(既存 member/空 も正選手扱い＝値を狭めない)。
const isGuest = (t?: string) => (t ?? "").trim() === "guest";

// Server Action: 選手を追加。ID は nextPlayerId で採番＝ユーザーにID(P###)を入力させない。
// upsertPlayer は AI 入力と共通の操作レイヤ(「UIでできること＝AIでできること」)。
async function addPlayer(formData: FormData) {
  "use server";
  const id = await nextPlayerId();
  await upsertPlayer({
    id,
    name: String(formData.get("name") ?? ""),
    type: String(formData.get("type") ?? ""), // "member"(正選手) | "guest"(助っ人)
  });
  revalidatePath("/admin/players");
}

export default async function PlayersAdmin({ searchParams }: { searchParams: Promise<{ guests?: string }> }) {
  const players = await listPlayers();
  const showGuests = (await searchParams).guests === "1"; // 既定OFF＝助っ人(guest)は非表示(正選手のみ)
  // 一覧は読み取り専用＝各選手は編集画面へのリンク(選手の編集はめったに無い前提で常時編集UIは置かない)。
  const visible = players.filter((p) => showGuests || !isGuest(p.type));

  return (
    <div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        <Link href="/admin">← 管理</Link>
      </p>
      <h1>選手マスタ</h1>
      <p className="muted">選手名をクリックすると編集画面へ移動します（名前・種別の変更、別の選手への名寄せ）。</p>

      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        {showGuests ? (
          <Link href="/admin/players">☑ 助っ人も表示（クリックで正選手のみ）</Link>
        ) : (
          <Link href="/admin/players?guests=1">☐ 助っ人も表示</Link>
        )}
      </p>

      <ul className="plist">
        {visible.map((p) => (
          // key/href には内部ID(P###)を使うが、画面には出さない(名前と種別だけ見せる)。
          <li key={p.id}>
            <Link href={`/admin/players/${p.id}`}>
              <span className="pname">{p.name}</span>
              {/* 助っ人のときだけ印(既定=正選手のみ表示なので"正選手"札は付けない＝ノイズ削減)。 */}
              {isGuest(p.type) && <span className="pbadge guest">助っ人</span>}
            </Link>
          </li>
        ))}
      </ul>

      <h2>選手を追加</h2>
      {/* 明示アクション＝名前＋種別(既定 正選手)だけ。ID入力欄は無し(Server Action 内で採番)。 */}
      <form action={addPlayer} className="adminform">
        <label>名前<input name="name" placeholder="名前" required /></label>
        <label>種別
          <select name="type" defaultValue="member">
            <option value="member">正選手</option>
            <option value="guest">助っ人</option>
          </select>
        </label>
        <button>追加</button>
      </form>
      <p className="muted" style={{ marginTop: "0.5rem" }}>
        種別を「助っ人」にするとシーズン名簿から隠れます（過去成績は通算に残ります）。
      </p>
    </div>
  );
}
