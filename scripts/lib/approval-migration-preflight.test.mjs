// @vitest-environment node
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,existsSync,rmSync,readFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {KNOWLEDGE_IMPORT_SOURCE_TABLES} from '../../worker/migrate/knowledge-work-import-guard.mjs';
let temp,script;
beforeEach(()=>{temp=mkdtempSync(path.join(tmpdir(),'livo-approval-migrate-'));script=path.join(temp,'migrate-from-docker.mjs');
  mkdirSync(path.join(temp,'data'));
  for(const file of ['migrate-from-docker.mjs','task-planning-import-guard.mjs','task-work-import-guard.mjs','knowledge-work-import-guard.mjs','qa-coordination-import-guard.mjs'])
    copyFileSync(new URL(`../../worker/migrate/${file}`,import.meta.url),path.join(temp,file));
  for(const table of KNOWLEDGE_IMPORT_SOURCE_TABLES)
    writeFileSync(path.join(temp,'data',table+'.json'),'[]');});
afterEach(()=>{if(!temp.startsWith(path.resolve(tmpdir())+path.sep+'livo-approval-migrate-'))throw new Error('Unsafe test cleanup target');rmSync(temp,{recursive:true,force:true});});
const data=(table,rows)=>writeFileSync(path.join(temp,'data',table+'.json'),JSON.stringify(rows));
const run=mode=>execFileSync(process.execPath,[script,mode],{encoding:'utf8',stdio:'pipe',env:{PATH:process.env.PATH}});
describe('destructive D1 migration preflight',()=>{
  it.each(['approval_requests','approval_actions','approval_command_receipts','approval_events'])('refuses %s evidence before generating any import SQL',table=>{
    data(table,[{id:'historical-proof'}]);expect(()=>run('transform')).toThrow(/Approval history requires/);expect(existsSync(path.join(temp,'out','import.sql'))).toBe(false);
  });
  it.each([{current_approval_id:'pending-proof'},{approval_status:'pending_approval'}])('refuses pending task pointers before generating SQL',pointer=>{
    data('tasks',[{id:'task',...pointer}]);expect(()=>run('transform')).toThrow(/Pending approval pointers require/);expect(existsSync(path.join(temp,'out','import.sql'))).toBe(false);
  });
  it.each([['task_deadline_history','planning_history_requires_restore'],['task_reminder_preferences','planning_history_requires_restore'],
    ['task_work_events','work_history_requires_restore'],['task_work_receipts','work_history_requires_restore']])('retains the real %s guard alongside approval protection',(table,error)=>{
    data(table,[{id:'historical-proof'}]);expect(()=>run('transform')).toThrow(error);expect(existsSync(path.join(temp,'out','import.sql'))).toBe(false);
  });
  it('allows a source without approval history and persists a verified output manifest',()=>{
    data('tasks',[{id:'task',requires_approval:true,current_approval_id:null,approval_status:null}]);expect(run('transform')).toContain('Wrote');expect(existsSync(path.join(temp,'out','import-manifest.json'))).toBe(true);
  });
  it.each(KNOWLEDGE_IMPORT_SOURCE_TABLES)('refuses %s before producing destructive migration SQL',table=>{
    data(table,[{id:'knowledge-proof'}]);expect(()=>run('transform')).toThrow(/knowledge_requires_server_restore/);expect(existsSync(path.join(temp,'out','import.sql'))).toBe(false);
  });
  it('rejects a modified output before invoking wrangler',()=>{
    data('tasks',[]);run('transform');writeFileSync(path.join(temp,'out','import.sql'),'unverified SQL');expect(()=>run('import-local')).toThrow(/Unverified migration output/);
  });
  it.each([undefined,null,{},'not-json'])('fails closed on missing or malformed staged-import export %j',rows=>{
    const file=path.join(temp,'data','knowledge_import_jobs.json');
    if(rows===undefined)unlinkSync(file);else writeFileSync(file,rows==='not-json'?rows:JSON.stringify(rows));
    expect(()=>run('transform')).toThrow();expect(existsSync(path.join(temp,'out','import.sql'))).toBe(false);
  });
  it('rechecks a newly discovered staging-only job before running a generated destructive import',()=>{
    data('tasks',[]);run('transform');data('knowledge_import_jobs',[{id:'staged-only'}]);
    expect(()=>run('import-local')).toThrow(/knowledge_requires_server_restore/);
  });
  it.each(['absent','present','catalog-error'])('only explicit catalog absence permits an old PostgreSQL table (%s)',mode=>{
    // A previous empty export/output must not remain usable after a failed refresh.
    run('transform');
    const stub=path.join(temp,'docker-stub.mjs');
    writeFileSync(stub,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
      cp.execSync=()=> 'supabase-db\\n';
      cp.execFileSync=(_file,args)=>{
        const sql=args.at(-1);
        if(sql.includes('to_regclass')){if('${mode}'==='catalog-error')throw Error('catalog denied');return '${mode}'==='absent'?'t':'f';}
        if(sql.includes('public."knowledge_import_jobs"'))throw Error('source unavailable');
        return '[]';
      };syncBuiltinESMExports();`);
    const invoke=()=>execFileSync(process.execPath,['--import',pathToFileURL(stub).href,script,'export'],{encoding:'utf8',stdio:'pipe',env:{PATH:process.env.PATH}});
    if(mode==='absent'){
      expect(invoke).not.toThrow();expect(JSON.parse(readFileSync(path.join(temp,'data','knowledge_import_jobs.json'),'utf8'))).toEqual([]);
      expect(JSON.parse(readFileSync(path.join(temp,'data','knowledge-export-status.json'),'utf8')).status).toBe('complete');
      expect(()=>run('transform')).not.toThrow();
    } else {
      expect(invoke).toThrow(/Knowledge export could not be verified/);
      expect(()=>run('transform')).toThrow(/Knowledge export is incomplete/);
      expect(()=>run('import-local')).toThrow(/Knowledge export is incomplete/);
    }
    expect(existsSync(path.join(temp,'data','knowledge_import_files.json'))).toBe(false);
  });
});
