// Edge Functions main router (self-hosted Supabase edge-runtime).
// Kong strips /functions/v1/ → we receive /<function-name>[/...] and spawn the
// matching user worker from /home/deno/functions/<function-name>.
//
// Zero external imports (no deno.land / esm.sh) so the router boots offline —
// customer installs must not depend on third-party CDNs being reachable.
//
// JWT gate: only active when VERIFY_JWT=true (docker/.env FUNCTIONS_VERIFY_JWT;
// default false — each function does its own auth with the service-role client).

const JWT_SECRET = Deno.env.get("JWT_SECRET") ?? "";
const VERIFY_JWT = Deno.env.get("VERIFY_JWT") === "true";
const FUNCTIONS_DIR = "/home/deno/functions";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function verifyJWT(jwt: string): Promise<boolean> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, sig] = parts;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig),
      enc.encode(`${header}.${payload}`),
    );
    if (!ok) return false;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (typeof claims.exp === "number" && Date.now() / 1000 > claims.exp) return false;
    return true;
  } catch {
    return false;
  }
}

console.log("main router started (VERIFY_JWT=" + VERIFY_JWT + ")");

Deno.serve(async (req: Request) => {
  if (req.method !== "OPTIONS" && VERIFY_JWT) {
    const authHeader = req.headers.get("authorization") ?? "";
    const [bearer, token] = authHeader.split(" ");
    if (bearer !== "Bearer" || !token || !(await verifyJWT(token))) {
      return json({ msg: "Invalid JWT" }, 401);
    }
  }

  const pathname = new URL(req.url).pathname;
  const serviceName = pathname.split("/")[1];
  if (!serviceName) {
    return json({ msg: "missing function name in request" }, 400);
  }
  if (serviceName === "main" || !/^[A-Za-z0-9_-]+$/.test(serviceName)) {
    return json({ msg: `invalid function name: ${serviceName}` }, 400);
  }

  const servicePath = `${FUNCTIONS_DIR}/${serviceName}`;
  try {
    // deno-lint-ignore no-explicit-any
    const worker = await (globalThis as any).EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 150,
      // QA streams private evidence (up to 200 MB) without buffering it in
      // the user worker. Allow a slow download to finish before terminating it.
      workerTimeoutMs: serviceName === 'qa' ? 300_000 : 60_000,
      noModuleCache: false,
      importMapPath: null,
      envVars: Object.entries(Deno.env.toObject()),
    });
    return await worker.fetch(req);
  } catch (e) {
    console.error(`[main] failed to serve ${servicePath}:`, e);
    return json({ msg: String(e) }, 500);
  }
});
