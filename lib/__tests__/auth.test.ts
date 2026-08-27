import { describe, it, expect, afterEach } from "vitest";
import { passwordToken, isValidToken, sitePassword } from "../auth";

const orig = process.env.SITE_PASSWORD;
afterEach(() => {
  if (orig === undefined) delete process.env.SITE_PASSWORD;
  else process.env.SITE_PASSWORD = orig;
});

describe("共有パスワードゲート(仮公開・暫定)", () => {
  it("正しいパスワードのトークンだけが有効。無し/偽物は無効", async () => {
    process.env.SITE_PASSWORD = "testpass";
    const good = await passwordToken("testpass");
    expect(await isValidToken(good)).toBe(true);
    expect(await isValidToken(undefined)).toBe(false);
    expect(await isValidToken("deadbeef")).toBe(false);
    expect(await isValidToken(await passwordToken("wrong"))).toBe(false);
  });

  it("SITE_PASSWORD を変えると旧トークンは失効する(全端末ログアウト)", async () => {
    process.env.SITE_PASSWORD = "testpass";
    const old = await passwordToken("testpass");
    process.env.SITE_PASSWORD = "newpass";
    expect(await isValidToken(old)).toBe(false);
    expect(await isValidToken(await passwordToken("newpass"))).toBe(true);
  });

  it("既定パスワードは存在しない: 未設定は fail-closed(例外)で誰も通さない(公開リポにつき)", async () => {
    delete process.env.SITE_PASSWORD;
    expect(() => sitePassword()).toThrow(/SITE_PASSWORD/);
  });

  it("トークンは決定論で、パスワード平文を含まない", async () => {
    const t1 = await passwordToken("testpass");
    const t2 = await passwordToken("testpass");
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(t1).not.toContain("testpass");
  });
});
