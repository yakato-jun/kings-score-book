"use client";
import { useRef, useState } from "react";
import { useDialog } from "@/components/DialogProvider";
import { useUnsavedGuard } from "@/components/useUnsavedGuard";
import { confirmLeaveIfDirty, isAnyDirty } from "@/lib/unsaved-guard";

type FormProps = {
  action: (formData: FormData) => void | Promise<void>;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
};

/**
 * サーバアクション用フォームの「送信前ガード」ラッパ。
 * サーバコンポーネント内の <form action={serverAction}> をそのまま置き換えて使う。
 * 送信時に「他に未保存の編集(出欠の移動など)」があれば破棄確認を挟み、
 *   キャンセル=送信中止 / 破棄して続行=そのまま送信。
 * サーバアクション自体(participantAction 等)は変更しない。
 *
 * 非同期の確認を挟むため、いったん preventDefault で送信を止めて確認を待ち、
 * OK なら bypass フラグを立てて requestSubmit で本来の送信(サーバアクション)を再実行する。
 * 押されたボタン(name/value=act)は submitter として引き継ぐ。
 */
export function GuardedActionForm({ action, children, className, style }: FormProps) {
  const { confirm } = useDialog();
  const bypass = useRef(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (bypass.current) {
      bypass.current = false; // 確認済みの再送信はそのまま通す
      return;
    }
    // 未保存が無ければ横取りせずネイティブ送信のまま通す。
    //   ★重要: clean時に preventDefault→await(即true)→requestSubmit するとユーザージェスチャーが切れ、
    //   React 19 のサーバアクションが発火せず「参加者操作が無反応」になる回帰を生む。
    //   よって dirty の時だけ preventDefault して確認を挟む(dirty経路はダイアログ実クリックのジェスチャー内で再送信=発火する)。
    if (!isAnyDirty()) return;
    const form = e.currentTarget; // await 後は currentTarget が null になるため先に確保
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    e.preventDefault();
    const ok = await confirmLeaveIfDirty(confirm);
    if (!ok) return; // キャンセル=留まる
    bypass.current = true;
    form.requestSubmit(
      submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : undefined,
    );
  }

  return (
    <form action={action} onSubmit={onSubmit} className={className} style={style}>
      {children}
    </form>
  );
}

/**
 * uncontrolled な入力フォームを「未保存ソース」として登録するラッパ(メタ情報フォーム用)。
 * 入力変更を onInput で検知して自分を dirty 登録する。これにより、未保存のメタ編集がある状態で
 * タブ切替や参加者操作をすると破棄確認が出る。送信(=保存)時は自分の dirty を解消する
 * (送信後の再描画でも自然に解ける)。
 * 注: 保存ボタン自体はガードしない(承認済み範囲=タブ/参加者操作/ブラウザ離脱の破棄アクションのみ)。
 */
export function DirtySourceForm({ action, children, className, style }: FormProps) {
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty);
  return (
    <form
      action={action}
      onInput={() => setDirty(true)}
      onSubmit={() => setDirty(false)}
      className={className}
      style={style}
    >
      {children}
    </form>
  );
}
