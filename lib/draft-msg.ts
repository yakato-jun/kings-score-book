/**
 * 下書きブロックのユーザー向け定型文。2軸で分ける（UX一貫性のため文言は1箇所に集約）。
 *  軸1=予防(render時に下書きが分かる→操作させない): draftBlockMsg
 *  軸2=楽観ロック(描画後に下書き追加/公開が割り込んだ稀なレース→再読込): draftRaceMsg
 * 用語はユーザーが実際に押すボタン(NoteClient)に合わせ『確定（公開）』『破棄』で固定。スラッシュ表記は使わない。
 * 生の GenConflictError 文（世代衝突: base_gen=…）は開発者向け。UI には必ずこの定型文へ翻訳して出す。
 */
export function draftBlockMsg(op: string): string {
  return `未確定の集計結果があるため、${op}できません。「ノート入力」で確定（公開）または破棄してください。`;
}

export function draftRaceMsg(op: string): string {
  return `${op}できませんでした。読み込み後に未確定の集計結果の追加・公開で状態が変わっています。画面を再読み込みしてから、もう一度お試しください。`;
}
