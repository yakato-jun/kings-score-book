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
}

function validate(p: Player): void {
  if (/^G/i.test(p.id))
    throw new Error("助っ人(Gで始まるID)は選手マスタには登録しません。試合の出場選手(additional_players)として、その試合の中で記録してください。");
  if (!/^P\d{3}$/.test(p.id)) throw new Error(`選手IDは P001 形式で必須です（受領: "${p.id}"）`);
  if (!p.name) throw new Error("選手名は必須です");
}

export async function listPlayers(): Promise<Player[]> {
  return loadPlayerList();
}

/** 新規/編集の両方。id一致で上書き。 */
export async function upsertPlayer(input: PlayerInput): Promise<Player> {
  const p: Player = {
    id: (input.id ?? "").trim(),
    name: (input.name ?? "").trim(),
    type: (input.type ?? "").trim() || "member",
  };
  validate(p);
  await writePlayer(p);
  return p;
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
