/**
 * 仮公開用の共有パスワードゲート（暫定）。パスワードを知っていればフルアクセス。
 * 将来のユーザー管理(LINE申請式＋簡易ロール, §7)が入ったら置き換える。
 * cookie値 = SHA-256(パスワード) ＝ パスワードを変えると全端末のセッションが自動失効する。
 * middleware(Edge)とroute(Node)の両方で動くよう Web Crypto (crypto.subtle) を使う。
 */
export const AUTH_COOKIE = "kings-auth";
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 90; // 90日

export function sitePassword(): string {
  const p = process.env.SITE_PASSWORD;
  // 既定値は持たない: リポジトリは公開なので、コードに既定パスワードを置く=パスワードを公開するのと同義。
  // 未設定は fail-closed(誰も通さない)で明示的に落とす。本番は Secret Manager の SITE_PASSWORD を注入する。
  if (!p) throw new Error("SITE_PASSWORD が未設定です(既定値はありません。環境変数/Secret で設定してください)");
  return p;
}

export async function passwordToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`kings-score-book:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** cookieの値が現在のパスワードに対応するか */
export async function isValidToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  return token === (await passwordToken(sitePassword()));
}
