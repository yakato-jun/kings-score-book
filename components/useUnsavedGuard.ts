"use client";
import { useEffect } from "react";
import { markDirty } from "@/lib/unsaved-guard";

/**
 * 未保存変更ガードのフック。
 * isDirty の間だけ:
 *  - beforeunload リスナを登録し、更新/閉じる/ブラウザ戻る/外部遷移でブラウザ標準の離脱警告を出す。
 *  - 共有レジストリに自分を dirty 登録し、アプリ内遷移側(タブ・参加者フォーム)が参照できるようにする。
 * isDirty が false になった時・unmount 時に、beforeunload と登録の両方を解除する
 * (dirty 時のみ付ける＝常時登録による UX 悪化を避ける)。
 */
export function useUnsavedGuard(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    const token = Symbol("unsaved-guard");
    markDirty(token, true);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      markDirty(token, false);
    };
  }, [isDirty]);
}
