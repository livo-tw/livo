// ============================================================
// LIVO installer helper: generate per-install secrets.
//
// Runs inside a one-shot container (Docker is guaranteed present
// at install time), fed via stdin so no volume mount is needed:
//
//   docker run --rm -i node:20-alpine node - < installer/generate-keys.js
//
// Prints a single-line JSON object on stdout:
//   { JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY,
//     POSTGRES_PASSWORD, DASHBOARD_PASSWORD,
//     SECRET_KEY_BASE, VAULT_ENC_KEY, PG_META_CRYPTO_KEY,
//     LOGFLARE_PUBLIC_ACCESS_TOKEN, LOGFLARE_PRIVATE_ACCESS_TOKEN,
//     S3_PROTOCOL_ACCESS_KEY_ID, S3_PROTOCOL_ACCESS_KEY_SECRET }
// (the last seven are the service-internal keys; the S3 pair unlocks the
// storage S3 endpoint behind Kong, so it must never stay at a known value)
//
// No external dependencies (node:crypto only). Keep this file pure
// ASCII: install.ps1 pipes it through a Windows PowerShell 5.1 pipe
// whose default encoding would mangle non-ASCII bytes.
//
// Value shapes are chosen so the install scripts can patch them into
// docker/.env and the prebuilt frontend bundle with plain string
// replacement (no characters that are special to sed / regex / YAML /
// connection-string URLs):
//   - JWT_SECRET:        64 hex chars
//   - *_KEY:             HS256 JWTs (base64url + dots)
//   - *_PASSWORD:        alphanumeric only (POSTGRES_PASSWORD is embedded
//                        in postgres:// URLs by docker-compose.yml)
//   - everything else:   hex, at the lengths the services expect
//                        (SECRET_KEY_BASE >= 64 chars; VAULT_ENC_KEY and
//                        PG_META_CRYPTO_KEY 32 chars)
// ============================================================
'use strict';

const crypto = require('crypto');

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

// 64 hex chars (32 random bytes) - comfortably above the 40-char minimum.
const jwtSecret = crypto.randomBytes(32).toString('hex');

const now = Math.floor(Date.now() / 1000);
const exp = now + 10 * 365 * 24 * 60 * 60; // ~10 years

// Supabase-convention HS256 JWT.
// NOTE: "role" MUST stay the FIRST payload key. The installers locate the
// anon key embedded in the prebuilt frontend bundle by the stable base64url
// prefix eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiI
// ({"alg":"HS256","typ":"JWT"} . {"role":"anon"...), which only holds while
// the key order is preserved. This keeps re-rotation self-healing.
function signHS256(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(
    crypto.createHmac('sha256', jwtSecret).update(header + '.' + body).digest()
  );
  return header + '.' + body + '.' + sig;
}

// Alphanumeric password (no look-alike 0/O/1/l/I). The tiny modulo bias is
// irrelevant at these lengths.
function randPassword(len) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// `bytes` random bytes as hex (2 chars per byte).
function hex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

process.stdout.write(
  JSON.stringify({
    JWT_SECRET: jwtSecret,
    ANON_KEY: signHS256({ role: 'anon', iss: 'supabase', iat: now, exp: exp }),
    SERVICE_ROLE_KEY: signHS256({ role: 'service_role', iss: 'supabase', iat: now, exp: exp }),
    POSTGRES_PASSWORD: randPassword(32),
    DASHBOARD_PASSWORD: randPassword(20),
    SECRET_KEY_BASE: hex(32),
    VAULT_ENC_KEY: hex(16),
    PG_META_CRYPTO_KEY: hex(16),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: hex(16),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: hex(16),
    S3_PROTOCOL_ACCESS_KEY_ID: hex(16),
    S3_PROTOCOL_ACCESS_KEY_SECRET: hex(32)
  }) + '\n'
);
