/**
 * 選手ID→表示名。players(マスタ)に登録があればそれを使う。
 * 助っ人(G-id)は名前がデータに無いため「助っ人」と表記。それ以外の未登録IDはそのまま返す。
 */
export function playerName(id: string, players: Map<string, string>): string {
  const n = players.get(id);
  if (n) return n;
  const m = id.match(/^G0*(\d+)/); // 助っ人は試合内で連番(G001→助っ人1)。名前はデータに無い
  if (m) return `助っ人${m[1]}`;
  return id;
}
