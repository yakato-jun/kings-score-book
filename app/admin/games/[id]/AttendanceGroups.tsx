"use client";
import { useMemo, useState } from "react";
import { useUnsavedGuard } from "@/components/useUnsavedGuard";

/**
 * 出欠を「出席グループ／欠席グループ」の2列で管理し、名前クリックで移動する。
 * 出席=この試合に参加(participants在籍)で一本化(played/benchの区別は廃止)。
 * 保存時は出席者を att-<player_id>=1 の在籍マーカーで送る(欠席=送らない=setAttendanceが外す)。
 *
 * 未保存ガード: 現在の出席集合が初期値と異なる間は dirty。useUnsavedGuard で
 * ブラウザ離脱を警告し、共有レジストリ経由でタブ切替・参加者操作にも破棄確認を効かせる。
 * 「出欠を保存」提出後は saved=true で dirty を解消する(提出→再描画で自然にも解ける)。
 */
// [§12] 助っ人＝種別 "guest"、正選手＝それ以外(既存 member/空 も正選手扱い＝値を狭めない)。players一覧と同じ判定。
const isGuest = (t?: string) => (t ?? "").trim() === "guest";

export function AttendanceGroups({
  players,
  presentIds,
  action,
  disabled,
}: {
  players: { id: string; name: string; type?: string }[];
  presentIds: string[];
  action: (formData: FormData) => Promise<void>;
  disabled: boolean;
}) {
  const [present, setPresent] = useState<Set<string>>(() => new Set(presentIds));
  const [saved, setSaved] = useState(false);
  // 助っ人は既定非表示(players一覧の ?guests=1 と同じ思想＝出欠の主役は正選手)。トグルON時のみ列挙する。
  const [showGuests, setShowGuests] = useState(false);
  const initial = useMemo(() => new Set(presentIds), [presentIds]);
  const dirty =
    !saved && (present.size !== initial.size || [...present].some((id) => !initial.has(id)));
  useUnsavedGuard(dirty);
  const move = (id: string, toPresent: boolean) => {
    setSaved(false); // 移動したら再び未保存
    setPresent((s) => {
      const n = new Set(s);
      if (toPresent) n.add(id);
      else n.delete(id);
      return n;
    });
  };
  // 出席側は常に全員表示(隠すと選択済みの解除も確認もできず、保存マーカーの見た目も欠ける)。
  const presentList = players.filter((p) => present.has(p.id));
  // 欠席側の助っ人はトグルOFFなら隠す。ただし初期出席だった助っ人(=この画面で外した直後)は
  // 見せ続ける＝外した操作が画面から消えて取り消せなくなるのを防ぐ。
  const absentList = players.filter(
    (p) => !present.has(p.id) && (showGuests || !isGuest(p.type) || initial.has(p.id))
  );
  return (
    <form action={action} onSubmit={() => setSaved(true)}>
      {presentList.map((p) => (
        <input key={p.id} type="hidden" name={`att-${p.id}`} value="1" />
      ))}
      <p className="muted" style={{ margin: "0 0 0.5rem" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", cursor: "pointer" }}>
          <input type="checkbox" checked={showGuests} onChange={(e) => setShowGuests(e.target.checked)} />
          助っ人を表示
        </label>
      </p>
      <div className="attcols">
        <div className="attcol">
          <h3>出席 <span className="muted">{presentList.length}人</span></h3>
          <p className="attcolhint muted">クリックで欠席へ →</p>
          <div className="attpills">
            {presentList.map((p) => (
              <button type="button" key={p.id} className="attpill present" onClick={() => move(p.id, false)} disabled={disabled} title="クリックで欠席へ">
                {p.name}
              </button>
            ))}
            {presentList.length === 0 && <span className="muted">（なし）</span>}
          </div>
        </div>
        <div className="attcol">
          <h3>欠席 <span className="muted">{absentList.length}人</span></h3>
          <p className="attcolhint muted">← クリックで出席へ</p>
          <div className="attpills">
            {absentList.map((p) => (
              <button type="button" key={p.id} className="attpill absent" onClick={() => move(p.id, true)} disabled={disabled} title="クリックで出席へ">
                {p.name}
              </button>
            ))}
            {absentList.length === 0 && <span className="muted">（なし）</span>}
          </div>
        </div>
      </div>
      <div style={{ marginTop: "0.7rem" }}>
        <button disabled={disabled}>出欠を保存</button>
      </div>
    </form>
  );
}
