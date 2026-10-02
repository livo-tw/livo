// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const schema=read('worker/schema.sql');
const migration=read('worker/migrate/qa-status-semantics.sql');
const snapshot=db=>JSON.stringify(['qa_issues','qa_comments','qa_events','qa_upload_sessions','qa_attachments','qa_slack_links'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY workspace_id,id`).all()));
const objects=db=>db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('trigger','index') AND sql IS NOT NULL ORDER BY name").all().map(row=>({...row,sql:row.sql.replace(/IF NOT EXISTS /g,'').replace(/\s+/g,' ')}));
describe('D1 QA status schema upgrade',()=>{
  it('aborts rather than clears an unresolved FK violation',()=>{
    const db=new DatabaseSync(':memory:');
    try {
      db.exec(schema.replace("'verification','verified','failed','closed','dismissed'","'verification','closed'"));
      db.exec("PRAGMA foreign_keys=OFF; INSERT INTO qa_comments VALUES('a','orphan','missing','person','old invalid row','before'); PRAGMA foreign_keys=ON;");
      db.exec('BEGIN');
      expect(()=>db.exec(migration)).toThrow('CHECK constraint failed');
      db.exec('ROLLBACK');
      expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name='qa_issues'").get().sql).not.toContain("'verified'");
      expect(db.prepare('SELECT count(*) AS n FROM qa_comments').get().n).toBe(1);
      expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    } finally {db.close();}
  });

  it('runs twice preserving existing issue evidence, child references, tenant boundaries and every guard',()=>{
    const db=new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys=ON');
      db.exec(schema.replace("'verification','verified','failed','closed','dismissed'","'verification','closed'"));
      for(const ws of ['a','b']) {
        const prepare = sql => db.prepare(sql.replaceAll("'person'","'"+ws+"-person'").replaceAll("'link'","'"+ws+"-link'"));
        prepare('INSERT INTO product_lines(workspace_id,id,name) VALUES(?,?,?)').run(ws,ws+'-line','Line');
        prepare('INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES(?,?,?,?,?)').run(ws,ws+'-project',ws+'-line','Project','P');
        prepare("INSERT INTO members(workspace_id,id,name,avatar,role,email) VALUES(?,?,?,'','super_admin',?)").run(ws,ws+'-person','Person',ws+'@example.test');
        prepare("INSERT INTO system_settings(workspace_id,key,value) VALUES(?,'feature_toggles','{\"qa\":true}')").run(ws);
        const issue={id:'issue',workspaceId:ws,projectId:ws+'-project',state:'verification',version:7,reporterId:ws+'-person',assigneeId:null,qaOwnerId:null,title:'Historical test',taskIds:[],targets:[],runs:[],legacySource:{originalStatus:'PASS'}};
        prepare('INSERT INTO qa_issues(workspace_id,id,project_id,state,reporter_id,title,version,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?)').run(ws,issue.id,issue.projectId,issue.state,issue.reporterId,issue.title,issue.version,'before',JSON.stringify(issue));
        prepare("INSERT INTO qa_comments VALUES(?,'comment','issue','person','evidence','before')").run(ws);
        prepare("INSERT INTO qa_events VALUES(?,'event','issue','person','legacy_import','evidence',7,'before')").run(ws);
        prepare("INSERT INTO qa_upload_sessions(workspace_id,id,issue_id,actor_id,file_name,mime_type,expected_size,storage_key,created_at,expires_at) VALUES(?,'upload','issue','person','proof.txt','text/plain',1,'key','before','later')").run(ws);
        prepare("INSERT INTO qa_attachments(workspace_id,id,issue_id,uploaded_by,file_name,mime_type,size,storage_key,created_at,restored_by) VALUES(?,'attachment','issue','person','proof.txt','text/plain',1,'key','before','person')").run(ws);
        prepare("INSERT INTO qa_slack_links(workspace_id,id,issue_id,team_id,channel_id,thread_ts,card_ts,created_at) VALUES(?,'link','issue','team','channel','thread','card','before')").run(ws);
      }
      const before=snapshot(db),guards=objects(db);
      for(let i=0;i<2;i++) {db.exec('BEGIN');try { db.exec(migration); } catch(error) {throw new Error('migration SQL: '+error.message);}try { db.exec('COMMIT'); } catch(error) {throw new Error('commit: '+error.message+' checks: '+JSON.stringify(db.prepare('PRAGMA foreign_key_check').all()));}expect(snapshot(db)).toBe(before);expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);expect(objects(db)).toEqual(guards);}
      for(const state of ['verified','failed','dismissed']) db.prepare("UPDATE qa_issues SET state=?,data=json_set(data,'$.state',?) WHERE workspace_id='a' AND id='issue'").run(state,state);
      expect(db.prepare("SELECT state FROM qa_issues WHERE workspace_id='b'").get().state).toBe('verification');
      expect(()=>db.exec("UPDATE qa_issues SET state='made_up',data=json_set(data,'$.state','made_up') WHERE workspace_id='a'")).toThrow();
      expect(()=>db.exec("INSERT INTO qa_comments VALUES('other','foreign','issue','person','bad','now')")).toThrow();
    } finally { db.close(); }
  });
});
