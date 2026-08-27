/** ログイン処理: パスワード照合→認証cookie(パスワードのハッシュ)を設定してリダイレクト。 */
import { NextResponse } from "next/server";
import { AUTH_COOKIE, COOKIE_MAX_AGE, passwordToken, sitePassword } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const form = await req.formData();
  const pw = String(form.get("password") ?? "");
  const rawNext = String(form.get("next") ?? "/");
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/"; // open redirect防止(同一サイトのパスのみ)
  // リダイレクト先はクライアントが実際に使ったホストで組む(req.urlはdevの-H 0.0.0.0でホストが0.0.0.0になり届かない)
  const origin = `${req.headers.get("x-forwarded-proto") ?? "http"}://${req.headers.get("host") ?? new URL(req.url).host}`;
  if (pw !== sitePassword()) {
    const back = new URL("/login", origin);
    back.searchParams.set("e", "1");
    back.searchParams.set("next", next);
    return NextResponse.redirect(back, 303);
  }
  const res = NextResponse.redirect(new URL(next, origin), 303);
  res.cookies.set(AUTH_COOKIE, await passwordToken(pw), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    // 本番(HTTPS/Cloud Run=NODE_ENV=production)では secure を付与。
    //   dev(Tailscale 経由 http の next dev=development)では付けない＝そこでもログイン可能に保つ。
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
