import { describe, expect, it } from 'vitest';
import { verifyQaSlackSignature } from '../src/qaSlack';

describe('Cloud Slack request authentication',()=>{
  it('validates exact raw bytes, rejects expired or altered requests',async()=>{
    const secret='test-signing-secret',timestamp='1780000000',body='command=%2Flivo&text=bug';
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const hash=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`v0:${timestamp}:${body}`)));
    const signature='v0='+[...hash].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    expect(await verifyQaSlackSignature(secret,timestamp,signature,body,Number(timestamp)*1000)).toBe(true);
    expect(await verifyQaSlackSignature(secret,timestamp,signature,body+'x',Number(timestamp)*1000)).toBe(false);
    expect(await verifyQaSlackSignature(secret,timestamp,signature,body,(Number(timestamp)+301)*1000)).toBe(false);
  });
});
