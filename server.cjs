const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT === '0' ? 0 : parseInt(process.env.PORT, 10) || 4321;
const ROOT = path.join(__dirname, "deploy-local");
// The Docker package serves the app itself at the site root (its files stay in
// demo/ on disk) and redirects old /demo/ links there; build-release.mjs turns
// this on. The local package keeps the website at / and the app under /demo/.
const APP_AT_ROOT = process.env.LIVO_APP_AT_ROOT === "1";
// Outside Docker this remains a standalone static server, with no helper needed.
const proxyModule = process.env.LIVO_API_UPSTREAM ? require('./server-proxy.cjs') : null;
const proxy = proxyModule?.createApiProxy(process.env.LIVO_API_UPSTREAM);

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".webmanifest": "application/manifest+json",
};

function serve(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || "application/octet-stream";
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch {
    return false;
  }
  return true;
}

// Links from before the app moved to the root (bookmarks, Slack messages,
// invitation emails) keep working. 302, not 301: a cached permanent redirect
// would trap anyone who rolls back to a package that still uses /demo/.
function redirectOldAppPath(req, res) {
  const old = /^\/demo(?=\/|\?|$)(.*)$/s.exec(req.url);
  if (!old) return false;
  // Collapse leading slashes so /demo//example.com cannot leave this host.
  res.writeHead(302, { Location: "/" + old[1].replace(/^\/+/, "") });
  res.end();
  return true;
}

// An explicitly configured HTTPS origin upgrades historical page links.
// The host setting is deployment data; no customer domain is embedded here.
const CANONICAL_APP = (() => {
  try {
    const value = new URL(process.env.APP_BASE_URL || '');
    if (value.protocol !== 'https:' || value.username || value.password || value.pathname !== '/' || value.search || value.hash) return null;
    return value;
  } catch { return null; }
})();
function redirectCanonicalApp(req, res) {
  if (!APP_AT_ROOT || !CANONICAL_APP || !['GET', 'HEAD'].includes(req.method) || !/text\/html/i.test(req.headers.accept || '')) return false;
  if ((req.headers.host || '').toLowerCase() === CANONICAL_APP.host.toLowerCase()) return false;
  let target;
  try { target = new URL(req.url, 'http://localhost'); } catch {
    res.writeHead(404); res.end('Not found'); return true;
  }
  if (/^\/(?:rest|functions|storage|realtime)\/v1(?:\/|$)|^\/auth\/v1(?:\/|$)|^\/(?:health|healthz|ready)(?:\/|$)/.test(target.pathname)) return false;
  const appPath = target.pathname.replace(/^\/demo(?=\/|$)/, '').replace(/^\/+/, '');
  res.writeHead(302, { Location: CANONICAL_APP.origin + '/' + appPath + target.search });
  res.end();
  return true;
}

function serveAppAtRoot(req, res, url) {
  if (redirectOldAppPath(req, res)) return;
  const appDir = path.join(ROOT, "demo");
  const filePath = path.join(appDir, url);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile() && serve(res, filePath)) return;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory() &&
      serve(res, path.join(filePath, "index.html"))) return;
  // Other page requests are client-side routes such as /auth or /set-password.
  // A missing script or image, or any non-page request (/pg/meta and the like),
  // gets a 404 instead of the page.
  const pageRequest = (req.method === "GET" || req.method === "HEAD") &&
    /text\/html/i.test(req.headers.accept || "");
  if (pageRequest && serve(res, path.join(appDir, "index.html"))) return;
  res.writeHead(404);
  res.end("Not found");
}

const server = http.createServer((req, res) => {
  if (proxy && proxyModule.isAllowedApiPath(req.url)) return proxy.proxyHttp(req, res);
  if (proxy || APP_AT_ROOT) {
    // The Docker package serves the app and its static files. Kong's other
    // routes (Studio, metadata, analytics, etc.) must never reach its upstream.
    let pathname;
    try { pathname = decodeURIComponent(req.url.split('?')[0]); } catch { /* reject below */ }
    if (!pathname?.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(pathname) ||
        pathname.split('/').some((part) => part === '.' || part === '..')) {
      res.writeHead(404); res.end('Not found'); return;
    }
  }
  if (redirectCanonicalApp(req, res)) return;
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (APP_AT_ROOT) return serveAppAtRoot(req, res, url);

  // Try serving the exact static file first
  const filePath = path.join(ROOT, url);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serve(res, filePath);
    return;
  }

  // If path is a directory, try index.html inside it
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const idx = path.join(filePath, "index.html");
    if (fs.existsSync(idx)) { serve(res, idx); return; }
  }

  // Browsers ask the origin root for /favicon.ico on pages that declare no
  // icon, such as an attachment image opened in its own tab. Use the app's.
  if (url === "/favicon.ico" && serve(res, path.join(ROOT, "demo", "favicon.ico"))) return;

  // SPA fallback: /demo/* -> /demo/index.html, everything else -> /index.html
  if (url.startsWith("/demo/") || url === "/demo") {
    serve(res, path.join(ROOT, "demo", "index.html"));
  } else if (proxy && url !== '/') {
    res.writeHead(404);
    res.end('Not found');
  } else {
    serve(res, path.join(ROOT, "index.html"));
  }
});
if (proxy) {
  server.requestTimeout = 0;
  server.on('upgrade', proxy.proxyUpgrade);
}
server.listen(PORT, () => {
  const listeningPort = server.address().port;
  console.log("");
  console.log("  LIVO Local Server running!");
  console.log("");
  const appPath = APP_AT_ROOT ? "/" : "/demo/";
  if (!APP_AT_ROOT) console.log("  Website:    http://localhost:" + listeningPort + "/");
  console.log("  LIVO App:   http://localhost:" + listeningPort + appPath);
  console.log("  Login:      http://localhost:" + listeningPort + appPath + "auth");
  console.log("");
  console.log("  Press Ctrl+C to stop.");
  console.log("");
});
