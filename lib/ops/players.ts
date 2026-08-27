/**
 * 選手マスタの操作レイヤ。管理UI(Server Action)とAIチャット入力の双方がこれを呼ぶ
 * = 「UIでできること＝AIでできること」を一致させる単一の真実。書き込み前に検証する。
 */
import { loadPlayerList, writePlayer } from "@/lib/db/players";
import type { Player } from "@/lib/types/v2";

export interface PlayerInput {
  id: string;
  name: string;
  type?: string;
  // [§12] 助っ人移行の冪等キー(出自)。編集/種別変更でも黙って落とさない(非破壊)。通常の入力では未指定。
  origin?: Player["origin"];
}

function validate(p: Player): void {
  // [§12 P1] 助っ人も種別 "guest" で選手マスタに載る前提へ移行(接頭辞で種別を区別しない・IDは P### に統一)。
  //   旧「Gで始まるIDは additional_players で」拒否は前提が消えたため撤廃。ID書式は従来どおり P### を強制する
  //   (既存フォーマットを壊さない＝G-id等 P###以外は従来どおり弾く。ただし助っ人固有の誘導文言は出さない)。
  if (!/^P\d{3}$/.test(p.id)) throw new Error(`選手IDは P001 形式で必須です（受領: "${p.id}"）`);
  if (!p.name) throw new Error("選手名は必須です");
}

export async function listPlayers(): Promise<Player[]> {
  return loadPlayerList();
}

/** 新規/編集の両方。id一致で上書き。origin(出自)は渡されたら保持する(非破壊)。 */
export async function upsertPlayer(input: PlayerInput): Promise<Player> {
  const p: Player = {
    id: (input.id ?? "").trim(),
    name: (input.name ?? "").trim(),
    type: (input.type ?? "").trim() || "member",
    ...(input.origin ? { origin: input.origin } : {}),
  };
  validate(p);
  await writePlayer(p);
  return p;
}

/**
 * [§12 P1] 助っ人を種別 "guest" で選手マスタへ新規採番して登録し Player を返す(助っ人追加の新規経路)。
 * best-effort＝重複防止は作り込まない(同名の別マスタが増えても許容)。再集計の実質的な冪等性は
 *   「一度作れば辞書に載り AI/UI は以後 player_id で参照する」＋全置換の regraft(人物キー=player_id)に素直に乗る程度で足り、
 *   万一の重複や誤割り当ては後から名寄せ(mergePlayer・P3)で人が直す前提(過剰設計を避ける)。
 */
export async function createGuestPlayer(name: string): Promise<Player> {
  const nm = (name ?? "").trim();
  if (!nm) throw new Error("助っ人名は必須です");
  const id = await nextPlayerId();
  return upsertPlayer({ id, name: nm, type: "guest" });
}

/**
 * [§12 P1] 選手の種別を書き換える(正式加入＝"guest"→正選手 等)。値は狭めない(自由文字列のまま)。
 * 出場は player_id 参照なので種別変更だけで過去出場が通算に入る/外れる(データ書換ゼロ)。origin(出自)は保持(非破壊)。
 */
export async function setPlayerType(playerId: string, type: string): Promise<Player> {
  const cur = (await listPlayers()).find((p) => p.id === playerId);
  if (!cur) throw new Error(`選手 ${playerId} が選手マスタにありません`);
  return upsertPlayer({ id: cur.id, name: cur.name, type, origin: cur.origin });
}

/** 次の空き P-id を提案（P001..）。新規追加フォームの初期値用。 */
export async function nextPlayerId(): Promise<string> {
  const nums = (await listPlayers())
    .map((p) => /^P(\d{3})$/.exec(p.id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => parseInt(m[1], 10));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return "P" + String(n).padStart(3, "0");
}
