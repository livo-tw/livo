const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function genericTaskOg(req: Request, appUrl: string): Response {
  let target: URL;
  try {
    target = new URL(appUrl);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('invalid_app_url');
  } catch { target = new URL('https://livo-tw.com'); }
  target.search = ''; target.hash = '';
  const task = new URL(req.url).searchParams.get('task');
  if (task && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(task)) target.searchParams.set('task', task);
  const url = html(target.href);
  return new Response(`<!doctype html><html><head><meta charset="utf-8">
<title>LIVO 任務</title><meta property="og:title" content="LIVO 任務">
<meta property="og:description" content="登入 LIVO 以檢視此任務">
<meta property="og:type" content="website"><meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="LIVO 任務">
<meta name="twitter:description" content="登入 LIVO 以檢視此任務">
<meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="0;url=${url}">
</head><body><a href="${url}">登入 LIVO 以檢視此任務</a></body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
  });
}
