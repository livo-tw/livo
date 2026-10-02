// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { hashPassword, registerAuthRoutes, requireMember, sha256Hex } from '../src/auth';
import { finishLoginAttempt, loginIpBucket, loginSourceIp, pruneLoginAttempts, reserveLoginAttempt } from '../src/loginThrottle';
import type { AppContext, Env } from '../src/env';
import { TABLES } from '../src/tables';

describe('login throttle with real SQLite transactions and auth routes',()=>{
  let db:DatabaseSync, env:Env, app:Hono<AppContext>, now:number, passwordHash:string;
  let failStatement:((sql:string)=>boolean)|undefined;
  beforeAll(async()=>{passwordHash=await hashPassword('correct-password');});
  beforeEach(()=>{
    now=Date.parse('2026-10-02T00:00:00.000Z');vi.spyOn(Date,'now').mockImplementation(()=>now);
    db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
    failStatement=undefined;
    const statement=(sql:string,args:unknown[]=[])=>({
      bind:(...values:unknown[])=>statement(sql,values),
      first:async()=>db.prepare(sql).get(...args as never[])??null,
      all:async()=>({results:db.prepare(sql).all(...args as never[]),success:true}),
      run:async()=>({success:true,meta:{changes:Number(db.prepare(sql).run(...args as never[]).changes)}}),
      execute:()=>{if(failStatement?.(sql))throw Error('simulated D1 error');return {results:db.prepare(sql).all(...args as never[]),success:true};},
    });
    env={DB:{prepare:(sql:string)=>statement(sql),batch:async(stmts:Array<{execute:()=>unknown}>)=>{
      db.exec('BEGIN');try{const results=stmts.map(s=>s.execute());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}
    }},JWT_SECRET:'fixture-only-jwt-secret-at-least-thirty-two-characters'} as unknown as Env;
    db.prepare('INSERT INTO auth_users(id,email,password_hash) VALUES(?,?,?)').run('auth-a','person@example.com',passwordHash);
    db.prepare('INSERT INTO auth_users(id,email,password_hash,banned) VALUES(?,?,?,1)').run('auth-b','banned@example.com',passwordHash);
    db.prepare('INSERT INTO auth_users(id,email) VALUES(?,?)').run('auth-c','hashless@example.com');
    db.exec("INSERT INTO members(id,workspace_id,auth_id,name,avatar,email,role,is_active) VALUES('member-a','ws-a','auth-a','Person','','person@example.com','member',1)");
    app=new Hono<AppContext>();registerAuthRoutes(app);
    app.get('/private',requireMember,c=>c.json({workspace:c.get('auth')?.member.workspaceId}));
  });
  afterEach(()=>{db.close();vi.restoreAllMocks();});
  const count=(table:string)=>Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  const row=(key:string)=>db.prepare('SELECT * FROM auth_login_attempts WHERE key=?').get(key);
  const login=(email='person@example.com',password='wrong',extra:Record<string,unknown>={},ip:string|undefined='203.0.113.8',url='https://api.example.com/api/auth/login')=>
    app.request(new Request(url,{method:'POST',headers:{'Content-Type':'application/json',...(ip?{'CF-Connecting-IP':ip}:{}),'X-Forwarded-For':'198.51.100.99'},body:JSON.stringify({email,password,...extra})}),undefined,env);
  async function hold(email:string,ip:string|null='203.0.113.8'){
    const result=await reserveLoginAttempt(env,email,ip);expect(result.locked).toBe(false);
    if(result.locked)throw Error('reservation denied');return result.id;
  }
  async function fail(email:string,ip:string|null='203.0.113.8'){
    expect(await finishLoginAttempt(env,await hold(email,ip),'failure')).toBe(true);
  }

  it('locks only after five confirmed email failures, emits 429 and unlocks after 15 minutes',async()=>{
    for(let i=0;i<5;i++){
      const response=await login();expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({user:null,session:null,error:{message:'Invalid login credentials'}});
    }
    const locked=await login('person@example.com','correct-password');expect(locked.status).toBe(429);
    expect(locked.headers.get('Retry-After')).toBe('900');expect(await locked.json()).toMatchObject({error:{code:'over_request_rate_limit'}});
    const lock=row('email:person@example.com')?.locked_until;now+=60_000;await login();expect(row('email:person@example.com')?.locked_until).toBe(lock);
    now+=14*60_000+1;const response=await login('person@example.com','correct-password');expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({error:null,user:{email:'person@example.com'}});expect(row('email:person@example.com')?.failures).toBe(0);
  });
  it('locks IP after 20 failures across emails without growing email rows on blocked requests',async()=>{
    for(let i=0;i<20;i++)await fail(`unknown${i}@example.com`);
    const before=count('auth_login_attempts');
    for(let i=0;i<100;i++)expect(await reserveLoginAttempt(env,`blocked${i}@example.com`,'203.0.113.8')).toEqual({locked:true,retryAfterS:900});
    expect(count('auth_login_attempts')).toBe(before);expect(count('auth_login_reservations')).toBe(0);
    expect((await login('fresh@example.com')).status).toBe(429);
  });
  it('admits at most 20 concurrent KDF slots and never hard-locks 19 successes plus one failure',async()=>{
    const results=await Promise.all(Array.from({length:100},(_,i)=>reserveLoginAttempt(env,`parallel${i}@example.com`,'203.0.113.8')));
    const accepted=results.filter((r):r is {locked:false;id:string}=>!r.locked);expect(accepted).toHaveLength(20);
    expect(results.filter(r=>r.locked)).toHaveLength(80);expect(count('auth_login_attempts')).toBe(21);
    expect(results[99]).toEqual({locked:true,retryAfterS:1});
    await finishLoginAttempt(env,accepted[19].id,'failure');
    for(const result of accepted.slice(0,19))await finishLoginAttempt(env,result.id,'success');
    expect(row('ip:203.0.113.8')).toMatchObject({failures:1,locked_until:null});
    expect((await reserveLoginAttempt(env,'next@example.com','203.0.113.8')).locked).toBe(false);
  });
  it('limits simultaneous attempts for one email even with distinct IPs',async()=>{
    const results=await Promise.all(Array.from({length:30},(_,i)=>reserveLoginAttempt(env,'person@example.com',`203.0.113.${i}`)));
    expect(results.filter(r=>!r.locked)).toHaveLength(5);expect(count('auth_login_reservations')).toBe(5);
  });
  it('clears successful email failures while preserving other in-flight leases, and settles once',async()=>{
    const early=await hold('person@example.com'),late=await hold('person@example.com');
    await finishLoginAttempt(env,early,'failure');expect(row('email:person@example.com')?.failures).toBe(1);
    const concurrent=await hold('person@example.com');await finishLoginAttempt(env,late,'success');
    expect(row('email:person@example.com')?.failures).toBe(0);expect(count('auth_login_reservations')).toBe(1);
    expect(await finishLoginAttempt(env,concurrent,'failure')).toBe(true);
    expect(await finishLoginAttempt(env,concurrent,'failure')).toBe(false);
    expect(row('email:person@example.com')?.failures).toBe(1);expect(row('ip:203.0.113.8')?.failures).toBe(2);
  });
  it('ignores old-window settlements without deleting or reducing new-window counters',async()=>{
    await fail('person@example.com');now+=14*60_000+59_000;const old=await hold('person@example.com');
    now+=2_000;await fail('person@example.com');const current=row('email:person@example.com');
    expect(await finishLoginAttempt(env,old,'success')).toBe(true);
    expect(row('email:person@example.com')).toEqual(current);expect(row('ip:203.0.113.8')?.failures).toBe(1);
  });
  it('expires abandoned leases, prevents late success, and can cancel without counting a failure',async()=>{
    const old=await hold('person@example.com');now+=2*60_000+1;
    const current=await hold('person@example.com');expect(await finishLoginAttempt(env,old,'success')).toBe(false);
    expect(await finishLoginAttempt(env,current,'cancel')).toBe(true);expect(row('email:person@example.com')?.failures).toBe(0);
    expect(count('auth_login_reservations')).toBe(0);
  });
  it('rolls back partially reserved keys on store errors and never logs in without the schema',async()=>{
    failStatement=sql=>sql.startsWith('INSERT INTO auth_login_reservations');
    await expect(reserveLoginAttempt(env,'person@example.com','203.0.113.8')).rejects.toThrow('simulated D1');
    expect(count('auth_login_attempts')).toBe(0);failStatement=undefined;
    db.exec('DROP TABLE auth_login_reservations');const error=vi.spyOn(console,'error').mockImplementation(()=>{});
    const response=await login('person@example.com','correct-password');expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({session:null,error:{code:'auth_unavailable'}});expect(error).toHaveBeenCalled();
    expect(count('auth_refresh_tokens')).toBe(0);
  });
  it('uses identical responses and counters for unknown, banned and hashless identities',async()=>{
    const bodies:unknown[]=[];for(const email of ['person@example.com','missing@example.com','banned@example.com','hashless@example.com']){
      const response=await login(email);expect(response.status).toBe(200);bodies.push(await response.json());expect(row(`email:${email}`)?.failures).toBe(1);
    }
    expect(bodies.every(body=>JSON.stringify(body)===JSON.stringify(bodies[0]))).toBe(true);
  });
  it('does not issue a session when settlement fails after verifying the correct password',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    failStatement=sql=>sql.startsWith('UPDATE auth_login_attempts SET');
    const response=await login('person@example.com','correct-password');expect(response.status).toBe(503);
    expect(count('auth_refresh_tokens')).toBe(0);expect(count('auth_login_reservations')).toBe(1);
    expect(row('email:person@example.com')?.failures).toBe(0);
    failStatement=undefined;now+=2*60_000+1;await pruneLoginAttempts(env);
    expect(count('auth_login_reservations')).toBe(0);
  });
  it('normalizes email and ignores caller-supplied tenant identifiers',async()=>{
    for(let i=0;i<5;i++)await login(' Person@EXAMPLE.com ','wrong',{workspace_id:`ws-${i}`,workspaceId:`ws-${i}`},`203.0.113.${i}`);
    expect(row('email:person@example.com')?.failures).toBe(5);
    expect((await login('person@example.com','correct-password',{workspace_id:'different'},'198.51.100.1')).status).toBe(429);
    expect(db.prepare("SELECT count(*) AS n FROM auth_login_attempts WHERE key LIKE 'email:%'").get()?.n).toBe(1);
  });
  it('rejects oversized email without truncating onto another identity',async()=>{
    const response=await login('a'.repeat(321)+'@example.com');expect(response.status).toBe(200);expect(count('auth_login_attempts')).toBe(0);
  });
  it('does not turn production missing-IP or malformed-IP requests into unlimited login',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    expect((await login('person@example.com','correct-password',{},'')).status).toBe(503);
    expect((await login('person@example.com','correct-password',{},'invalid')).status).toBe(503);
    expect(count('auth_login_attempts')).toBe(0);
    expect((await login('person@example.com','correct-password',{},'','http://localhost/api/auth/login')).status).toBe(200);
  });
  it('canonicalizes IPv6 /64 and mapped IPv4 without accepting spoofable XFF',()=>{
    expect(loginIpBucket('2001:0DB8:0001:0002:0000:0000:0000:0003')).toBe('2001:db8:1:2::/64');
    expect(loginIpBucket('2001:db8:1:2::abcd')).toBe('2001:db8:1:2::/64');
    expect(loginIpBucket('::ffff:192.0.2.1')).toBe('192.0.2.1');expect(loginIpBucket('::ffff:c000:201')).toBe('192.0.2.1');
    expect(loginIpBucket('999.1.1.1')).toBeNull();expect(loginIpBucket('::1%lo')).toBeNull();
    expect(()=>loginSourceIp('https://api.example.com/api/auth/login',undefined)).toThrow();
  });
  it('preserves JWT tenant resolution, refresh, and PAT access while an email is locked',async()=>{
    const response=await login('person@example.com','correct-password');
    const body=await response.json() as {session:{access_token:string;refresh_token:string}};
    for(let i=0;i<5;i++)await fail('person@example.com');
    const member=await app.request('/private',{headers:{Authorization:`Bearer ${body.session.access_token}`}},env);
    expect(await member.json()).toEqual({workspace:'ws-a'});
    const refresh=await app.request('/api/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:body.session.refresh_token})},env,{waitUntil:()=>{}} as unknown as ExecutionContext);
    expect(await refresh.json()).toMatchObject({error:null});
    db.prepare('INSERT INTO api_tokens(id,workspace_id,member_id,name,token_hash,last_used_at,created_by) VALUES(?,?,?,?,?,?,?)').run('token-a','ws-a','member-a','Fixture',await sha256Hex('livo_pat_fixture'),new Date(now).toISOString(),'member-a');
    const pat=await app.request('/private',{headers:{Authorization:'Bearer livo_pat_fixture'}},env);
    expect(await pat.json()).toEqual({workspace:'ws-a'});
  });
  it('keeps throttle tables server-only and schema idempotent; cleanup preserves active locks',async()=>{
    expect(TABLES.auth_login_attempts.clientAccess).toBe('none');expect(TABLES.auth_login_reservations.clientAccess).toBe('none');
    db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
    for(let i=0;i<4;i++)await fail('person@example.com');now+=14*60_000;await fail('person@example.com');
    now+=2*60_000;await pruneLoginAttempts(env);expect(row('email:person@example.com')?.locked_until).not.toBeNull();
    expect((await reserveLoginAttempt(env,'person@example.com',null)).locked).toBe(true);
    now+=15*60_000;await pruneLoginAttempts(env);expect(count('auth_login_attempts')).toBe(0);
  });
  it('bounds cleanup work while retaining active reservations and their counters',async()=>{
    const lease=await hold('person@example.com');
    const insert=db.prepare('INSERT INTO auth_login_attempts(key,failures,window_start) VALUES(?,0,?)');
    for(let i=0;i<501;i++)insert.run(`email:expired${i}@example.com`,new Date(now-30*60_000).toISOString());
    await pruneLoginAttempts(env);expect(count('auth_login_attempts')).toBe(3);
    expect(count('auth_login_reservations')).toBe(1);expect(await finishLoginAttempt(env,lease,'success')).toBe(true);
    await pruneLoginAttempts(env);expect(count('auth_login_attempts')).toBe(2);
  });
});
