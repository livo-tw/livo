#!/usr/bin/env node
// ============================================================
// LIVO 自架 Supabase - JWT 金鑰產生工具
// ============================================================
// 使用方式：node generate-keys.js
// 或：node generate-keys.js YOUR_CUSTOM_JWT_SECRET
//
// 執行後會輸出 .env 所需的三個金鑰值
// ============================================================

import crypto from 'crypto';

// 讀取命令列參數或自動產生 JWT_SECRET
const jwtSecret = process.argv[2] || crypto.randomBytes(40).toString('base64');

// 簡單的 base64url 編碼
function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// 手動產生 JWT（避免需要安裝 jsonwebtoken）
function signJWT(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${data}.${signature}`;
}

const now = Math.floor(Date.now() / 1000);
const fiveYears = 5 * 365 * 24 * 60 * 60;

const anonToken = signJWT(
  { role: 'anon', iss: 'supabase', iat: now, exp: now + fiveYears },
  jwtSecret
);

const serviceToken = signJWT(
  { role: 'service_role', iss: 'supabase', iat: now, exp: now + fiveYears },
  jwtSecret
);

const secretKeyBase = crypto.randomBytes(64).toString('base64').replace(/\n/g, '');

console.log('\n============================================================');
console.log('  LIVO 自架 Supabase 金鑰產生結果');
console.log('  請將以下內容填入 docker/.env');
console.log('============================================================\n');
console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`\nANON_KEY=${anonToken}`);
console.log(`\nSERVICE_ROLE_KEY=${serviceToken}`);
console.log(`\nSECRET_KEY_BASE=${secretKeyBase}`);
console.log('\n============================================================');
console.log('  ⚠️  注意：請妥善保管這些金鑰，不要外洩！');
console.log('  ⚠️  ANON_KEY 可以給前端使用（填入 .env 的 VITE_SUPABASE_PUBLISHABLE_KEY）');
console.log('  ⚠️  SERVICE_ROLE_KEY 有超級權限，絕對不可暴露給瀏覽器！');
console.log('============================================================\n');
