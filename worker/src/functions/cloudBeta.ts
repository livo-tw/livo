// Cloud beta signup funnel (CLOUD-BETA-DESIGN.md) — AUTO-APPROVE.
//
// Routes (index.ts):
//   POST /api/functions/cloud-waitlist          — PUBLIC 官網 pricing-page form.
//                                                 Sends the ACTIVATION (invite)
//                                                 email immediately: the invite
//                                                 link doubles as email
//                                                 verification, so no seller
//                                                 action is needed. Seller gets
//                                                 an FYI email with a manual
//                                                 resend link.
//   GET  /api/functions/cloud-waitlist-approve  — seller one-click MANUAL
//                                                 RESEND (HMAC-signed link;
//                                                 fulfill-link pattern)
// Exports for auth.ts signup:
//   verifyInviteToken(env, token) → lowercased email | null
//   markWaitlistJoined(env, email, wsId) — best-effort bookkeeping
//
// Invite token: base64url(`${email}|${expMs}`) + '.' + HMAC-SHA256-hex32
// keyed on JWT_SECRET with a 'cloud-signup:' domain prefix. 7-day expiry.
// Abuse posture: honeypot field + IP cap on NEW leads + a per-email resend
// throttle (re-submitting the form re-sends the link at most every 10 min,
// so the form can't be used to bomb someone's inbox).

import type { Context } from 'hono';
import type { AppContext, Env } from '../env';
import { appBaseUrl, apiBaseUrl } from '../env';
import { signLink, verifyLink } from '../linkSigning';

const INVITE_TTL_MS = 7 * 24 * 3_600_000;
const IP_CAP_24H = 8; // trial.ts pattern: soft cap per IP per rolling 24h
const RESEND_THROTTLE_MS = 10 * 60_000; // repeat form submits re-send at most every 10 min

// ─── Crypto helpers (full-width HMAC, not the 8-hex license signature) ─────

async function hmacHex32(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += sig[i]!.toString(16).padStart(2, '0');
  return hex;
}

function timingSafeEqStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const toB64Url = (s: string): string =>
  btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

function fromB64Url(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    return decodeURIComponent(escape(atob(b64)));
  } catch {
    return null;
  }
}

// ─── Invite tokens ─────────────────────────────────────────────────────────

async function signInviteToken(env: Env, email: string, expMs: number): Promise<string> {
  const payload = `${email.toLowerCase()}|${expMs}`;
  const sig = await hmacHex32(env.JWT_SECRET, `cloud-signup:${payload}`);
  return `${toB64Url(payload)}.${sig}`;
}

/** Lowercased email when the token is authentic and unexpired, else null. */
export async function verifyInviteToken(env: Env, token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const dot = token.lastIndexOf('.');
  const payload = fromB64Url(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!payload) return null;
  const expected = await hmacHex32(env.JWT_SECRET, `cloud-signup:${payload}`);
  if (!timingSafeEqStr(sig, expected)) return null;
  const bar = payload.lastIndexOf('|');
  if (bar <= 0) return null;
  const email = payload.slice(0, bar).toLowerCase();
  const exp = Number(payload.slice(bar + 1));
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  if (!/@.*\./.test(email)) return null;
  return email;
}

/** Signed payload of the approve link (seller notify email → one-click GET).
 *  The signature itself comes from linkSigning.ts (32 hex chars). */
const approvePayload = (email: string): string => `cloud-approve:${email.toLowerCase()}`;

export async function markWaitlistJoined(env: Env, email: string, wsId: string): Promise<void> {
  try {
    await env.DB.prepare(
      "UPDATE cloud_waitlist SET status = 'joined', joined_workspace_id = ? WHERE email = ? COLLATE NOCASE"
    ).bind(wsId, email).run();
  } catch {
    /* bookkeeping only */
  }
}

// ─── Email helpers (trial.ts Resend pattern) ───────────────────────────────

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.error('[cloud-waitlist] RESEND_API_KEY not set — email skipped:', subject);
    return false;
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL ?? 'service@livo-tw.com',
        to: [to],
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      console.error('[cloud-waitlist] Resend failed:', resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[cloud-waitlist] Resend error:', err);
    return false;
  }
}

function emailShell(inner: string): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LIVO 雲端版</title></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Noto Sans TC',sans-serif;color:#0F172A">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#0D9488,#0F766E);padding:36px 40px;text-align:center">
    <h1 style="margin:0;font-size:26px;font-weight:900;color:#fff;letter-spacing:-.5px">LIVO</h1>
    <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,.8)">雲端版 Beta</p>
  </div>
  <div style="padding:40px">${inner}</div>
  <div style="background:#F8FAFC;padding:20px 40px;border-top:1px solid #E2E8F0;text-align:center">
    <p style="font-size:12px;color:#94A3B8;margin:0">© 2026 LIVO · <a href="https://livo-tw.com" style="color:#94A3B8">livo-tw.com</a></p>
  </div>
