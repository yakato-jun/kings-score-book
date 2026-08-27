"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * 共通ダイアログ。ネイティブ confirm/prompt/alert を全廃し、テーマ統一の命令型APIに寄せる。
 *  const ok = await confirm({ title, body, confirmLabel })   → Promise<boolean>
 *  const v  = await promptText({ title, body, defaultValue }) → Promise<string|null>
 * 文言パターンは「題=操作名／本文=結果／主ボタン=動詞／副=キャンセル」に統一。Esc・背景クリックでキャンセル。
 */
type ConfirmOpts = { title: string; body?: string; confirmLabel?: string; danger?: boolean };
type PromptOpts = { title: string; body?: string; defaultValue?: string; confirmLabel?: string; placeholder?: string };

type DialogState =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void }
  | null;

interface DialogApi {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  promptText: (opts: PromptOpts) => Promise<string | null>;
}

const Ctx = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDialog は DialogProvider の内側で使ってください");
  return c;
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  const [input, setInput] = useState("");

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ kind: "confirm", opts, resolve })),
    [],
  );
  const promptText = useCallback(
    (opts: PromptOpts) => new Promise<string | null>((resolve) => { setInput(opts.defaultValue ?? ""); setState({ kind: "prompt", opts, resolve }); }),
    [],
  );

  const finish = useCallback((result: boolean | string | null) => {
    setState((s) => {
      if (s) (s.resolve as (v: boolean | string | null) => void)(result);
      return null;
    });
  }, []);

  const cancel = useCallback(() => finish(state?.kind === "confirm" ? false : null), [finish, state]);

  // Esc=キャンセル
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, cancel]);

  return (
    <Ctx.Provider value={{ confirm, promptText }}>
      {children}
      {state && (
        <div className="dlg-overlay" onClick={cancel}>
          <div className="dlg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2 className="dlg-title">{state.opts.title}</h2>
            {state.opts.body && <p className="dlg-body">{state.opts.body}</p>}
            {state.kind === "prompt" && (
              <input
                className="dlg-input"
                autoFocus
                value={input}
                placeholder={state.opts.placeholder}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") finish(input); }}
              />
            )}
            <div className="dlg-actions">
              <button className="dlg-cancel" onClick={cancel}>キャンセル</button>
              <button
                className={`dlg-ok${state.kind === "confirm" && state.opts.danger ? " danger" : ""}`}
                autoFocus={state.kind === "confirm"}
                onClick={() => finish(state.kind === "confirm" ? true : input)}
              >
                {state.opts.confirmLabel ?? (state.kind === "confirm" ? "実行" : "決定")}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
