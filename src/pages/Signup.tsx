import { useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// Cloud-beta workspace signup — reached ONLY via the invite email link
// (/demo/signup?invite=<token>, minted by cloud-waitlist-approve). Cloud
// deployment only; self-host/local builds never link here. Copy is
// deliberately zh-Hant-only: beta invites are sent in Traditional Chinese
// and this page never appears in the other build flavors.

interface SignUpResult {
  data: { user: unknown; session: unknown };
  error: { message: string; code?: string } | null;
}

type SignUpFn = (params: {
  invite: string;
  password: string;
  workspaceName: string;
  displayName: string;
}) => Promise<SignUpResult>;

const inputCls =
  'w-full px-3 py-2.5 rounded-md text-sm border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';

const Signup = () => {
  const invite = useMemo(
    () => new URLSearchParams(window.location.search).get('invite') || '',
    []
  );
  const [workspaceName, setWorkspaceName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceName.trim()) { toast.error('請輸入團隊名稱'); return; }
    if (password.length < 8) { toast.error('密碼至少需要 8 碼'); return; }
    if (password !== password2) { toast.error('兩次輸入的密碼不一致'); return; }

    // signUpWithInvite exists only on the Cloudflare client (cloud builds).
    const signUp = (supabase.auth as unknown as { signUpWithInvite?: SignUpFn }).signUpWithInvite;
    if (!signUp) { toast.error('此版本不支援線上註冊'); return; }

    setLoading(true);
    // A leftover session (typically the public-demo login) must be cleared
    // first — the invite flow creates a brand-new identity, and SignupRoute
    // deliberately does NOT redirect while ?invite= is present.
    const { data: { session: existing } } = await supabase.auth.getSession();
    if (existing) await supabase.auth.signOut();

    const { error } = await signUp({
      invite,
      password,
      workspaceName: workspaceName.trim(),
      displayName: displayName.trim(),
    });
    if (error) {
      toast.error(error.message || '建立失敗，請稍後再試');
      setLoading(false);
      return;
    }
    // Navigate explicitly (full load drops ?invite= and picks up the fresh
    // session) — the route keeps rendering Signup while ?invite= is set, so
    // the reactive session redirect alone would not fire.
    window.location.assign(import.meta.env.BASE_URL);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm bg-card rounded-xl shadow-lg border border-border p-8">
        <div className="flex justify-center mb-1">
          <img src={`${import.meta.env.BASE_URL}livo-logo.png`} alt="LIVO" className="h-24 w-auto" />
        </div>

        {!invite ? (
          <div className="text-center">
            <p className="text-sm text-foreground font-medium mb-2">邀請連結無效</p>
            <p className="text-xs text-muted-foreground mb-5 leading-relaxed">
              建立雲端版 workspace 需要邀請連結（7 天有效）。
              請從邀請信裡的按鈕進入；連結過期可來信 service@livo-tw.com 重寄。
            </p>
            <a href="/pricing" className="text-xs text-primary hover:text-primary/80 transition-colors">
              還沒排隊？到定價頁申請雲端版 Beta →
            </a>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground text-center mb-6">
              建立你的雲端版 workspace（Beta 期間免費）
            </p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="su-ws" className="text-xs font-medium text-muted-foreground">團隊名稱</label>
                <input
                  id="su-ws"
                  type="text"
                  placeholder="例：小鹿設計工作室"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  className={inputCls}
                  maxLength={80}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="su-name" className="text-xs font-medium text-muted-foreground">你的名字（顯示名稱）</label>
                <input
                  id="su-name"
                  type="text"
                  placeholder="例：小鹿"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className={inputCls}
                  maxLength={40}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="su-pw" className="text-xs font-medium text-muted-foreground">設定密碼（至少 8 碼）</label>
                <input
                  id="su-pw"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="su-pw2" className="text-xs font-medium text-muted-foreground">再輸入一次密碼</label>
                <input
                  id="su-pw2"
                  type="password"
                  placeholder="••••••••"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  className={inputCls}
                  autoComplete="new-password"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                className="w-full py-2.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading && (
                  <svg className="animate-spin w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {loading ? '建立中…' : '建立我的 workspace'}
              </button>
            </form>
            <p className="mt-4 text-center text-[11px] text-muted-foreground leading-relaxed">
              建立即表示同意 <a href="/beta-terms" target="_blank" rel="noreferrer" className="underline hover:text-foreground">雲端版 Beta 條款</a>。
              已經有帳號？<a href="/demo/auth" className="underline hover:text-foreground">直接登入</a>
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default Signup;
