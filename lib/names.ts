/**
 * 選手ID→表示名。players(マスタ)に登録があればそれを使う。
 * 助っ人(G-id)は名前がデータに無いため「助っ人」と表記。それ以外の未登録IDはそのまま返す。
 * [旧形式用] §9移行後の試合docは docNameResolver を使う(participantsが名前の正本)。
 */
export function playerName(id: string, players: Map<string, string>): string {
  const n = players.get(id);
  if (n) return n;
  const m = id.match(/^G0*(\d+)/); // 助っ人は試合内で連番(G001→助っ人1)。名前はデータに無い
  if (m) return `助っ人${m[1]}`;
  return id;
}

import type { GameDoc } from "./types/v2";

/**
 * [§9] 試合docの人物ID→表示名リゾルバ。participants(=試合の人リスト)が正本:
 *  roster→マスタ名 / guest→link.name(実名)。相手プレースホルダ(oN)は「相手N番」。
 * 旧形式doc(移行前)は additional_players→playerName へフォールバック。
 * id が null/undefined(=走者不明。得点者不明などの第一級の値)は「不明」を返す＝表示層で落ちない。
 * (本番 /games/[id]/text の digest 99012289: 走者不明の runner_id に nameOf が null.match で落ちた実バグの根本対処)
 */
export function docNameResolver(doc: GameDoc, players: Map<string, string>): (id: string | null | undefined) => string {
  const m = new Map<string, string>();
  for (const p of doc.participants ?? []) {
    // roster→マスタ名。guest→link.name(実名)の解決は [§12 P5 legacy・撤去しない]＝現公開版は roster 一本だが
    //   game_history 過去版の旧guest link(?gen=N プレビュー)の名前解決に必要。
    m.set(p.id, p.link.kind === "roster" ? (players.get(p.link.player_id) ?? p.link.player_id) : (p.link.name ?? "助っ人"));
  }
  for (const a of doc.additional_players ?? []) if (a.name && !m.has(a.id)) m.set(a.id, a.name); // 旧形式
  return (id: string | null | undefined) => {
    if (id == null) return "不明"; // 走者不明(null)は正当な記録＝名前解決も「不明」で表現する
    const hit = m.get(id);
    if (hit) return hit;
    const o = id.match(/^o(\d+)$/); // 相手プレースホルダ(§9二軸: 身元非追跡・位置のみ)
    if (o) return `相手${o[1]}番`;
    return playerName(id, players);
  };
}
