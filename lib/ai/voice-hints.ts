/**
 * STTへ渡す語彙ヒント(逐次バッチ /api/voice と Live /api/voice/live-session で共用)。
 * 辞書=全選手名(助っ人含む)+この試合の相手チーム名。名前だけ渡す=本文にIDを混入させない。
 */
import { listPlayers } from "@/lib/ops/players";
import { loadGame } from "@/lib/db/games";
import { BASEBALL_TERMS } from "./voice";

/** STT の prompt(自由文の文脈)。語の列挙は keywords 側に分ける(prompt に語を詰めると崩れやすい) */
export const STT_PROMPT = "草野球チームN-KINGSの試合結果を口述したメモ。選手名、野球用語、「1回表」「ランナー一二塁」のような表現を含む日本語の独り言。";

/** keywords: 選手のフルネーム+姓(口述は姓が主)+野球用語。制約(1語1行・<>や改行を含めない)に合わせて浄化。 */
export function buildKeywords(dict: string[]): string[] {
  return [...new Set(
    [...dict, ...dict.map((n) => n.split(/\s+/)[0]), ...BASEBALL_TERMS]
      .map((k) => k.replace(/[<>\r\n]/g, "").trim())
      .filter((k) => k.length > 0),
  )];
}

export async function voiceHints(gameId: string): Promise<{ dict: string[]; keywords: string[] }> {
  const players = await listPlayers();
  const dict = players.map((p) => p.name);
  const doc = await loadGame(gameId);
  if (doc?.game.opponent) dict.push(doc.game.opponent);
  return { dict, keywords: buildKeywords(dict) };
}
