/**
 * 全体パスワードゲート（仮公開・暫定）。認証cookieが無ければ /login へ。
 * /api は人間のリダイレクト先が無いので 401 JSON を返す。
 * 除外: /login, /api/auth(ログイン処理), Next静的アセット, favicon。
 */
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, isValidToken } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (await isValidToken(token)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  const login = new URL("/login", req.url);
  login.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  // /login と /api/auth と静的アセット以外の全パスをゲート
  matcher: ["/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)"],
};
