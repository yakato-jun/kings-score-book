import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { loadGame } from "@/lib/db/games";
import { upsertGameMeta, setAttendance } from "@/lib/ops/games";
import { listPlayers } from "@/lib/ops/players";
import type { GameResult, AttendanceEntry } from "@/lib/types/v2";

export const dynamic = "force-dynamic";

const DECIDED: [string, string][] = [
  ["regulation", "通常"], ["time_limit", "時間切れ"], ["walkoff", "サヨナラ"],
  ["called", "コールド"], ["forfeit", "不戦"], ["tie", "引分"],
];
const OUTCOME: [string, string][] = [["win", "勝"], ["loss", "負"], ["tie", "分"]];

export default async function GameEdit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const doc = await loadGame(id);
  if (!doc) notFound();
  const players = await listPlayers();
  const g = doc.game;
  const r = g.result;
  const att = new Map(doc.attendance.map((a) => [a.player_id, a.status]));

  async function saveMeta(formData: FormData) {
    "use server";
    const our = String(formData.get("our_score") ?? "").trim();
    const their = String(formData.get("their_score") ?? "").trim();
    const ha = String(formData.get("home_away") ?? "");
    const result: GameResult | null =
      our !== "" && their !== ""
        ? {
            our_score: Number(our),
            their_score: Number(their),
            outcome: String(formData.get("outcome") ?? "win") as GameResult["outcome"],
            decided_by: String(formData.get("decided_by") ?? "regulation") as GameResult["decided_by"],
          }
        : null;
    await upsertGameMeta({
      id,
      date: String(formData.get("date") ?? ""),
      opponent: String(formData.get("opponent") ?? ""),
      league: String(formData.get("league") ?? ""),
      home_away: ha === "home" || ha === "away" ? ha : null,
      dh: formData.get("dh") === "on",
      result,
    });
    revalidatePath(`/admin/games/${id}`);
  }

  async function saveAttendance(formData: FormData) {
    "use server";
    const entries: AttendanceEntry[] = [];
    for (const [k, v] of formData.entries()) {
      if (k.startsWith("att-") && (v === "played" || v === "bench")) {
        entries.push({ player_id: k.slice(4), status: v, scope: "own" });
      }
    }
    await setAttendance(id, entries);
    revalidatePath(`/admin/games/${id}`);
  }

  return (
    <div>
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        <Link href="/admin/games">← 試合管理</Link>　/　<Link href={`/games/${id}`}>表示ページ</Link>
      </p>
      <h1>{id} の編集</h1>

      <h2>メタ情報</h2>
      <form action={saveMeta} className="adminform">
        <label>日付<input type="date" name="date" defaultValue={g.date} required /></label>
        <label>対戦相手<input name="opponent" defaultValue={g.opponent} required /></label>
        <label>区分（リーグ）<input name="league" defaultValue={g.league ?? ""} placeholder="東葛Bリーグ 等" /></label>
        <label>先後<select name="home_away" defaultValue={g.home_away ?? ""}>
          <option value="away">先攻</option><option value="home">後攻</option><option value="">未定</option>
        </select></label>
        <label className="chk"><input type="checkbox" name="dh" defaultChecked={g.dh} />DH制</label>
        <fieldset>
          <legend>結果（スコア空欄なら未記録）</legend>
          <label>自スコア<input type="number" name="our_score" defaultValue={r ? r.our_score : ""} min={0} /></label>
          <label>相手スコア<input type="number" name="their_score" defaultValue={r ? r.their_score : ""} min={0} /></label>
          <label>勝敗<select name="outcome" defaultValue={r?.outcome ?? "win"}>
            {OUTCOME.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
          <label>決着<select name="decided_by" defaultValue={r?.decided_by ?? "regulation"}>
            {DECIDED.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
        </fieldset>
        <div><button>メタ情報を保存</button></div>
      </form>

      <h2>出欠</h2>
      <p className="muted">出場＝成績あり / ベンチ＝参加のみ（成績なし） / 欠席＝記録なし。出欠は成績と独立した第一級の記録です。</p>
      <form action={saveAttendance} className="adminform">
        <div className="attgrid">
          {players.map((p) => {
            const cur = att.get(p.id) ?? "absent";
            return (
              <label key={p.id} className="attrow">
                <span className="aname">{p.name}<span className="muted"> {p.id}</span></span>
                <select name={`att-${p.id}`} defaultValue={cur}>
                  <option value="played">出場</option>
                  <option value="bench">ベンチ</option>
                  <option value="absent">欠席</option>
                </select>
              </label>
            );
          })}
        </div>
        <div><button>出欠を保存</button></div>
      </form>
    </div>
  );
}
