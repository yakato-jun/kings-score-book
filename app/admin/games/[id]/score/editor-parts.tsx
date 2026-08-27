"use client";
/**
 * [§10 Phase D] 試合データエディタのサブコンポーネント群。
 * スキーマの事実フィールドを1対1で画面に出す(見え・直せる)。導出値(runs/盤面/投捕)は表示のみ。
 * 書き込みは全て親から渡る post(op) 経由＝/api/score/op(draft) を通る。承認だけ既存 /api/games/resolve を使う。
 */
import { useState } from "react";
import { useDialog } from "@/components/DialogProvider";
import type { PARowView, LineupSlotView, PitcherRowView, DirectStatRowView } from "@/lib/ops/score-view";
import { RESULT_CHOICES, pitchingRowsToRecords, seedPitcherRows, pitcherSetKey } from "@/lib/ops/score-view";
import type { Half, FieldingOut, FieldingError, DirectBatting, DirectPitching, DirectFielding } from "@/lib/types/v2";

export type Person = { id: string; name: string; kind?: string };
export type PostFn = (op: Record<string, unknown>, onOk?: () => void) => void;

export const POS: [string, string][] = [
  ["1", "投"], ["2", "捕"], ["3", "一"], ["4", "二"], ["5", "三"], ["6", "遊"], ["7", "左"], ["8", "中"], ["9", "右"], ["DH", "DH"],
];
const HALF_JP = (h: Half) => (h === "top" ? "表" : "裏");
const HIT_TO: [string, string][] = [["", "—"], ...POS.filter(([v]) => v !== "DH")];
const HIT_TYPE: [string, string][] = [["", "—"], ["G", "ゴロ"], ["F", "フライ"], ["L", "ライナー"]];
const OUT_AT: [string, string][] = [["1", "一塁"], ["2", "二塁"], ["3", "三塁"], ["home", "本塁"], ["K", "三振"], ["-", "—"]];
const OUT_TYPE: [string, string][] = [["force", "封殺"], ["tag", "タッチ"], ["catch", "捕球"]];
const ERR_TYPE: [string, string][] = [["fielding", "捕球"], ["throwing", "送球"], ["drop", "落球"]];
const MOVE_FROM: [string, string][] = [["", "（不明）"], ["1", "一塁"], ["2", "二塁"], ["3", "三塁"]];
const MOVE_TO: [string, string][] = [["1", "一塁へ"], ["2", "二塁へ"], ["3", "三塁へ"], ["home", "生還"], ["out", "アウト"]];
const DURING_EVENT: [string, string][] = [["SB", "盗塁"], ["CS", "盗塁死"], ["WP", "暴投"], ["PB", "捕逸"], ["PO", "牽制"], ["BK", "ボーク"]];
const DECISION: [string, string][] = [["", "なし"], ["W", "勝"], ["L", "敗"], ["S", "S"]];

/**
 * [§9 二軸・身元非追跡] 相手攻撃halfの攻撃側スロット(打者/走者/代走)候補。
 * 相手は個人を作らない＝打順位置プレースホルダ(oN)のみを候補にする(表示は docNameResolver と同じ「相手N番」)。
 * 候補数は動的: max(12, その試合の最大既出番号+3)。全員打ちで12人超の相手でもハード上限を持たない
 * (打順は順に入力されるので+3の余裕で常に足りる)。
 */
export const oppPlaceholders = (maxSeenSlot = 0): Person[] =>
  Array.from({ length: Math.max(12, maxSeenSlot + 3) }, (_, i) => ({ id: `o${i + 1}`, name: `相手${i + 1}番` }));

/** 相手プレースホルダ(oN)→「相手N番」。それ以外は素通し(候補外の現値を表示する最終フォールバック)。 */
const oppSlotName = (id: string) => {
  const m = id.match(/^o(\d+)$/);
  return m ? `相手${m[1]}番` : id;
};

/** 打者/走者/投手の候補セレクト(参加者＋未参加マスタ)。空=（自動/未指定）。 */
export function PersonSelect({ value, onChange, participants, masters, autoLabel = "（自動）" }: {
  value: string; onChange: (v: string) => void; participants: Person[]; masters: Person[]; autoLabel?: string;
}) {
  // 保存済みの現値が候補に無い場合(相手13番以降・先攻後攻の変更で側が入れ替わった後など)も
  // 選択表示が壊れないよう現値を先頭に含める＝黙って別人に化けさせない。
  const known = value !== "" && (participants.some((p) => p.id === value) || masters.some((p) => p.id === value));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{autoLabel}</option>
      {value !== "" && !known && <option value={value}>{oppSlotName(value)}</option>}
      {participants.length > 0 && (
        <optgroup label="この試合の参加者">
          {participants.map((p) => <option key={p.id} value={p.id}>{p.name}{p.kind === "guest" ? "（助）" : ""}</option>)}
        </optgroup>
      )}
      {masters.length > 0 && (
        <optgroup label="未参加の選手（選ぶと参加者に）">
          {masters.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </optgroup>
      )}
    </select>
  );
}

