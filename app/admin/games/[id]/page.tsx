import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { loadGame, loadWorking, publicGen, GenConflictError } from "@/lib/db/games";
import { upsertGameMeta, setAttendance, removeParticipant, addParticipant } from "@/lib/ops/games";
import { unresolvedUnclear } from "@/lib/ops/validate";
import { listPlayers, createGuestPlayer } from "@/lib/ops/players";
import { loadPlayers } from "@/lib/db/players";
import { docNameResolver } from "@/lib/names";
import { DraftBlockNotice } from "@/components/DraftBlockNotice";
import { DeleteGameButton } from "./DeleteGameButton";
import { AttendanceGroups } from "./AttendanceGroups";
import { ResultOverride } from "./ResultOverride";
import { GuardedActionForm, DirtySourceForm } from "@/components/FormGuards";
import { draftBlockMsg, draftRaceMsg } from "@/lib/draft-msg";
import type { GameResult } from "@/lib/types/v2";

export const dynamic = "force-dynamic";

export default async function GameEdit({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ conflict?: string; perr?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const conflict = sp.conflict; // 軸2: 手修正が楽観ロックで弾かれた直後の再描画(?conflict=meta|att)
  const perr = sp.perr; // 参加者操作のエラー表示(参照ガード等)
  const doc = await loadGame(id);
  if (!doc) notFound();
  const players = await listPlayers();
  const playersMap = await loadPlayers();
  const nameOf = docNameResolver(doc, playersMap);
  const w = await loadWorking(id);
  const pubGen = await publicGen(id); // 手修正の楽観ロック基準(描画時の公開版gen)
  const unclear = (w?.doc.plate_appearances ?? []).filter((p) => unresolvedUnclear(p).length > 0).length;
  const hasDraft = w?.draft ?? false; // 下書きが居る間は手修正(メタ/出欠)を禁止
  const g = doc.game;
  const r = g.result;
  // §9: 出欠=participants。出席=participantsに在籍する roster 選手(guest は参加者一覧で管理)
  const parts = doc.participants ?? [];
  const presentRoster = parts.flatMap((p) => (p.link.kind === "roster" ? [p.link.player_id] : []));

  async function saveMeta(formData: FormData) {
    "use server";
    // 「基本は導出・手入力は上書き」: 上書きチェックON かつ両スコア入力時だけ手入力 result を作る。
    // OFF(=送信されない)なら result=null にして記録スコアからの導出に委ねる。
    const override = formData.get("override") != null;
    const our = String(formData.get("our_score") ?? "").trim();
    const their = String(formData.get("their_score") ?? "").trim();
    const ha = String(formData.get("home_away") ?? "");
    const result: GameResult | null =
      override && our !== "" && their !== ""
        ? {
            our_score: Number(our),
            their_score: Number(their),
            outcome: String(formData.get("outcome") ?? "win") as GameResult["outcome"],
            decided_by: String(formData.get("decided_by") ?? "regulation") as GameResult["decided_by"],
          }
        : null;
    let conflict = false;
    try {
      await upsertGameMeta(
        {
          id,
          date: String(formData.get("date") ?? ""),
          opponent: String(formData.get("opponent") ?? ""),
          league: String(formData.get("league") ?? ""),
          home_away: ha === "home" || ha === "away" ? ha : null,
          result,
        },
        { base_gen: pubGen } // 下書きが割り込んでいたら GenConflictError で弾く
      );
    } catch (e) {
      if (e instanceof GenConflictError) conflict = true; // 軸2: 黙殺せず可視化(?conflict)
      else throw e;
    }
    revalidatePath(`/admin/games/${id}`);
    redirect(`/admin/games/${id}${conflict ? "?conflict=meta" : ""}`); // 成功時は ?conflict を消す
  }

  async function saveAttendance(formData: FormData) {
    "use server";
    // 出席者のみ在籍マーカーで送られる(欠席=送られない=setAttendanceが外す)。在籍=出席で一本化。
    const entries: { player_id: string }[] = [];
    for (const [k, v] of formData.entries()) {
      if (k.startsWith("att-") && v === "1") entries.push({ player_id: k.slice(4) });
    }
    let q = "";
    try {
      await setAttendance(id, entries, { base_gen: pubGen });
    } catch (e) {
      if (e instanceof GenConflictError) q = "?conflict=att"; // 軸2: 黙殺せず可視化
      else if (e instanceof Error) q = `?perr=${encodeURIComponent(e.message)}`; // 参照ガード(欠席にできない)等
      else throw e;
    }
    revalidatePath(`/admin/games/${id}`);
    redirect(`/admin/games/${id}${q}`);
  }

  /** 参加者一覧の行操作(§9.6/§12): 削除/助っ人追加。すべて public 直コミット＋楽観ロック。 */
  async function participantAction(formData: FormData) {
    "use server";
    const act = String(formData.get("act") ?? "");
    const pid = String(formData.get("pid") ?? "");
    let q = "";
    try {
      if (act === "remove") await removeParticipant(id, pid, { base_gen: pubGen });
      else if (act === "add-guest") {
        // [§12 P1] 助っ人＝種別guestのマスタ選手。新規名前は createGuestPlayer で採番→player_id で参加者化する
        //   (guest 名インラインの participant は作らない)。
        const nm = String(formData.get("guest_name") ?? "").trim();
        if (nm) {
          const gp = await createGuestPlayer(nm);
          await addParticipant(id, { player_id: gp.id }, { base_gen: pubGen });
        }
      }
    } catch (e) {
      if (e instanceof GenConflictError) q = `?perr=${encodeURIComponent(draftRaceMsg("参加者を変更"))}`;
      else if (e instanceof Error) q = `?perr=${encodeURIComponent(e.message)}`;
      else throw e;
    }
    revalidatePath(`/admin/games/${id}`);
    redirect(`/admin/games/${id}${q}`);
  }

  return (
    <div>
      {conflict && (
        <p className="loss">{draftRaceMsg(conflict === "att" ? "出欠を保存" : "メタ情報を保存")}</p>
      )}
      {perr && <p className="loss">{perr}</p>}
      {unclear > 0 && (
        <p className="flagbar"><b>要確認 {unclear}件</b>あります。<Link href={`/games/${id}/text?preview=1`}>テキストスコア（プレビュー）</Link>で確認し、「承認」するか、<Link href={`/admin/games/${id}/note`}>ノート入力</Link>で直して再集計してください。</p>
      )}
      {hasDraft && <DraftBlockNotice gameId={id} op="メタ・出欠を手修正" />}

      <h2>試合情報</h2>
      <DirtySourceForm action={saveMeta} className="adminform">
        <label>日付<input type="date" name="date" defaultValue={g.date} required /></label>
        <label>対戦相手<input name="opponent" defaultValue={g.opponent} required /></label>
        <label>区分（リーグ）<input name="league" defaultValue={g.league ?? ""} placeholder="東葛Bリーグ 等" /></label>
        <label>先後<select name="home_away" defaultValue={g.home_away ?? ""}>
          <option value="away">先攻</option><option value="home">後攻</option><option value="">未定</option>
        </select></label>
        <ResultOverride
          defaultOverride={r != null}
          our={r ? r.our_score : ""}
          their={r ? r.their_score : ""}
          outcome={r?.outcome ?? "win"}
          decidedBy={r?.decided_by ?? "regulation"}
          disabled={hasDraft}
        />
        <div>
          <button disabled={hasDraft} title={hasDraft ? draftBlockMsg("メタ情報を保存") : undefined}>メタ情報を保存</button>
          {hasDraft && <span className="muted">　未確定の集計結果がある間は保存できません（上の案内参照）</span>}
        </div>
      </DirtySourceForm>

      <h2>出欠</h2>
      <p className="muted">出席＝この試合に参加 / 欠席＝不参加。名前をクリックで反対のグループへ移動して「出欠を保存」。助っ人は下の参加者一覧で追加します。</p>
      <AttendanceGroups players={players} presentIds={presentRoster} action={saveAttendance} disabled={hasDraft} />
      {hasDraft && <p className="muted">　未確定の集計結果がある間は保存できません（上の案内参照）。</p>}

      <h2>参加者一覧</h2>
      <p className="muted">この試合の人リスト（成績はここの参加者に紐づく）。削除は成績の参照が無い場合のみ可能です。シーズン集計から外すには選手の種別を助っ人にします（選手マスタ側で管理）。</p>
      {parts.length === 0 ? (
        <p className="muted">参加者がいません（スタメン登録か出欠保存で作成されます）。</p>
      ) : (
        <table>
          <thead><tr><th className="tl">名前</th><th>種別</th><th>出欠</th><th className="tl">操作</th></tr></thead>
          <tbody>
            {parts.map((p) => {
              const kind = p.link.kind === "roster" ? "自軍" : p.link.was ? "集計外（元自軍）" : "助っ人";
              return (
                <tr key={p.id}>
                  <td className="tl">{nameOf(p.id)}</td>
                  <td className="muted">{kind}</td>
                  <td>出席</td>
                  <td className="tl">
                    <GuardedActionForm action={participantAction} style={{ display: "inline-flex", gap: "0.4rem" }}>
                      <input type="hidden" name="pid" value={p.id} />
                      <button className="db-act" name="act" value="remove" disabled={hasDraft} title="成績の参照が無い場合のみ削除できます">削除</button>
                    </GuardedActionForm>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <GuardedActionForm action={participantAction} className="adminform" style={{ marginTop: "0.5rem" }}>
        <label>助っ人を追加<input name="guest_name" placeholder="名前" /></label>
        <button name="act" value="add-guest" disabled={hasDraft}>追加（出場）</button>
      </GuardedActionForm>

      <h2>危険な操作</h2>
      <p className="muted">試合の完全削除。版履歴・未確定の集計結果・入力ノートもすべて消え、元に戻せません。</p>
      <DeleteGameButton gameId={id} date={g.date} opponent={g.opponent} />
    </div>
  );
}
