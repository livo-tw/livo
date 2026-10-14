#!/usr/bin/env node
// Real PostgreSQL checks in a disposable, local-only Docker container.
// Default / --plan never invokes Docker. --run requires an already running
// local daemon and a pre-pulled image; it never starts Docker or pulls images.
import fs from 'node:fs';
import path from 'node:path';

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';



export const IMAGE = 'postgres:15.8-alpine'; // PostgreSQL 15.8; the report records the inspected image ID.
const LABEL = 'com.livo.task-work-postgres-test';
const DB = 'livo_task_work_test';

export function isLocalDockerEndpoint(endpoint) {
  return ['npipe:////./pipe/docker_engine','npipe:////./pipe/dockerDesktopLinuxEngine',
    'unix:///var/run/docker.sock','unix:///run/docker.sock'].includes(endpoint);
}

export function containerArgs(name, runId) {
  if (!/^livo-task-work-pg-[a-f0-9]{24}$/.test(name) || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid test ownership identity');
  return ['create','--pull=never','--name',name,'--label',`${LABEL}=${runId}`,
    '--network','none','--cpus','1','--memory','512m','--memory-swap','512m','--pids-limit','128',
    '--shm-size','64m','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
    '--security-opt','no-new-privileges:true','--restart','no',
    '--env','POSTGRES_HOST_AUTH_METHOD=trust','--env',`POSTGRES_DB=${DB}`,
    IMAGE,'postgres','-c','listen_addresses=','-c','shared_buffers=32MB','-c','max_connections=20',
    '-c','statement_timeout=15000','-c','lock_timeout=3000'];
}

function command(executable, args, {input,timeout=15000,signal}={}) {
  return new Promise((resolve,reject) => {
    const child=spawn(executable,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],signal});
    let stdout='',stderr='';
    const timer=setTimeout(()=>child.kill(),timeout);
    child.stdout.on('data',chunk=>{ stdout+=chunk; if(stdout.length>1024*1024) child.kill(); });
    child.stderr.on('data',chunk=>{ stderr=(stderr+chunk).slice(-16000); });
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',(code,signalName)=>{clearTimeout(timer);if(code===0)resolve(stdout.trim());else reject(new Error(`${executable} ${args[0]} failed (${code??signalName}): ${stderr.slice(-3500)}`));});
    child.stdin.on('error',()=>{});
    child.stdin.end(input);
  });
}

export async function runPostgres(plan, reportPath) {
  const runId=randomUUID(); const name=`livo-task-work-pg-${runId.replaceAll('-','').slice(0,24)}`;
  const abort=new AbortController(); const started=Date.now();
  const interrupted=()=>abort.abort();
  process.once('SIGINT',interrupted); process.once('SIGTERM',interrupted);
  const deadline=setTimeout(interrupted,240000);
  let endpoint,created=false,createAttempted=false,dockerAttempted=false,containerId,cleanup='not-created',failure,result;
  const docker=(args,options={})=>command('docker',['--host',endpoint,...args],{signal:abort.signal,...options});
  try {
    endpoint=process.env.DOCKER_HOST;
    if (!endpoint) {
      dockerAttempted=true;
      const context=await command('docker',['context','show'],{signal:abort.signal});
      const contexts=JSON.parse(await command('docker',['context','inspect',context],{signal:abort.signal}));
      endpoint=contexts[0]?.Endpoints?.docker?.Host;
    }
    if (!isLocalDockerEndpoint(endpoint)) throw new Error('Refusing non-local/unknown Docker endpoint; only named local pipes or /var/run/docker.sock are allowed');
    // Read-only prerequisites. There is no service-start, image-pull or .env read.
    dockerAttempted=true;
    await docker(['version','--format','{{.Server.Version}}']);
    const imageId=await docker(['image','inspect',IMAGE,'--format','{{.Id}}']);
    createAttempted=true;
    try { containerId=await docker(containerArgs(name,runId)); created=true; }
    catch (error) {
      // A timeout after create may have left a container. Only an exact ownership
      // label match permits cleanup; a pre-existing same-name container is safe.
      try {
        const row=JSON.parse(await docker(['inspect',name],{signal:undefined}))[0];
        if(row?.Config?.Labels?.[LABEL]===runId) { containerId=row.Id;created=true; }
      } catch { cleanup='unknown'; }
      throw error;
    }
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Unexpected container ID');
    await docker(['start',containerId]);
    let ready=false;
    for(let attempt=0;attempt<40;attempt++) {
      try {
        // The image starts a temporary postmaster during initdb. PID 1 becomes
        // postgres only after the entrypoint finishes init and execs the final DB.
        const pid1=await docker(['exec',containerId,'cat','/proc/1/comm'],{timeout:3000});
        if(pid1!=='postgres')throw new Error('PostgreSQL entrypoint is still initializing');
        await docker(['exec',containerId,'pg_isready','-U','postgres','-d',DB],{timeout:3000});ready=true;break;
      }
      catch(error) { if(abort.signal.aborted)throw error; await delay(500,undefined,{signal:abort.signal}); }
    }
    if(!ready)throw new Error('Isolated PostgreSQL did not become ready within the bounded startup check');
    const output=await docker(['exec','-i',containerId,'psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-U','postgres','-d',DB],{input:plan.sql,timeout:120000});
    const last=output.split(/\r?\n/).filter(line=>line.trim().startsWith('{')).at(-1);
    const verified=JSON.parse(last||'null');
    if(verified?.status!=='passed'||verified.assertions!==plan.summary.assertions)throw new Error('PostgreSQL assertions failed: '+JSON.stringify(verified));
    result={...plan.summary,...verified,executesDocker:true, imageId,containerId};
  } catch(error) { failure=error; }
  finally {
    clearTimeout(deadline);
    if(createAttempted&&!created&&cleanup==='unknown') {
      try {
        const ids=await command('docker',['--host',endpoint,'ps','--all','--quiet','--no-trunc','--filter',`label=${LABEL}=${runId}`],{timeout:10000});
        if(/^[a-f0-9]{64}$/.test(ids)) { containerId=ids;created=true; }
        else if(!ids)cleanup='not-created-verified';
      } catch { /* cleanup remains unknown and must be reported */ }
    }
    if(created) {
      try {
        const rows=JSON.parse(await command('docker',['--host',endpoint,'inspect',containerId],{timeout:10000}));
        if(rows[0]?.Id!==containerId||rows[0]?.Config?.Labels?.[LABEL]!==runId)throw new Error('Ownership check failed; container was not removed');
        await command('docker',['--host',endpoint,'rm','--force',containerId],{timeout:10000});
        const remaining=await command('docker',['--host',endpoint,'ps','--all','--quiet','--no-trunc','--filter',`label=${LABEL}=${runId}`],{timeout:10000});
        if(remaining)throw new Error('Owned container still present after cleanup');
        cleanup='removed-and-verified';
      } catch(error) { cleanup='failed';failure=new Error(`${failure?.message??''} Cleanup failed for ${name}: ${error.message}`); }
    }
    if(cleanup==='unknown')failure=new Error(`${failure?.message??''} Container creation/cleanup is unverified for ${name}; inspect its exact ownership label ${LABEL}=${runId}.`);
    process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);
  }
  const report={...(result??plan.summary),executesDocker:dockerAttempted,status:failure?'failed':'passed',runId,containerName:name,cleanup,
    elapsedMs:Date.now()-started,...(failure?{error:failure.message}:{})};
  if(reportPath)fs.writeFileSync(path.resolve(reportPath),JSON.stringify(report,null,2)+'\n','utf8');
  if(failure)throw Object.assign(failure,{report});
  return report;
}
