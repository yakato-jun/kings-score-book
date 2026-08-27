/** 仮公開用の共有パスワード入力。認証はmiddleware＋/api/auth(cookie)。 */
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string; next?: string }> }) {
  const sp = await searchParams;
  return (
    <div style={{ maxWidth: "22rem", margin: "3rem auto" }}>
      <h1>N-KINGS スコアブック</h1>
      <p className="muted">閲覧にはパスワードが必要です。</p>
      {sp.e && <p className="loss">パスワードが違います。</p>}
      <form method="post" action="/api/auth" className="adminform">
        <input type="hidden" name="next" value={sp.next ?? "/"} />
        <label>
          パスワード
          <input type="password" name="password" autoFocus required autoComplete="current-password" />
        </label>
        <div>
          <button>入る</button>
        </div>
      </form>
    </div>
  );
}
