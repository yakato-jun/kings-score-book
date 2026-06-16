/**
 * 試合データの操作レイヤ。Atlas を正本に書き込む。管理UIとAI入力の双方がこれを呼ぶ。
 * 詳細な打席編集は画面では作らず、JSON取込(importGameDoc)で丸ごと差し替える方針。
 */
import { loadGames, loadGame, commitGameDoc } from "@/lib/db/games";
import type { GameDoc, Game, GameResult, AttendanceEntry } from "@/lib/types/v2";

/** 一覧用に各試合のメタ(game)だけ返す */
export async function listGameMeta(): Promise<Game[]> {
  const games = await loadGames();
  return games.map((d) => d.game).sort((a, b) => b.date.localeCompare(a.date));
}

export interface GameMetaInput {
  id: string;
  date: string;
  opponent: string;
  league?: string | null;
  home_away: "home" | "away" | null;
  dh: boolean;
  result: GameResult | null;
}

/** メタ情報の編集/新規。既存docがあれば game だけ差し替え、無ければ空のシェルを作る。 */
export async function upsertGameMeta(input: GameMetaInput): Promise<void> {
  if (!/^G\d{8}$/.test(input.id)) throw new Error(`試合IDは G20260607 形式で必須です（受領: "${input.id}"）`);
  if (!input.date) throw new Error("日付は必須です");
  if (!input.opponent?.trim()) throw new Error("対戦相手は必須です");

  const existing = await loadGame(input.id);
  // 結果は編集対象(スコア/勝敗/決着)以外の既存フィールド(scheduled_innings/line_score)を保持する
  const result: GameResult | null = input.result
    ? { ...existing?.game.result, ...input.result }
    : null;
  const game: Game = {
    id: input.id,
    date: input.date,
    opponent: input.opponent.trim(),
    league: input.league?.trim() || null,
    home_away: input.home_away,
    dh: input.dh,
    result,
    note: existing?.game.note ?? null,
  };
  const doc: GameDoc = existing
    ? { ...existing, game }
    : {
        schema_version: "2.0",
        game,
        additional_players: [],
        lineup_snapshots: [],
        plate_appearances: [],
        attendance: [],
      };
  await commitGameDoc(doc, { source: "ui", op: { type: "upsertGameMeta", args: { id: input.id } } });
}

/** 出欠の設定。played/bench のみを保存（欠席はエントリ無し）。 */
export async function setAttendance(gameId: string, entries: AttendanceEntry[]): Promise<void> {
  const doc = await loadGame(gameId);
  if (!doc) throw new Error(`試合 ${gameId} が見つかりません`);
  await commitGameDoc({ ...doc, attendance: entries }, { source: "ui", op: { type: "setAttendance", args: { gameId, count: entries.length } } });
}

/** 試合doc を JSON 文字列から取り込み（丸ごと upsert）。構造を軽く検証。 */
export async function importGameDoc(json: string): Promise<string> {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error("JSON の構文が不正です");
  }
  validateGameDoc(doc);
  await commitGameDoc(doc, { source: "ui", op: { type: "importGameDoc", args: { id: doc.game.id } } });
  return doc.game.id;
}

function validateGameDoc(doc: unknown): asserts doc is GameDoc {
  const d = doc as Record<string, unknown>;
  if (!d || typeof d !== "object") throw new Error("オブジェクトではありません");
  if (d.schema_version !== "2.0") throw new Error('schema_version は "2.0" が必要です');
  const game = d.game as Record<string, unknown> | undefined;
  if (!game || typeof game.id !== "string" || !/^G\d{8}$/.test(game.id))
    throw new Error("game.id が G20260607 形式ではありません");
  if (typeof game.date !== "string" || !game.date) throw new Error("game.date が必要です");
  for (const f of ["plate_appearances", "lineup_snapshots", "attendance", "additional_players"]) {
    if (!Array.isArray(d[f])) throw new Error(`${f} は配列が必要です`);
  }
}
