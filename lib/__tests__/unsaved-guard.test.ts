import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  markDirty,
  isAnyDirty,
  resetDirtyRegistry,
  confirmLeaveIfDirty,
  UNSAVED_GUARD_DIALOG,
} from "../unsaved-guard";

beforeEach(() => resetDirtyRegistry());

describe("dirty レジストリ", () => {
  it("初期状態は未dirty", () => {
    expect(isAnyDirty()).toBe(false);
  });

  it("markDirty(true)で登録、falseで解除", () => {
    const t = Symbol("t");
    markDirty(t, true);
    expect(isAnyDirty()).toBe(true);
    markDirty(t, false);
    expect(isAnyDirty()).toBe(false);
  });

  it("複数トークン: どれか1つでも残れば dirty", () => {
    const a = Symbol("a");
    const b = Symbol("b");
    markDirty(a, true);
    markDirty(b, true);
    markDirty(a, false);
    expect(isAnyDirty()).toBe(true); // b が残っている
    markDirty(b, false);
    expect(isAnyDirty()).toBe(false);
  });

  it("同一トークンの重複解除は安全(冪等)", () => {
    const t = Symbol("t");
    markDirty(t, true);
    markDirty(t, false);
    markDirty(t, false);
    expect(isAnyDirty()).toBe(false);
  });

  it("resetDirtyRegistry で全解除", () => {
    markDirty(Symbol("x"), true);
    markDirty(Symbol("y"), true);
    resetDirtyRegistry();
    expect(isAnyDirty()).toBe(false);
  });
});

describe("confirmLeaveIfDirty", () => {
  it("未dirtyなら confirm を呼ばず即 true", async () => {
    const confirm = vi.fn(async () => false);
    const ok = await confirmLeaveIfDirty(confirm);
    expect(ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("dirty かつ「破棄して続行」= true", async () => {
    markDirty(Symbol("d"), true);
    const confirm = vi.fn(async () => true);
    const ok = await confirmLeaveIfDirty(confirm);
    expect(ok).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("dirty かつ「キャンセル」= false(留まる)", async () => {
    markDirty(Symbol("d"), true);
    const confirm = vi.fn(async () => false);
    const ok = await confirmLeaveIfDirty(confirm);
    expect(ok).toBe(false);
  });

  it("承認済みの破棄文言(題/本文/破棄ボタン)と danger を渡す", async () => {
    markDirty(Symbol("d"), true);
    const confirm = vi.fn(async () => true);
    await confirmLeaveIfDirty(confirm);
    expect(confirm).toHaveBeenCalledWith({
      title: UNSAVED_GUARD_DIALOG.title,
      body: UNSAVED_GUARD_DIALOG.body,
      confirmLabel: UNSAVED_GUARD_DIALOG.confirmLabel,
      danger: true,
    });
  });
});