function Sel({ value, onChange, opts, width }: { value: string; onChange: (v: string) => void; opts: [string, string][]; width?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={width ? { width } : undefined}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

const parseSeq = (s: string): string[] => s.split(/[,\s、]+/).map((x) => x.trim()).filter(Boolean);

// ─── 守備アウト/失策の編集(打席fielding・走塁イベントの両方で共用) ───
function OutsEditor({ outs, setOuts, participants, masters }: {
  outs: FieldingOut[]; setOuts: (f: (o: FieldingOut[]) => FieldingOut[]) => void; participants: Person[]; masters: Person[];
}) {
  return (
    <div className="sc-sub">
      <div className="sc-subhd">アウト<button className="db-act" onClick={() => setOuts((o) => [...o, { at: "1", type: "force", runner_id: null }])}>＋</button></div>
      {outs.map((o, i) => (
        <div key={i} className="sc-row">
          <Sel value={o.at} onChange={(v) => setOuts((os) => os.map((x, j) => (j === i ? { ...x, at: v } : x)))} opts={OUT_AT} />
          <Sel value={o.type} onChange={(v) => setOuts((os) => os.map((x, j) => (j === i ? { ...x, type: v as FieldingOut["type"] } : x)))} opts={OUT_TYPE} />
          <span className="muted">対象</span>
          <PersonSelect value={o.runner_id ?? ""} onChange={(v) => setOuts((os) => os.map((x, j) => (j === i ? { ...x, runner_id: v || null } : x)))} participants={participants} masters={masters} autoLabel="（自動）" />
          <button className="db-act" onClick={() => setOuts((os) => os.filter((_, j) => j !== i))}>削除</button>
        </div>
      ))}
    </div>
  );
}
function ErrorsEditor({ errors, setErrors }: { errors: FieldingError[]; setErrors: (f: (e: FieldingError[]) => FieldingError[]) => void }) {
  return (
    <div className="sc-sub">
      <div className="sc-subhd">失策<button className="db-act" onClick={() => setErrors((e) => [...e, { pos: "1", type: "fielding" }])}>＋</button></div>
      {errors.map((e, i) => (
        <div key={i} className="sc-row">
          <Sel value={e.pos} onChange={(v) => setErrors((es) => es.map((x, j) => (j === i ? { ...x, pos: v } : x)))} opts={POS.filter(([p]) => p !== "DH")} />
          <Sel value={e.type} onChange={(v) => setErrors((es) => es.map((x, j) => (j === i ? { ...x, type: v } : x)))} opts={ERR_TYPE} />
          <button className="db-act" onClick={() => setErrors((es) => es.filter((_, j) => j !== i))}>削除</button>
        </div>
      ))}
    </div>
  );
}

type Move = { runner_id: string; from: string; to: string; reason?: string | null };
function MovesEditor({ label, moves, setMoves, participants, masters }: {
  label: string; moves: Move[]; setMoves: (f: (m: Move[]) => Move[]) => void; participants: Person[]; masters: Person[];
}) {
  return (
    <div className="sc-sub">
      <div className="sc-subhd">{label}<button className="db-act" onClick={() => setMoves((m) => [...m, { runner_id: "", from: "", to: "home" }])}>＋</button></div>
      {moves.map((m, i) => (
        <div key={i} className="sc-row">
          <PersonSelect value={m.runner_id} onChange={(v) => setMoves((ms) => ms.map((x, j) => (j === i ? { ...x, runner_id: v } : x)))} participants={participants} masters={masters} autoLabel="（走者=自動）" />
          <Sel value={m.from} onChange={(v) => setMoves((ms) => ms.map((x, j) => (j === i ? { ...x, from: v } : x)))} opts={MOVE_FROM} />
          <span>→</span>
          <Sel value={m.to} onChange={(v) => setMoves((ms) => ms.map((x, j) => (j === i ? { ...x, to: v } : x)))} opts={MOVE_TO} />
          <button className="db-act" onClick={() => setMoves((ms) => ms.filter((_, j) => j !== i))}>削除</button>
        </div>
      ))}
    </div>
  );
}

type DuringRow = {
  event: string; trigger_base: string; note: string;
  moves: Move[]; showF: boolean; fSeq: string; fOuts: FieldingOut[]; fErrors: FieldingError[];
};

/** ===== D-1 フル打席エディタ ===== */
export function AtBatEditor({ row, participants, masters, post, busy, onClose, gameId, oppMaxSlot }: {
  row: PARowView; participants: Person[]; masters: Person[]; post: PostFn; busy: boolean; onClose: () => void; gameId: string; oppMaxSlot?: number;
}) {
  const { promptText } = useDialog();
  // [§9 二軸] 攻撃側スロット(打者/走者/代走)の候補は「その half の攻撃チーム」から出す。
  //   相手half=相手プレースホルダ(o1..o12)のみ・自軍half=参加者(現状どおり)＝相手halfに自軍名簿を出さず、
  //   自軍halfに相手プレースホルダを出さない(身元非追跡)。守備側スロット(責任投手)は従来どおり自軍名簿。
  const batParts = row.isKingsHalf ? participants : oppPlaceholders(oppMaxSlot ?? 0);
  const batMasters = row.isKingsHalf ? masters : [];
  // [クラスタB3] 既定は空="結果未選択(=不明)"。OUT で始めると未選択が黙って凡退(打数/凡退)に化けるため。
  //   保存時に空→null(結果不明・INCとは別=打席は完了だが結果未記録)へ落とす。既存PAは保存済み結果を初期表示。
  const [result, setResult] = useState<string>(row.result ?? "");
  const [batter, setBatter] = useState(""); // 空=変えない
  const [complete, setComplete] = useState(row.complete);
  const [dts, setDts] = useState(row.dropped_third_strike);
  const [intentional, setIntentional] = useState(row.intentional);
  const [autoOut, setAutoOut] = useState(row.automatic_out);
  const [note, setNote] = useState(row.note ?? "");
  const [dp, setDp] = useState(row.double_play);
  const [tp, setTp] = useState(row.triple_play);
  const [slot, setSlot] = useState<string>(String((row.isKingsHalf ? row.batting_slot : row.opponent_slot) ?? ""));
  // 打球・守備
  const f = row.fielding;
  const [fHitTo, setFHitTo] = useState(f?.hit_to ?? "");
  const [fHitType, setFHitType] = useState(f?.hit_type ?? "");
  const [fSeq, setFSeq] = useState((f?.sequence ?? []).join(","));
  const [fOuts, setFOuts] = useState<FieldingOut[]>(f?.outs ?? []);
  const [fErrors, setFErrors] = useState<FieldingError[]>(f?.errors ?? []);
  // 打席中走塁
  const [during, setDuring] = useState<DuringRow[]>((row.baserunning_during ?? []).map((ev) => ({
    event: ev.event ?? "SB", trigger_base: ev.trigger_base ?? "", note: ev.note ?? "",
    // reason は UI で編集しないが編集保存で消さないよう持ち回る(round-trip 保全)
    moves: (ev.runners ?? []).map((m) => ({ runner_id: m.runner_id ?? "", from: m.from ?? "", to: m.to, reason: m.reason ?? null })),
    showF: !!ev.fielding, fSeq: (ev.fielding?.sequence ?? []).join(","),
    // 元 out をスプレッド= putout_position/assist_positions 等の未編集フィールドを編集で失わない
    fOuts: (ev.fielding?.outs ?? []).map((o) => ({ ...o, type: ((o.type as FieldingOut["type"]) ?? "tag"), runner_id: o.runner_id ?? null })),
    fErrors: ev.fielding?.errors ?? [],
  })));
  // 打席後走塁
  const [after, setAfter] = useState<Move[]>((row.baserunning_after ?? []).map((m) => ({ runner_id: m.runner_id ?? "", from: m.from ?? "", to: m.to, reason: m.reason ?? null })));
  // 代走
  const [prFor, setPrFor] = useState(row.pinch_runner?.for_base ?? "");
  const [prRunner, setPrRunner] = useState(row.pinch_runner?.runner_id ?? "");
  // 責任投手の上書き(得点者が判明している run のみ。走者不明 run は runner_id 空でキー衝突するため除く)
  const namedRuns = row.runs.filter((r) => r.runner_id);
  const [ro, setRo] = useState<Record<string, string>>(Object.fromEntries(namedRuns.map((r) => [r.runner_id, r.responsible_pitcher_id ?? ""])));
  // [§0/§11] 得点(走者不明)＝origin:"manual" の null-run。既存分を初期値に(RunViewでは runner_id="" が null-run)。
  const [unknownRuns, setUnknownRuns] = useState<{ rbi: boolean }[]>(row.runs.filter((r) => !r.runner_id).map((r) => ({ rbi: r.rbi })));

  function buildFielding() {
    const seq = parseSeq(fSeq);
    // 画面に出さない schema フィールド(infield_hit/ground_rule 等)は元値を保持=編集で失わない
    if (!fHitTo && !fHitType && !seq.length && !fOuts.length && !fErrors.length) {
      // 可視項目が全空でも、元 f があれば非モデル項目を保持し可視項目だけ空に。f が無い場合のみ null。
      return f ? { ...f, hit_to: null, hit_type: null, sequence: [], outs: [], errors: [] } : null;
    }
    return { ...(f ?? {}), hit_to: fHitTo || null, hit_type: fHitType || null, sequence: seq, outs: fOuts, errors: fErrors };
  }
  function buildDuring() {
    return during.map((d) => ({
      event: d.event,
      ...(d.trigger_base ? { trigger_base: d.trigger_base } : {}),
      // reason は元 move から保全(スプレッド)。runner_id 空は省略(サーバが from塁で確定)
      runners: d.moves.map((m) => ({ ...m, ...(m.runner_id ? { runner_id: m.runner_id } : { runner_id: undefined }), from: m.from || null, to: m.to })),
      ...(d.showF && (parseSeq(d.fSeq).length || d.fOuts.length || d.fErrors.length)
        // 元 out をスプレッド= putout_position/assist_positions を編集で失わない
        ? { fielding: { sequence: parseSeq(d.fSeq), outs: d.fOuts.map((o) => ({ ...o, at: o.at, type: o.type, runner_id: o.runner_id ?? null })), errors: d.fErrors } }
        : {}),
      ...(d.note.trim() ? { note: d.note.trim() } : {}),
    }));
  }
  function buildAfter() {
    // reason は元 move から保全(スプレッド)
    return after.filter((m) => m.to).map((m) => ({ ...m, ...(m.runner_id ? { runner_id: m.runner_id } : { runner_id: undefined }), from: m.from || null, to: m.to }));
  }
  function buildRunOverrides() {
    return namedRuns.flatMap((r) => {
      const v = ro[r.runner_id] ?? "";
      const init = r.responsible_pitcher_id ?? "";
      if (v === init) return [];
      return [{ runner_id: r.runner_id, responsible_pitcher_id: v || null }];
    });
  }

  function save() {
    const op: Record<string, unknown> = { type: "editPlateAppearance", inning: row.inning, half: row.half, order: row.order };
    if (row.paId) op.pa_id = row.paId;
    op.result = result || null; // [クラスタB3] 未選択(空)は null=結果不明で保存(OUTに化けさせない)
    // 打者差し替えは自軍halfのみ(判定は isKingsHalf=kingsBatHalf と half の比較)。相手halfの打者は
    // 「相手打順」(opponent_slot)が正本で、サーバが batter_id(oN) を追従させる＝別経路で不整合を作らない。
    if (row.isKingsHalf && batter) op.batter_id = batter;
    op.complete = complete;
    op.dropped_third_strike = dts;
    op.intentional = intentional;
    op.automatic_out = autoOut;
    op.note = note.trim() || null;
    op.double_play = dp;
    op.triple_play = tp;
    if (slot.trim()) { if (row.isKingsHalf) op.batting_slot = Number(slot); else op.opponent_slot = Number(slot); }
    op.fielding = buildFielding();
    op.baserunning_during = buildDuring();
    op.baserunning_after = buildAfter();
    // 代走: 元 pinch_runner をスプレッドして replaced_id/note 等の未編集フィールドを保全。代走者が空=代走を消す明示意図で null。
    op.pinch_runner = prRunner
      ? { ...(row.pinch_runner ?? {}), type: "pinch", runner_id: prRunner, for_base: (prFor || null) as "1" | "2" | "3" | null }
      : null;
    const ros = buildRunOverrides();
    if (ros.length) op.run_overrides = ros;
    // [§0/§11] 得点(走者不明)＝origin:"manual" の null-run を全置換で送る(空配列=この打席の走者不明runを消す明示)。
    op.manual_runs = unknownRuns.map((m) => ({ runner_id: null, rbi: m.rbi }));
    // 注記(annotations)は送らない＝要確認を黙って消さない(§10.3 実バグ②)。承認/手動注記は専用操作。
    post(op, onClose);
  }

  async function approve(rule: string | null) {
    const reason = await promptText({ title: "要確認を承認", body: "直さず意図どおりと認めます。理由（空欄可）:", defaultValue: "特別ルールで問題なし", confirmLabel: "承認" });
    if (reason === null) return;
    const res = await fetch("/api/games/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gameId, inning: row.inning, half: row.half, order: row.order, reason, rule }) }).then((x) => x.json());
    if (!res.error) location.reload();
  }
  async function addManualNote() {
    const detail = await promptText({ title: "採点根拠メモを追加", body: "この打席の採点根拠(記録員メモ)。表示スコアには出ません。", confirmLabel: "追加" });
    if (!detail || !detail.trim()) return;
    // 既存の注記(要確認/承認/他)を保持したまま手動注記を追記(全置換で失わない)
    const op: Record<string, unknown> = { type: "editPlateAppearance", inning: row.inning, half: row.half, order: row.order, annotations: [...row.annotationsRaw, { type: "manual", detail: detail.trim(), source: "manual" }] };
    if (row.paId) op.pa_id = row.paId;
    post(op);
  }

  return (
    <div className="sc-edit">
      {/* 導出プレビュー(編集不可) */}
      <div className="sc-prev">
        開始時: {row.startOuts}アウト・走者 {row.startRunners.length ? row.startRunners.map((r) => `${r.baseJp}塁=${r.name}`).join(" / ") : "なし"}
        {row.runs.length > 0 && <>　／　得点: {row.runs.map((r) => `${r.name}${r.rbi ? "(打点)" : ""}`).join(", ")}</>}
      </div>

      {/* 基本 */}
      <div className="sc-row">
        <span className="muted">結果:</span>
        {RESULT_CHOICES.map(([code, label]) => (
          <button key={code} className={`sc-rbtn ${result === code ? "on" : ""}`} onClick={() => setResult(code)}>{label}</button>
        ))}
      </div>
      <div className="sc-row">
        {/* 打者セレクトは自軍halfのみ(相手halfの打者=「相手打順」入力が正本)。相手halfに自軍名簿を出さない */}
        {row.isKingsHalf && <label>打者 <PersonSelect value={batter} onChange={setBatter} participants={participants} masters={masters} autoLabel="（変えない）" /></label>}
        <label>{row.isKingsHalf ? "打順" : "相手打順"} <input type="number" min={1} value={slot} onChange={(e) => setSlot(e.target.value)} style={{ width: "3.5em" }} /></label>
        <label className="chk"><input type="checkbox" checked={!complete} onChange={(e) => setComplete(!e.target.checked)} />未完了</label>
        <label className="chk"><input type="checkbox" checked={dts} onChange={(e) => setDts(e.target.checked)} />振り逃げ</label>
        <label className="chk"><input type="checkbox" checked={intentional} onChange={(e) => setIntentional(e.target.checked)} />申告敬遠</label>
        <label className="chk"><input type="checkbox" checked={autoOut} onChange={(e) => setAutoOut(e.target.checked)} />自動アウト</label>
        <label className="chk"><input type="checkbox" checked={dp} onChange={(e) => setDp(e.target.checked)} />併殺</label>
        <label className="chk"><input type="checkbox" checked={tp} onChange={(e) => setTp(e.target.checked)} />三重殺</label>
      </div>
      <div className="sc-row">
        <label style={{ flex: 1 }}>実況 <input className="notearea" style={{ minHeight: 0, height: "2.2em", width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="(任意)" /></label>
      </div>

      {/* 打球・守備 */}
      <fieldset className="sc-fs">
        <legend>打球・守備</legend>
        <div className="sc-row">
          <label>方向 <Sel value={fHitTo} onChange={setFHitTo} opts={HIT_TO} /></label>
          <label>種別 <Sel value={fHitType} onChange={setFHitType} opts={HIT_TYPE} /></label>
          <label>送球順 <input value={fSeq} onChange={(e) => setFSeq(e.target.value)} placeholder="例 6,4,3" style={{ width: "7em" }} /></label>
        </div>
        <OutsEditor outs={fOuts} setOuts={setFOuts} participants={batParts} masters={batMasters} />
        <ErrorsEditor errors={fErrors} setErrors={setFErrors} />
      </fieldset>

      {/* 打席中走塁 */}
      <fieldset className="sc-fs">
        <legend>打席中の走塁（盗塁/暴投/牽制…）<button className="db-act" onClick={() => setDuring((d) => [...d, { event: "SB", trigger_base: "", note: "", moves: [], showF: false, fSeq: "", fOuts: [], fErrors: [] }])}>＋イベント</button></legend>
        {during.map((d, i) => (
          <div key={i} className="sc-evt">
            <div className="sc-row">
              <Sel value={d.event} onChange={(v) => setDuring((ds) => ds.map((x, j) => (j === i ? { ...x, event: v } : x)))} opts={DURING_EVENT} />
              <button className="db-act" onClick={() => setDuring((ds) => ds.map((x, j) => (j === i ? { ...x, moves: [...x.moves, { runner_id: "", from: "", to: "2" }] } : x)))}>＋走者移動</button>
              <label className="chk"><input type="checkbox" checked={d.showF} onChange={(e) => setDuring((ds) => ds.map((x, j) => (j === i ? { ...x, showF: e.target.checked } : x)))} />守備(送球/アウト/失策)</label>
              <button className="db-act" onClick={() => setDuring((ds) => ds.filter((_, j) => j !== i))}>イベント削除</button>
            </div>
            <MovesEditor label="走者移動" moves={d.moves} setMoves={(fn) => setDuring((ds) => ds.map((x, j) => (j === i ? { ...x, moves: fn(x.moves) } : x)))} participants={batParts} masters={batMasters} />
            {d.showF && (
              <div className="sc-subF">
                <label>送球順 <input value={d.fSeq} onChange={(e) => setDuring((ds) => ds.map((x, j) => (j === i ? { ...x, fSeq: e.target.value } : x)))} placeholder="例 2,6" style={{ width: "6em" }} /></label>
                <OutsEditor outs={d.fOuts} setOuts={(fn) => setDuring((ds) => ds.map((x, j) => (j === i ? { ...x, fOuts: fn(x.fOuts) } : x)))} participants={batParts} masters={batMasters} />
                <ErrorsEditor errors={d.fErrors} setErrors={(fn) => setDuring((ds) => ds.map((x, j) => (j === i ? { ...x, fErrors: fn(x.fErrors) } : x)))} />
              </div>
            )}
          </div>
        ))}
      </fieldset>

      {/* 打席後走塁 */}
      <fieldset className="sc-fs">
        <legend>打席後の走塁（追加進塁）</legend>
        <MovesEditor label="走者移動" moves={after} setMoves={setAfter} participants={batParts} masters={batMasters} />
      </fieldset>

      {/* 代走 */}
      <fieldset className="sc-fs">
        <legend>代走</legend>
        <div className="sc-row">
          <label>対象塁 <Sel value={prFor} onChange={setPrFor} opts={[["", "—"], ["1", "一塁"], ["2", "二塁"], ["3", "三塁"]]} /></label>
          {/* 代走も攻撃側スロット＝halfの攻撃チームから(相手half=プレースホルダ) */}
          <label>代走者 <PersonSelect value={prRunner} onChange={setPrRunner} participants={batParts} masters={batMasters} autoLabel="（なし）" /></label>
        </div>
      </fieldset>

      {/* 得点（走者不明）＝ §0-C: 得点は入ったが誰が還ったか不明。チーム得点/投手失点だけ計上し選手別Rは動かさない */}
      <fieldset className="sc-fs">
        <legend>得点（走者不明）
          <button className="db-act" onClick={() => setUnknownRuns((u) => [...u, { rbi: true }])}>＋得点(走者不明)</button>
        </legend>
        {unknownRuns.length === 0 && <p className="muted">この打席に「誰が還ったか不明な得点」があれば追加します（チーム得点・投手失点だけ計上）。</p>}
        {unknownRuns.map((u, i) => (
          <div key={i} className="sc-row">
            <span className="muted">走者不明の得点 {i + 1}</span>
            <label className="chk"><input type="checkbox" checked={u.rbi} onChange={(e) => setUnknownRuns((us) => us.map((x, j) => (j === i ? { ...x, rbi: e.target.checked } : x)))} />打点を打者に付ける</label>
            <button className="db-act" onClick={() => setUnknownRuns((us) => us.filter((_, j) => j !== i))}>削除</button>
          </div>
        ))}
      </fieldset>

      {/* 責任投手の上書き(得点者が判明している得点のみ) */}
      {namedRuns.length > 0 && (
        <fieldset className="sc-fs">
          <legend>責任投手（継投跨ぎの帰属修正）</legend>
          {namedRuns.map((r) => (
            <div key={r.runner_id} className="sc-row">
              <span className="muted">{r.name} 生還{r.rbi ? "(打点)" : ""}</span>
              <PersonSelect value={ro[r.runner_id] ?? ""} onChange={(v) => setRo((m) => ({ ...m, [r.runner_id]: v }))} participants={participants} masters={masters} autoLabel="（自動＝導出）" />
            </div>
          ))}
          <p className="muted">※ 自責点は投手記録セクションが正本（ここでは編集不可）。</p>
        </fieldset>
      )}

      {/* 注記パネル */}
      <fieldset className="sc-fs">
        <legend>注記・要確認</legend>
        {row.unresolved.length === 0 && row.manualNotes.length === 0 && <p className="muted">要確認・メモはありません。</p>}
        {row.unresolved.map((a, i) => (
          <div key={i} className="sc-row">
            <span className="loss">⚠ {a.detail}{a.rule ? `（${a.rule}）` : ""}</span>
            <button className="db-act" disabled={busy} onClick={() => approve(a.rule)}>承認</button>
          </div>
        ))}
        {row.manualNotes.map((a, i) => <p key={i} className="muted">補記: {a.detail}</p>)}
        <button className="db-act" disabled={busy} onClick={addManualNote}>採点根拠メモを追加</button>
        <p className="muted">※ validator由来の要確認は再検査で再生成されます（承認すると再検査でスキップ）。</p>
      </fieldset>

      <div className="sc-row">
        <button disabled={busy} onClick={save}>保存</button>
        <button className="db-act" onClick={onClose}>キャンセル</button>
        <span className="muted">※ 得点/打点/盤面/投捕はエンジンが再導出（後続打席も自動で直る）</span>
      </div>
    </div>
  );
}

/** 半イニング先頭/打席間の「ここに挿入」インライン簡易フォーム。詳細は挿入後に打席編集で。 */
function InsertForm({ inning, half, isKingsHalf, afterPaId, participants, masters, post, busy, onClose }: {
  inning: number; half: Half; isKingsHalf: boolean; afterPaId: string | null; participants: Person[]; masters: Person[]; post: PostFn; busy: boolean; onClose: () => void;
}) {
  const [result, setResult] = useState(""); // [クラスタB3] 既定は未選択(=結果不明)。OUTで始めない
  const [batter, setBatter] = useState("");
  const [oppSlot, setOppSlot] = useState("");
  const [note, setNote] = useState("");
  function submit() {
    const op: Record<string, unknown> = { type: "insertPlateAppearance", inning, half, after_pa_id: afterPaId, result: result || null };
    if (isKingsHalf) { if (batter) op.batter_id = batter; }
    else if (oppSlot.trim()) op.opponent_slot = Number(oppSlot);
    if (note.trim()) op.note = note.trim();
    post(op, onClose);
  }
  return (
    <div className="sc-edit">
      <div className="sc-row">
        <span className="muted">結果:</span>
        {RESULT_CHOICES.map(([code, label]) => <button key={code} className={`sc-rbtn ${result === code ? "on" : ""}`} onClick={() => setResult(code)}>{label}</button>)}
      </div>
      <div className="sc-row">
        {isKingsHalf
          ? <label>打者 <PersonSelect value={batter} onChange={setBatter} participants={participants} masters={masters} autoLabel="（打順で自動）" /></label>
          : <label>相手打順 <input type="number" min={1} max={9} value={oppSlot} onChange={(e) => setOppSlot(e.target.value)} style={{ width: "3.5em" }} placeholder="自動" /></label>}
        <label style={{ flex: 1 }}>実況 <input className="notearea" style={{ minHeight: 0, height: "2.2em", width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <div className="sc-row">
        <button disabled={busy} onClick={submit}>ここに挿入</button>
        <button className="db-act" onClick={onClose}>やめる</button>
        <span className="muted">※ 挿入後、詳細（守備/走塁）は打席の「編集」で。</span>
      </div>
    </div>
  );
}

/** ===== D-1 打席リスト(半イニング区切り＋挿入導線＋フル打席エディタ) ===== */
export function AtBatList({ rows, participants, masters, post, busy, gameId }: {
  rows: PARowView[]; participants: Person[]; masters: Person[]; post: PostFn; busy: boolean; gameId: string;
}) {
  const { confirm } = useDialog();
  const [openId, setOpenId] = useState<string | null>(null); // 編集中の打席(paId or 合成キー)
  const [insertAt, setInsertAt] = useState<string | null>(null); // 挿入フォームのキー

  const keyOf = (r: PARowView) => r.paId ?? `${r.inning}-${r.half}-${r.order}`;
  // 相手打順候補の動的レンジ用: この試合で既出の最大相手番号(走者候補は打者と別打席の番号を参照し得るため全打席から)
  const oppMaxSlot = rows.reduce((m, r) => Math.max(m, r.opponent_slot ?? 0), 0);
  // 半イニングでグループ化(時系列)
  const groups: { inning: number; half: Half; isKingsHalf: boolean; items: PARowView[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.inning === r.inning && last.half === r.half) last.items.push(r);
    else groups.push({ inning: r.inning, half: r.half, isKingsHalf: r.isKingsHalf, items: [r] });
  }

  const insertBtn = (gkey: string, inning: number, half: Half, isKingsHalf: boolean, afterPaId: string | null, disabled: boolean) => (
    <div className="sc-ins">
      <button className="db-act" disabled={busy || disabled} title={disabled ? "先に打席を保存してください(不変ID採番後に挿入可)" : undefined}
        onClick={() => setInsertAt(insertAt === gkey ? null : gkey)}>{insertAt === gkey ? "✕ 挿入をやめる" : "＋ ここに挿入"}</button>
      {insertAt === gkey && (
        <InsertForm inning={inning} half={half} isKingsHalf={isKingsHalf} afterPaId={afterPaId} participants={participants} masters={masters} post={post} busy={busy} onClose={() => setInsertAt(null)} />
      )}
    </div>
  );

  return (
    <ul className="sc-log">
      {groups.map((g, gi) => (
        <li key={gi} className="sc-group">
          <div className="sc-ghd">{g.inning}回{HALF_JP(g.half)}（{g.isKingsHalf ? "キングス攻撃" : "相手攻撃"}）</div>
          {insertBtn(`ins-${gi}-head`, g.inning, g.half, g.isKingsHalf, null, false)}
          {g.items.map((r) => {
            const k = keyOf(r);
            return (
              <div key={k} className="sc-logrow">
                <div className="sc-logline">
                  <span className="muted">#{r.order}</span> {r.batterName} <b>{r.resultLabel}</b>
                  {r.note ? `（${r.note}）` : ""}{r.unresolved.length ? " ⚠" : ""}
                  <button className="db-act" disabled={busy} onClick={() => setOpenId(openId === k ? null : k)}>{openId === k ? "閉じる" : "編集"}</button>
                  <button className="db-act" disabled={busy} onClick={async () => {
                    if (await confirm({ title: "打席を削除", body: `${r.inning}回${HALF_JP(r.half)}#${r.order} ${r.batterName} の打席を削除します（後続打席は繰り上がります）。`, confirmLabel: "削除", danger: true })) {
                      const op: Record<string, unknown> = { type: "removePlateAppearance", inning: r.inning, half: r.half, order: r.order, shift_slots: true };
                      if (r.paId) op.pa_id = r.paId;
                      setOpenId(null);
                      post(op);
                    }
                  }}>削除</button>
                </div>
                {openId === k && <AtBatEditor row={r} participants={participants} masters={masters} post={post} busy={busy} onClose={() => setOpenId(null)} gameId={gameId} oppMaxSlot={oppMaxSlot} />}
                {insertBtn(`ins-${gi}-${k}`, g.inning, g.half, g.isKingsHalf, r.paId, r.paId === null)}
              </div>
            );
          })}
        </li>
      ))}
    </ul>
  );
}

/** ===== D-2 スタメン・交代エディタ ===== */
function Timing({ inning, setInning, half, setHalf, before, setBefore }: {
  inning: string; setInning: (v: string) => void; half: Half; setHalf: (v: Half) => void; before: string; setBefore: (v: string) => void;
}) {
  return (
    <>
      <label>回 <input type="number" min={1} value={inning} onChange={(e) => setInning(e.target.value)} style={{ width: "3.2em" }} /></label>
      <Sel value={half} onChange={(v) => setHalf(v as Half)} opts={[["top", "表"], ["bottom", "裏"]]} />
      <label title="その回の何人目の打者の前から有効か(空=既定)">…の前 <input type="number" min={1} value={before} onChange={(e) => setBefore(e.target.value)} style={{ width: "3.2em" }} placeholder="末" /></label>
    </>
  );
}

export function LineupEditor({ currentLineup, participants, masters, post, busy, hasLineup }: {
  currentLineup: LineupSlotView[]; participants: Person[]; masters: Person[]; post: PostFn; busy: boolean; hasLineup: boolean;
}) {
  const [tab, setTab] = useState<"" | "start" | "sub" | "leave" | "order" | "defense">("");
  // スタメン(可変人数・order null許容)
  const [srows, setSRows] = useState(Array.from({ length: 9 }, (_, i) => ({ order: String(i + 1), position: POS[i][0], player: "", guest: "" })));
  function submitStart() {
    const lr = srows.filter((r) => r.player || r.guest.trim()).map((r) => ({
      order: r.order.trim() === "" ? null : Number(r.order),
      position: r.position || null,
      ...(r.player ? { player_id: r.player } : { guest_name: r.guest.trim() }),
    }));
    if (!lr.length) return;
    post({ type: "setStartingLineup", rows: lr }, () => setTab(""));
  }
  // 交代/退場/打順/守備 共通タイミング
  const [ti, setTi] = useState("1"); const [th, setTh] = useState<Half>("top"); const [tb, setTb] = useState("");
  const timing = () => ({ inning: Number(ti), half: th, ...(tb.trim() ? { before_order: Number(tb) } : {}) });
  // 交代
  const [subOut, setSubOut] = useState(""); const [subIn, setSubIn] = useState(""); const [subInGuest, setSubInGuest] = useState(""); const [subPos, setSubPos] = useState(""); const [subReason, setSubReason] = useState("");
  function submitSub() {
    if (!subOut || (!subIn && !subInGuest.trim())) return;
    // in の選手ID空＋助っ人名あり=助っ人の交代出場(op側が guest_name を受理・参加者を自動追加)
    const inSpec = subIn ? { player_id: subIn } : { guest_name: subInGuest.trim() };
    post({ type: "substitutePlayer", out: subOut, in: inSpec, ...(subPos ? { position: subPos } : {}), timing: timing(), ...(subReason.trim() ? { reason: subReason.trim() } : {}) }, () => { setSubOut(""); setSubIn(""); setSubInGuest(""); setSubPos(""); });
  }
  // 退場
  const [leaveOut, setLeaveOut] = useState(""); const [leaveReason, setLeaveReason] = useState("");
  function submitLeave() { if (!leaveOut) return; post({ type: "leaveGame", out: leaveOut, timing: timing(), ...(leaveReason.trim() ? { reason: leaveReason.trim() } : {}) }, () => setLeaveOut("")); }
  // 打順変更
  const [orows, setORows] = useState<{ player: string; order: string }[]>([{ player: "", order: "" }, { player: "", order: "" }]);
  function submitOrder() {
    const rows = orows.filter((r) => r.player).map((r) => ({ player: r.player, order: r.order.trim() === "" ? null : Number(r.order) }));
    if (!rows.length) return;
    post({ type: "changeBattingOrder", rows, timing: timing() }, () => setORows([{ player: "", order: "" }, { player: "", order: "" }]));
  }
  // 守備変更(複数人一括)
  const [drows, setDRows] = useState<{ player: string; to: string }[]>([{ player: "", to: "" }]);
  function submitDefense() {
    const changes = drows.filter((r) => r.player && r.to).map((r) => ({ player_id: r.player, to_position: r.to }));
    if (!changes.length) return;
    post({ type: "changeDefense", changes, inning: Number(ti), half: th, ...(tb.trim() ? { before_order: Number(tb) } : {}) }, () => setDRows([{ player: "", to: "" }]));
  }

  const lineupPeople: Person[] = currentLineup.map((l) => ({ id: l.player_id, name: l.name }));
  const btn = (id: typeof tab, label: string) => <button className={`db-act ${tab === id ? "on" : ""}`} onClick={() => setTab(tab === id ? "" : id)}>{label}</button>;

  return (
    <div>
      {hasLineup && <p className="muted">現在: {currentLineup.map((l) => `${l.order ?? "－"}${l.position_id ? `(${POS.find((p) => p[0] === l.position_id)?.[1] ?? l.position_id})` : ""} ${l.name}`).join(" / ")}</p>}
      <div className="sc-row">
        {btn("start", hasLineup ? "スタメン再登録" : "スタメン登録")}
        {btn("sub", "選手交代")}
        {btn("leave", "退場")}
        {btn("order", "打順変更")}
        {btn("defense", "守備変更")}
      </div>

      {tab === "start" && (
        <div className="sc-sub">
          {srows.map((r, i) => (
            <div key={i} className="sc-row">
              <input value={r.order} onChange={(e) => setSRows((rs) => rs.map((x, j) => (j === i ? { ...x, order: e.target.value } : x)))} placeholder="打順" title="空=打順なし(投手等)" style={{ width: "3em" }} />
              <Sel value={r.position} onChange={(v) => setSRows((rs) => rs.map((x, j) => (j === i ? { ...x, position: v } : x)))} opts={POS} />
              <select value={r.player} onChange={(e) => setSRows((rs) => rs.map((x, j) => (j === i ? { ...x, player: e.target.value } : x)))}>
                <option value="">{r.guest.trim() ? "（助っ人名）" : "（選手）"}</option>
                {participants.map((p) => <option key={p.id} value={p.id}>{p.name}{p.kind === "guest" ? "（助）" : ""}</option>)}
                {masters.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input placeholder="または助っ人名" value={r.guest} onChange={(e) => setSRows((rs) => rs.map((x, j) => (j === i ? { ...x, guest: e.target.value } : x)))} style={{ width: "8em" }} />
              <button className="db-act" onClick={() => setSRows((rs) => rs.filter((_, j) => j !== i))}>削除</button>
            </div>
          ))}
          <div className="sc-row">
            <button className="db-act" onClick={() => setSRows((rs) => [...rs, { order: String(rs.length + 1), position: "", player: "", guest: "" }])}>＋行追加</button>
            <button disabled={busy} onClick={submitStart}>スタメンを登録</button>
            <span className="muted">※ 打順は空欄可(打順なし投手)。9〜11人でも可。</span>
          </div>
        </div>
      )}

      {(tab === "sub" || tab === "leave" || tab === "order" || tab === "defense") && (
        <div className="sc-sub">
          <div className="sc-row"><span className="muted">タイミング:</span><Timing inning={ti} setInning={setTi} half={th} setHalf={setTh} before={tb} setBefore={setTb} /></div>

          {tab === "sub" && (
            <div className="sc-row">
              <label>退く <PersonSelect value={subOut} onChange={setSubOut} participants={lineupPeople} masters={[]} autoLabel="（選手）" /></label>
              <label>入る <PersonSelect value={subIn} onChange={setSubIn} participants={participants} masters={masters} autoLabel="（選手/助っ人）" /></label>
              <input placeholder="または助っ人名" value={subInGuest} onChange={(e) => setSubInGuest(e.target.value)} style={{ width: "8em" }} />
              <label>守備 <Sel value={subPos} onChange={setSubPos} opts={[["", "（引継ぎ）"], ...POS]} /></label>
              <input placeholder="理由(任意)" value={subReason} onChange={(e) => setSubReason(e.target.value)} style={{ width: "8em" }} />
              <button disabled={busy} onClick={submitSub}>交代を反映</button>
            </div>
          )}
          {tab === "leave" && (
            <div className="sc-row">
              <label>退場 <PersonSelect value={leaveOut} onChange={setLeaveOut} participants={lineupPeople} masters={[]} autoLabel="（選手）" /></label>
              <input placeholder="理由(任意)" value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} style={{ width: "8em" }} />
              <button disabled={busy} onClick={submitLeave}>退場を反映</button>
            </div>
          )}
          {tab === "order" && (
            <>
              {orows.map((r, i) => (
                <div key={i} className="sc-row">
                  <PersonSelect value={r.player} onChange={(v) => setORows((rs) => rs.map((x, j) => (j === i ? { ...x, player: v } : x)))} participants={lineupPeople} masters={[]} autoLabel="（選手）" />
                  <label>→ 打順 <input type="number" min={1} value={r.order} onChange={(e) => setORows((rs) => rs.map((x, j) => (j === i ? { ...x, order: e.target.value } : x)))} style={{ width: "3.2em" }} placeholder="空=外" /></label>
                  <button className="db-act" onClick={() => setORows((rs) => rs.filter((_, j) => j !== i))}>削除</button>
                </div>
              ))}
              <div className="sc-row"><button className="db-act" onClick={() => setORows((rs) => [...rs, { player: "", order: "" }])}>＋行</button><button disabled={busy} onClick={submitOrder}>打順変更を反映</button><span className="muted">※ 5番6番の交換は2行で。</span></div>
            </>
          )}
          {tab === "defense" && (
            <>
              {drows.map((r, i) => (
                <div key={i} className="sc-row">
                  <PersonSelect value={r.player} onChange={(v) => setDRows((rs) => rs.map((x, j) => (j === i ? { ...x, player: v } : x)))} participants={lineupPeople} masters={[]} autoLabel="（選手）" />
                  <span>→</span>
                  <Sel value={r.to} onChange={(v) => setDRows((rs) => rs.map((x, j) => (j === i ? { ...x, to: v } : x)))} opts={[["", "（新守備）"], ...POS]} />
                  <button className="db-act" onClick={() => setDRows((rs) => rs.filter((_, j) => j !== i))}>削除</button>
                </div>
              ))}
              <div className="sc-row"><button className="db-act" onClick={() => setDRows((rs) => [...rs, { player: "", to: "" }])}>＋行</button><button disabled={busy} onClick={submitDefense}>守備変更を反映</button><span className="muted">※ 複数人一括で。</span></div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** ===== D-3 投手記録セクション ===== */
export function PitchingRecords({ pitchers, post, busy }: { pitchers: PitcherRowView[]; post: PostFn; busy: boolean }) {
  const [rows, setRows] = useState(() => seedPitcherRows(pitchers));
  // 投手集合(player_id)が変わったら rows を再シード。失点入力で投手が後から検出されても props(pitchers) に追従する
  //   (旧実装は初回マウント固定で、投手0人でマウント後に検出されても行が出ず要フルリロードだった)。
  //   集合が同一なら再シードしない＝編集中の自責/判定入力を無関係な再描画(busy トグル等)で失わない。
  //   React 公式の「prop 変化で state をリセット」idiom(描画中の setState・useEffect のちらつき無し)。
  const key = pitcherSetKey(pitchers);
  const [seededKey, setSeededKey] = useState(key);
  if (seededKey !== key) { setSeededKey(key); setRows(seedPitcherRows(pitchers)); }
  function save() {
    // [クラスタA A3 / minor①] 自責の空欄=不明→0埋めしない。判定だけ付けた投手は earned_runs:null(不明)で残す＝
    //   勝ち投手を落とさない(無警告消失を防ぐ)。er:0 を捏造せず全置換の巻き添えで他投手も壊さない。純関数は score-view で単体検証。
    post({ type: "setPitchingRecords", records: pitchingRowsToRecords(rows) });
  }
  if (!pitchers.length) return <p className="muted">登板投手が検出されていません（相手打席・守備位置1の投手から自動抽出）。スタメン/守備を登録してください。</p>;
  return (
    <div>
      {rows.map((r, i) => (
        <div key={r.player_id} className="sc-row">
          <span style={{ minWidth: "7em" }}>{r.name}</span>
          <label>自責 <input type="number" min={0} value={r.er} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, er: e.target.value } : x)))} style={{ width: "3.5em" }} placeholder="—" /></label>
          <label>判定 <Sel value={r.decision} onChange={(v) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, decision: v } : x)))} opts={DECISION} /></label>
        </div>
      ))}
      <div className="sc-row"><button disabled={busy} onClick={save}>投手記録を保存</button><span className="muted">※ 自責点の正本はここ。空欄＝不明（0にはしない・防御率は「—」表示）。判定だけ付けて自責空欄でも保存可＝勝敗Sは保持されます。</span></div>
    </div>
  );
}

/** ===== D-4 試合情報セクション ===== */
const DECIDED: [string, string][] = [["regulation", "規定"], ["time_limit", "時間切れ"], ["walkoff", "サヨナラ"], ["called", "コールド"], ["forfeit", "不戦"], ["tie", "引分"]];
export function GameInfoSection({ meta, post, busy }: {
  meta: { home_away: "home" | "away" | null; our_score: number | null; their_score: number | null; outcome: string | null; decided_by: string | null; line_score: { ours: (number | null)[]; theirs: (number | null)[] } | null };
  post: PostFn; busy: boolean;
}) {
  const { confirm } = useDialog();
  const [ha, setHa] = useState<string>(meta.home_away ?? "");
  const [our, setOur] = useState(meta.our_score != null ? String(meta.our_score) : "");
  const [their, setTheir] = useState(meta.their_score != null ? String(meta.their_score) : "");
  const [outcome, setOutcome] = useState(meta.outcome ?? "");
  const [decided, setDecided] = useState(meta.decided_by ?? "");
  // [§0/§11 B] line_score: 回別の得点(空欄=不明・"0"=無得点・数値=得点)。null=不明 と 0=無得点 を区別する。
  const cell = (n: number | null | undefined) => (n == null ? "" : String(n));
  const initInn = Math.max(meta.line_score?.ours.length ?? 0, meta.line_score?.theirs.length ?? 0, 7);
  const [ours, setOurs] = useState<string[]>(Array.from({ length: initInn }, (_, i) => cell(meta.line_score?.ours[i])));
  const [theirs, setTheirs] = useState<string[]>(Array.from({ length: initInn }, (_, i) => cell(meta.line_score?.theirs[i])));
  const innings = ours.length;

  async function save() {
    // 先攻後攻の変更は half 解釈が反転するため確認必須(§10.3)
    if ((ha || null) !== (meta.home_away ?? null)) {
      const ok = await confirm({ title: "先攻後攻を変更", body: "表裏の解釈が反転し、全打席の攻守が入れ替わります。よろしいですか？", confirmLabel: "変更する", danger: true });
      if (!ok) return;
    }
    const op: Record<string, unknown> = { type: "setGameMeta", home_away: ha ? (ha as "home" | "away") : null };
    // resultパッチを組み立て: 最終スコア4項目が揃えば入れる ＋ line_score に入力があれば入れる(mergeで既存を保つ)。
    const parseCell = (s: string): number | null => (s.trim() === "" ? null : Number(s)); // 空=不明(null)・0=無得点
    const oursLs = ours.map(parseCell);
    const theirsLs = theirs.map(parseCell);
    const hasLs = oursLs.some((v) => v != null) || theirsLs.some((v) => v != null);
    const result: Record<string, unknown> = {};
    if (our.trim() !== "" && their.trim() !== "" && outcome && decided) {
      Object.assign(result, { our_score: Number(our), their_score: Number(their), outcome, decided_by: decided });
    }
    if (hasLs) result.line_score = { ours: oursLs, theirs: theirsLs };
    if (Object.keys(result).length) op.result = result; // 空なら送らない=既存resultを保つ
    post(op);
  }
  const setCell = (setter: (f: (a: string[]) => string[]) => void, i: number, v: string) => setter((a) => a.map((x, j) => (j === i ? v : x)));
  return (
    <div>
      <div className="sc-row">
        <label>先攻後攻 <Sel value={ha} onChange={setHa} opts={[["", "未設定"], ["away", "先攻(表)"], ["home", "後攻(裏)"]]} /></label>
      </div>
      <div className="sc-row">
        <label>N-KINGS <input type="number" value={our} onChange={(e) => setOur(e.target.value)} style={{ width: "3.5em" }} /></label>
        <span>-</span>
        <label>相手 <input type="number" value={their} onChange={(e) => setTheir(e.target.value)} style={{ width: "3.5em" }} /></label>
        <label>結果 <Sel value={outcome} onChange={setOutcome} opts={[["", "—"], ["win", "勝"], ["loss", "敗"], ["tie", "分"]]} /></label>
        <label>決着 <Sel value={decided} onChange={setDecided} opts={[["", "—"], ...DECIDED]} /></label>
      </div>

      {/* 回別得点(line_score): 空欄=不明 / 0=無得点 / 数値=得点 */}
      <div className="sc-sub">
        <div className="sc-subhd">回別得点（空欄=不明・0=無得点）
          <button className="db-act" onClick={() => { setOurs((a) => [...a, ""]); setTheirs((a) => [...a, ""]); }}>＋回</button>
          {innings > 1 && <button className="db-act" onClick={() => { setOurs((a) => a.slice(0, -1)); setTheirs((a) => a.slice(0, -1)); }}>－回</button>}
        </div>
        <div className="scrollx"><table className="linescore">
          <thead><tr><th className="tl"></th>{Array.from({ length: innings }, (_, i) => <th key={i}>{i + 1}</th>)}</tr></thead>
          <tbody>
            <tr><td className="tl tm">N-KINGS</td>{ours.map((v, i) => <td key={i}><input value={v} onChange={(e) => setCell(setOurs, i, e.target.value)} style={{ width: "2.4em", textAlign: "center" }} placeholder="?" /></td>)}</tr>
            <tr><td className="tl tm">相手</td>{theirs.map((v, i) => <td key={i}><input value={v} onChange={(e) => setCell(setTheirs, i, e.target.value)} style={{ width: "2.4em", textAlign: "center" }} placeholder="?" /></td>)}</tr>
          </tbody>
        </table></div>
      </div>

      <div className="sc-row">
        <button disabled={busy} onClick={save}>試合情報を保存</button>
      </div>
      <p className="muted">※ これは未確定の集計結果の編集（メタ・出欠タブの公開直コミットとは別経路）。最終スコアは公開時のR4突合に使われます。回別得点は「この回は0点／n点／途中不明」を保持します。</p>
    </div>
  );
}

/** ===== §0/§11 個人成績(断片)セクション ===== */
const BAT_FIELDS: [keyof DirectBatting, string][] = [
  ["pa", "打席"], ["ab", "打数"], ["r", "得点"], ["h", "安打"], ["b1", "単打"], ["b2", "二塁"], ["b3", "三塁"],
  ["hr", "本塁"], ["rbi", "打点"], ["bb", "四球"], ["hbp", "死球"], ["k", "三振"], ["sh", "犠打"], ["sf", "犠飛"], ["sb", "盗塁"],
];
const PIT_FIELDS: [keyof DirectPitching, string][] = [
  ["bf", "対打者"], ["h", "被安打"], ["hr", "被本"], ["k", "奪三振"], ["bb", "与四球"], ["hbp", "与死球"], ["r", "失点"], ["er", "自責"], ["wp", "暴投"],
];
const FLD_FIELDS: [keyof DirectFielding, string][] = [["po", "刺殺"], ["a", "捕殺"], ["e", "失策"], ["tc", "守備機会"]];

/** 投球回 "5.2"(=5回2/3) → アウト数。空/非数値は undefined。 */
function ipToOuts(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (Number.isNaN(n)) return undefined;
  const whole = Math.floor(n + 1e-9);
  const frac = Math.round((n - whole) * 10);
  return whole * 3 + (frac === 1 || frac === 2 ? frac : 0);
}
const outsToIp = (outs?: number) => (outs == null ? "" : `${Math.floor(outs / 3)}.${outs % 3}`);
/** 疎な文字列マップ → 数値のみの疎オブジェクト(空欄=None=省略)。全空なら null。 */
function pickNums<K extends string>(m: Record<string, string>, keys: readonly K[]): Record<K, number> | null {
  const out = {} as Record<K, number>;
  let any = false;
  for (const k of keys) {
    const v = m[k];
    if (v != null && v.trim() !== "" && !Number.isNaN(Number(v))) { out[k] = Number(v); any = true; }
  }
  return any ? out : null;
}

type DirectRow = {
  participant_id: string;
  bat: Record<string, string>;
  pit: Record<string, string>;
  fld: Record<string, string>;
  ip: string;
  decision: string;
};
const emptyDirectRow = (): DirectRow => ({ participant_id: "", bat: {}, pit: {}, fld: {}, ip: "", decision: "" });
function toDirectRow(v: DirectStatRowView): DirectRow {
  const s = (n?: number | null) => (n == null ? "" : String(n));
  const bat: Record<string, string> = {}; const pit: Record<string, string> = {}; const fld: Record<string, string> = {};
  if (v.batting) for (const [k] of BAT_FIELDS) bat[k] = s((v.batting as Record<string, number | undefined>)[k]);
  if (v.pitching) for (const [k] of PIT_FIELDS) pit[k] = s((v.pitching as Record<string, number | undefined>)[k]);
  if (v.fielding) for (const [k] of FLD_FIELDS) fld[k] = s((v.fielding as Record<string, number | undefined>)[k]);
  return { participant_id: v.participant_id, bat, pit, fld, ip: outsToIp(v.pitching?.outs ?? undefined), decision: v.pitching?.decision ?? "" };
}

const NumGrid = ({ fields, vals, set }: { fields: [string, string][]; vals: Record<string, string>; set: (k: string, v: string) => void }) => (
  <div className="sc-numgrid">
    {fields.map(([k, label]) => (
      <label key={k} className="sc-num">{label}<input type="number" value={vals[k] ?? ""} onChange={(e) => set(k, e.target.value)} /></label>
    ))}
  </div>
);

export function DirectStatsSection({ existing, participants, post, busy }: {
  existing: DirectStatRowView[]; participants: Person[]; post: PostFn; busy: boolean;
}) {
  const [rows, setRows] = useState<DirectRow[]>(existing.length ? existing.map(toDirectRow) : [emptyDirectRow()]);
  const upd = (i: number, f: (r: DirectRow) => DirectRow) => setRows((rs) => rs.map((x, j) => (j === i ? f(x) : x)));

  function save() {
    const stats = rows.flatMap((r) => {
      if (!r.participant_id) return [];
      const batting = pickNums(r.bat, BAT_FIELDS.map(([k]) => k));
      const outs = ipToOuts(r.ip);
      const pitNums = pickNums(r.pit, PIT_FIELDS.map(([k]) => k));
      const pitching = (outs != null || pitNums || r.decision)
        ? { ...(pitNums ?? {}), ...(outs != null ? { outs } : {}), ...(r.decision ? { decision: r.decision } : {}) }
        : null;
      const fielding = pickNums(r.fld, FLD_FIELDS.map(([k]) => k));
      if (!batting && !pitching && !fielding) return [];
      return [{ participant_id: r.participant_id, ...(batting ? { batting } : {}), ...(pitching ? { pitching } : {}), ...(fielding ? { fielding } : {}), origin: "manual" }];
    });
    post({ type: "setDirectStats", stats });
  }

  return (
    <div>
      <p className="muted">盤面（打席）を伴わない個人成績の断片を直接記録します。空欄=なし（0埋めしない）。入力した数値だけ集計に加算されます。保存で全置換。</p>
      {rows.map((r, i) => (
        <fieldset key={i} className="sc-fs">
          <legend>
            <PersonSelect value={r.participant_id} onChange={(v) => upd(i, (x) => ({ ...x, participant_id: v }))} participants={participants} masters={[]} autoLabel="（選手を選ぶ）" />
            <button className="db-act" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>この行を削除</button>
          </legend>
          <div className="sc-subhd">打撃</div>
          <NumGrid fields={BAT_FIELDS as [string, string][]} vals={r.bat} set={(k, v) => upd(i, (x) => ({ ...x, bat: { ...x.bat, [k]: v } }))} />
          <div className="sc-subhd">投手</div>
          <div className="sc-numgrid">
            <label className="sc-num">投球回<input value={r.ip} onChange={(e) => upd(i, (x) => ({ ...x, ip: e.target.value }))} placeholder="5.2" /></label>
            {PIT_FIELDS.map(([k, label]) => (
              <label key={k} className="sc-num">{label}<input type="number" value={r.pit[k] ?? ""} onChange={(e) => upd(i, (x) => ({ ...x, pit: { ...x.pit, [k]: e.target.value } }))} /></label>
            ))}
            <label className="sc-num">判定<Sel value={r.decision} onChange={(v) => upd(i, (x) => ({ ...x, decision: v }))} opts={DECISION} /></label>
          </div>
          <div className="sc-subhd">守備</div>
          <NumGrid fields={FLD_FIELDS as [string, string][]} vals={r.fld} set={(k, v) => upd(i, (x) => ({ ...x, fld: { ...x.fld, [k]: v } }))} />
        </fieldset>
      ))}
      <div className="sc-row">
        <button className="db-act" onClick={() => setRows((rs) => [...rs, emptyDirectRow()])}>＋選手を追加</button>
        <button disabled={busy} onClick={save}>個人成績(断片)を保存</button>
        <span className="muted">※ 選択できるのは出欠リストの参加者のみ（未参加は先に出欠へ）。</span>
      </div>
    </div>
  );
}