</div>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── The activation (invite) email — shared by auto-approve and the seller's
//     manual resend link ──────────────────────────────────────────────────────

async function sendInviteEmail(
  env: Env,
  email: string
): Promise<{ sent: boolean; signupUrl: string }> {
  const exp = Date.now() + INVITE_TTL_MS;
  const token = await signInviteToken(env, email, exp);
  const signupUrl = `${appBaseUrl(env)}/demo/signup?invite=${encodeURIComponent(token)}`;

  const sent = await sendEmail(
    env,
    email,
    '你的 LIVO 雲端版開通連結（7 天內有效）',
    emailShell(`
    <h2 style="font-size:20px;font-weight:700;margin:0 0 8px">開通你的 LIVO 雲端版 workspace</h2>
    <p style="color:#64748B;margin:0 0 24px;line-height:1.7">
      點下方按鈕建立你的團隊（設定密碼與團隊名稱，約 2 分鐘）。<br>
      Beta 期間<strong>完全免費</strong>：單一團隊 10 人、500MB 附件空間、功能與自架版相同。
    </p>
    <p style="margin:0 0 24px">
      <a href="${signupUrl}" style="display:inline-block;background:#0D9488;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">建立我的 workspace →</a>
    </p>
    <p style="color:#94A3B8;margin:0 0 16px;font-size:12px;line-height:1.7">按鈕無法點擊時，複製這個連結到瀏覽器：<br><span style="word-break:break-all">${esc(signupUrl)}</span></p>
    <p style="color:#64748B;margin:0;font-size:13px;line-height:1.7">
      連結 7 天內有效；過期只要回到定價頁重新留一次 Email 就會再寄。有任何問題，回覆這封信或加 LINE <strong>@321oxwbw</strong>。— Lingye
    </p>`)
  );
  return { sent, signupUrl };
}

// ─── POST /api/functions/cloud-waitlist (PUBLIC) ───────────────────────────

function clientIp(c: Context<AppContext>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    ''
  );
}

export const handleCloudWaitlist = async (c: Context<AppContext>): Promise<Response> => {
  const env = c.env;
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: unknown; name?: unknown; team_size?: unknown; website?: unknown;
    };

    // Honeypot: bots fill the hidden "website" field — pretend success.
    if (typeof body.website === 'string' && body.website.trim() !== '') {
      return c.json({ ok: true });
    }

    const email = (body.email ?? '').toString().toLowerCase().trim();
    if (!email || !/@.*\./.test(email)) {
      return c.json({ ok: false, error: '請輸入有效的 Email 地址' }, 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : null;
    const teamSize = typeof body.team_size === 'string' ? body.team_size.trim().slice(0, 40) : null;
    const ip = clientIp(c);

    const existing = await env.DB.prepare(
      'SELECT status, invited_at FROM cloud_waitlist WHERE email = ? COLLATE NOCASE'
    ).bind(email).first<{ status: string; invited_at: string | null }>();

    // Already has a workspace — nothing to send (the signup page tells a
    // returning owner to just log in; we don't leak account existence here).
    if (existing?.status === 'joined') return c.json({ ok: true });

    // Per-email resend throttle: re-submitting the public form re-sends the
    // activation link at most once per window (inbox-bombing guard).
    if (
      existing?.invited_at &&
      Date.now() - Date.parse(existing.invited_at) < RESEND_THROTTLE_MS
    ) {
      return c.json({ ok: true });
    }

    if (!existing) {
      if (ip) {
        const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
        const cnt = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM cloud_waitlist WHERE ip = ? AND created_at >= ?'
        ).bind(ip, since).first<{ n: number }>();
        if ((cnt?.n ?? 0) >= IP_CAP_24H) {
          return c.json({ ok: false, error: '申請過於頻繁，請稍後再試。' }, 429);
        }
      }
      await env.DB.prepare(
        `INSERT INTO cloud_waitlist (email, name, team_size, ip, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(email) DO NOTHING`
      ).bind(email, name, teamSize, ip || null, new Date().toISOString()).run();
    }

    // AUTO-APPROVE: the activation link goes out immediately — receiving it
    // in the mailbox IS the verification step, no seller action required.
    await sendInviteEmail(env, email);
    await env.DB.prepare(
      "UPDATE cloud_waitlist SET status = 'invited', invited_at = ? WHERE email = ? COLLATE NOCASE"
    ).bind(new Date().toISOString(), email).run();

    // Seller FYI (new leads only) with a manual resend link for support cases.
    if (!existing && env.SELLER_NOTIFY_EMAIL) {
      // The invite already went out, so a missing signing secret only drops
      // the resend button from this FYI; it must not fail the form.
      const sig = await signLink(env, approvePayload(email), 32).catch((e) => {
        console.error('[cloud-waitlist] resend link not signed:', e);
        return null;
      });
      const resendUrl = sig
        ? `${apiBaseUrl(env)}/api/functions/cloud-waitlist-approve?email=${encodeURIComponent(email)}&sig=${sig}`
        : null;
      c.executionCtx.waitUntil(
        sendEmail(
          env,
          env.SELLER_NOTIFY_EMAIL,
          `雲端版 Beta 自動開通 +1：${email}`,
          emailShell(`
    <h2 style="font-size:20px;font-weight:700;margin:0 0 8px">新的雲端版 Beta 申請（開通連結已自動寄出）</h2>
    <p style="color:#334155;margin:0 0 20px;line-height:1.9">
      Email：<strong>${esc(email)}</strong><br>
      ${name ? `稱呼：${esc(name)}<br>` : ''}
      ${teamSize ? `團隊規模：${esc(teamSize)}<br>` : ''}
      不需要任何操作——對方點信中連結即可自行建立 workspace。
    </p>
    ${resendUrl ? `<p style="margin:0 0 20px">
      <a href="${resendUrl}" style="display:inline-block;background:#64748B;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">手動重寄開通連結（客服用）→</a>
    </p>` : ''}
    <p style="color:#94A3B8;margin:0;font-size:12px;line-height:1.7">連結 7 天有效；對方也可以自己回定價頁重留 Email 重寄（每 10 分鐘最多一次）。</p>`)
        ).then(() => undefined)
      );
    }

    return c.json({ ok: true });
  } catch (e) {
    console.error('[cloud-waitlist] error:', e);
    return c.json({ ok: false, error: '系統忙碌，請稍後再試。' }, 500);
  }
};

