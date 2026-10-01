const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT === '0' ? 0 : parseInt(process.env.PORT, 10) || 4321;
const ROOT = path.join(__dirname, "deploy-local");
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

const server = http.createServer((req, res) => {
  if (proxy) {
    if (proxyModule.isAllowedApiPath(req.url)) return proxy.proxyHttp(req, res);
    // The Docker package serves /, /demo/* and static files. Kong's other
    // routes (Studio, metadata, analytics, etc.) must never reach its upstream.
    let pathname;
    try { pathname = decodeURIComponent(req.url.split('?')[0]); } catch { /* reject below */ }
    if (!pathname?.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(pathname) ||
        pathname.split('/').some((part) => part === '.' || part === '..')) {
      res.writeHead(404); res.end('Not found'); return;
    }
  }
  const url = decodeURIComponent(req.url.split("?")[0]);

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
  console.log("  Website:    http://localhost:" + listeningPort + "/");
  console.log("  LIVO App:   http://localhost:" + listeningPort + "/demo/");
  console.log("  Login:      http://localhost:" + listeningPort + "/demo/auth");
  console.log("");
  console.log("  Press Ctrl+C to stop.");
  console.log("");
});
