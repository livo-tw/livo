// @vitest-environment node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
describe('QA comment publication expiry at database execution',()=>{
 it('rejects a reservation that was valid when HTTP started but expired while queued',()=>{
  const source=readFileSync(new URL('../../worker/src/qa.ts',import.meta.url),'utf8');
  const match=source.match(/hashSql=`CASE WHEN ([\s\S]*?) THEN \$\{hashSql\} ELSE NULL END`;/);
  expect(match).not.toBeNull();
  const sql='SELECT CASE WHEN '+match![1]+' THEN ? ELSE NULL END';
  const program=`import json,sys,sqlite3,datetime as dt
sql=json.load(sys.stdin)['sql']
db=sqlite3.connect(':memory:')
db.executescript("CREATE TABLE qa_upload_sessions(workspace_id TEXT,id TEXT,issue_id TEXT,actor_id TEXT,storage_key TEXT,purpose TEXT,state TEXT,comment_ready_at TEXT,expires_at TEXT,cleanup_token TEXT);CREATE TABLE qa_attachments(workspace_id TEXT,id TEXT,storage_key TEXT);")
now=dt.datetime.now(dt.timezone.utc)
fmt=lambda v:v.isoformat(timespec='milliseconds').replace('+00:00','Z')
request_at=now-dt.timedelta(seconds=60)
expired_at=now-dt.timedelta(seconds=1)
assert request_at<expired_at
values=['example-ws','file1','issue1','actor1','qa/example/file1','comment','finalizing',fmt(request_at),fmt(expired_at),None]
db.execute('INSERT INTO qa_upload_sessions VALUES(?,?,?,?,?,?,?,?,?,?)',values)
args=['example-ws','issue1','actor1','["file1"]',1,'known-hash']
assert db.execute(sql,args).fetchone()[0] is None
db.execute('UPDATE qa_upload_sessions SET expires_at=?',(fmt(now+dt.timedelta(hours=1)),))
assert db.execute(sql,args).fetchone()[0]=='known-hash'
print(json.dumps({'validAtRequest':True,'expiredRejected':True,'freshAccepted':True}))`;
  const result=execFileSync(process.platform==='win32'?'python':'python3',['-c',program],{input:JSON.stringify({sql}),encoding:'utf8',timeout:10000,windowsHide:true});
  expect(JSON.parse(result)).toEqual({validAtRequest:true,expiredRejected:true,freshAccepted:true});
 });
});