// ─── GET /api/functions/cloud-waitlist-approve (seller one-click) ──────────

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Noto Sans TC',sans-serif;background:#F8FAFC;color:#0F172A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:40px;max-width:480px;text-align:center">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
<p style="color:#64748B;line-height:1.8;margin:0">${body}</p>
</div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export const handleCloudWaitlistApprove = async (c: Context<AppContext>): Promise<Response> => {
  const env = c.env;
  try {
    const email = (c.req.query('email') || '').toLowerCase().trim();
    const sig = c.req.query('sig') || '';
    if (!email || !sig) return htmlPage('連結無效', '缺少參數。', 400);
    if (!(await verifyLink(env, approvePayload(email), sig, 32))) {
      return htmlPage('連結無效', '簽名驗證失敗。', 403);
    }

    const row = await env.DB.prepare(
      'SELECT email, status FROM cloud_waitlist WHERE email = ? COLLATE NOCASE'
    ).bind(email).first<{ email: string; status: string }>();
    if (!row) {
      // Approve can be used directly for out-of-band invites too — register the lead.
      await env.DB.prepare(
        "INSERT OR IGNORE INTO cloud_waitlist (email, status, created_at) VALUES (?, 'pending', ?)"
      ).bind(email, new Date().toISOString()).run();
    }
    if (row?.status === 'joined') {
      return htmlPage('此用戶已開通', `${esc(email)} 已經建立過 workspace，不需再邀請。`);
    }

    // Manual resend (support path — the public form auto-sends since the
    // auto-approve change; this link bypasses the per-email throttle).
    const { sent, signupUrl } = await sendInviteEmail(env, email);

    await env.DB.prepare(
      "UPDATE cloud_waitlist SET status = 'invited', invited_at = ? WHERE email = ? COLLATE NOCASE"
    ).bind(new Date().toISOString(), email).run();

    return htmlPage(
      sent ? '開通連結已寄出' : '連結已產生（但寄信失敗）',
      sent
        ? `已寄開通連結給 <strong>${esc(email)}</strong>（7 天有效）。重複點擊可再寄。`
        : `寄信失敗（檢查 RESEND_API_KEY）。可手動把註冊連結傳給對方：<br><span style="word-break:break-all">${esc(signupUrl)}</span>`
    );
  } catch (e) {
    console.error('[cloud-waitlist-approve] error:', e);
    return htmlPage('發生錯誤', '請稍後再試。', 500);
  }
};
