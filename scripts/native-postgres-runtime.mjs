// Optional native PostgreSQL 15 tests; binaries and pg client stay outside every Git checkout.
// Never installs a service, downloads a runtime, touches an existing cluster, or uses a remote DB.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';

function outsideGit(value) {
  const absolute=path.resolve(value);
  if(absolute.startsWith('\\\\'))throw new Error('Native PostgreSQL tests require local paths');
  for(let current=absolute;;current=path.dirname(current)) {
    if(fs.existsSync(path.join(current,'.git')))throw new Error('Native PostgreSQL artifacts and runtime must stay outside Git checkouts');
    if(current===path.dirname(current))break;
  }
  return absolute;
}
export async function runNativePostgres(plan,{binaryDir,clientPackage,reportPath}={}) {
  if(!binaryDir||!clientPackage)throw new Error('--native requires explicit --pg-bin and --pg-client-package (or LIVO_TEST_PG_BIN / LIVO_TEST_PG_CLIENT_PACKAGE)');
  const bin=outsideGit(binaryDir),pkg=outsideGit(clientPackage),report=reportPath?outsideGit(reportPath):undefined;
  if(!fs.statSync(pkg).isFile())throw new Error('Native PostgreSQL client package must be an existing package.json');
  const {Client}=createRequire(pkg)('pg');
  const exe=name=>path.join(bin,name+(process.platform==='win32'?'.exe':''));
  for(const name of ['postgres','initdb','pg_ctl'])if(!fs.statSync(exe(name)).isFile())throw new Error('Missing native PostgreSQL binary');
  const version=spawnSync(exe('postgres'),['--version'],{encoding:'utf8',windowsHide:true,timeout:5000});
  if(version.status!==0||!/PostgreSQL\) 15\./.test(version.stdout))throw new Error('Native acceptance requires PostgreSQL 15');
  const runId=randomUUID(),run=fs.mkdtempSync(path.join(outsideGit(os.tmpdir()),'livo-native-pg-'));
  const data=path.join(run,'data');
  fs.writeFileSync(path.join(run,'owner.json'),JSON.stringify({runId,data})+'\n');
  fs.writeFileSync(path.join(run,'plan.sql'),plan.sql,'utf8');
  const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const result={...plan.summary,runId,scope:'owned_isolated_local_native_postgres',productionOperations:0,executesDocker:false,
    nativeVersion:version.stdout.trim(),artifacts:run,planSha256:createHash('sha256').update(plan.sql).digest('hex')};
  let client,startAttempted=false,failure;
  const command=(name,args,label,expectZero=true)=>{
    const fd=fs.openSync(path.join(run,label+'.log'),'w');
    try {
      const outcome=spawnSync(exe(name),args,{windowsHide:true,stdio:['ignore',fd,fd],timeout:40000});
      if(expectZero&&outcome.status!==0)throw new Error(`${label} exited ${outcome.status}: ${outcome.error?.message??'see owned artifact log'}`);
      return outcome.status;
    }finally {fs.closeSync(fd);}
  };
  try {
    command('initdb',['-D',data,'--encoding=UTF8','--locale=C','--username=postgres','--auth=trust'],'init');
    startAttempted=true;
    command('pg_ctl',['-D',data,'-l',path.join(run,'engine.log'),'-o',`-p ${port} -h 127.0.0.1 -c shared_buffers=32MB -c max_connections=20 -c statement_timeout=15000 -c lock_timeout=3000`,'-w','start'],'start');
    client=new Client({host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000,query_timeout:120000});
    await client.connect();
    const engine=(await client.query("SELECT version(),current_setting('data_directory') AS data,current_setting('listen_addresses') AS addresses")).rows[0];
    if(path.resolve(engine.data).toLowerCase()!==path.resolve(data).toLowerCase()||engine.addresses!=='127.0.0.1')throw new Error('Native engine ownership/listen scope mismatch');
    result.engine=engine;
    const outputs=await client.query(plan.sql),rows=(Array.isArray(outputs)?outputs:[outputs]).flatMap(output=>output.rows??[]);
    const verified=rows.at(-1)?.json_build_object;
    if(verified?.status!=='passed'||verified.assertions!==plan.summary.assertions)throw new Error('PostgreSQL assertion readback mismatch');
    result.verified=verified;
  }catch(error){failure=error;}
  finally {
    if(client)await client.end().catch(()=>{});
    const owner=JSON.parse(fs.readFileSync(path.join(run,'owner.json'),'utf8'));
    if(owner.runId!==runId||owner.data!==data) {failure=new Error('Native ownership marker changed; cluster was not stopped');result.clusterStopped=false;}
    else if(startAttempted) {
      result.stopExit=command('pg_ctl',['-D',data,'-m','fast','-w','stop'],'stop',false);
      result.statusExit=command('pg_ctl',['-D',data,'status'],'status',false);
      result.clusterStopped=result.statusExit===3;
      if(!result.clusterStopped)failure=new Error(`${failure?.message??''} Native cluster stop unverified`);
    }else result.clusterStopped=true;
  }
  result.status=failure?'failed':'passed';result.passed=!failure;
  if(failure)result.error=failure.message;
  fs.writeFileSync(path.join(run,'report.json'),JSON.stringify(result,null,2)+'\n');
  if(report)fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');
  if(failure)throw Object.assign(failure,{report:result});
  return result;
}
