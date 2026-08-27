/**
 * 未保存変更ガードの共有状態(純ロジック・DOM非依存)。
 *
 * 目的: 出欠の移動などの「未保存の編集」を、別コンポーネント(タブ切替・参加者操作フォーム)から
 * 「今なにか未保存か?」と参照できるようにする。Context のプロバイダ配線を増やさず、
 * クロスコンポーネントで共有 dirty を持てるモジュールレベルのレジストリにする。
 *
 * dirty なコンポーネントは自分のトークンを登録し、解消・unmount で外す。
 * isAnyDirty() が1つでも残っていれば「未保存あり」。
 */

// dirty なコンポーネントのトークン集合。
const dirtyTokens = new Set<symbol>();

/** token を dirty(true)/クリーン(false) として登録・解除する(冪等)。 */
export function markDirty(token: symbol, dirty: boolean): void {
  if (dirty) dirtyTokens.add(token);
  else dirtyTokens.delete(token);
}

/** いま未保存の編集を抱えたコンポーネントが1つでもあるか。 */
export function isAnyDirty(): boolean {
  return dirtyTokens.size > 0;
}

/** テスト用: レジストリを初期状態(空)に戻す。 */
export function resetDirtyRegistry(): void {
  dirtyTokens.clear();
}

/** 破棄警告ダイアログの文言(題=操作/本文=結果/主ボタン=動詞 の統一パターン)。 */
export const UNSAVED_GUARD_DIALOG = {
  title: "未保存の変更があります",
  body: "保存せず移動すると、変更内容は失われます。",
  confirmLabel: "破棄して続行",
} as const;

/** useDialog().confirm と同形の最小型(lib を components 依存にしないため局所定義)。 */
export type ConfirmFn = (opts: {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
}) => Promise<boolean>;

/**
 * 未保存があれば破棄確認ダイアログを出し、
 *   「破棄して続行」= true / 「キャンセル」= false を返す。
 * 未保存が無ければダイアログを出さず即 true(=そのまま遷移/実行してよい)。
 * ダイアログ表示自体は呼び出し側(useDialog の confirm)に委ねる。
 */
export async function confirmLeaveIfDirty(confirm: ConfirmFn): Promise<boolean> {
  if (!isAnyDirty()) return true;
  return confirm({ ...UNSAVED_GUARD_DIALOG, danger: true });
}
