/**
 * シーズン(年度)の判定。現状は年=シーズン。定義を変えたい場合(リーグ周期等)はここだけ直す。
 */
export function seasonOf(date: string): string {
  return date.slice(0, 4); // "2026-06-07" → "2026"
}

/** 与えた日付群から、存在するシーズンを新しい順で返す */
export function listSeasons(dates: string[]): string[] {
  return [...new Set(dates.map(seasonOf))].sort((a, b) => b.localeCompare(a));
}

/** searchParams のシーズン指定を検証して確定（無効/未指定なら最新） */
export function resolveSeason(seasons: string[], requested?: string): string {
  return requested && seasons.includes(requested) ? requested : seasons[0];
}
