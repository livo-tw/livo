const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT, 10) || 4321;
const ROOT = path.join(__dirname, "deploy-local");

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

http.createServer((req, res) => {
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
  } else {
    serve(res, path.join(ROOT, "index.html"));
  }
}).listen(PORT, () => {
  console.log("");
  console.log("  LIVO Local Server running!");
  console.log("");
  console.log("  Website:    http://localhost:" + PORT + "/");
  console.log("  LIVO App:   http://localhost:" + PORT + "/demo/");
  console.log("  Login:      http://localhost:" + PORT + "/demo/auth");
  console.log("");
  console.log("  Press Ctrl+C to stop.");
  console.log("");
});
