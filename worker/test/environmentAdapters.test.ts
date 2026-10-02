// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createCloudQaSlackActions } from '../src/qaSlack';
import type { Env } from '../src/env';

describe('Cloudflare Slack environment catalog',()=>{
  it('uses only the authenticated workspace catalog and fails closed on invalid persisted settings',async()=>{
    const db=new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE system_settings(workspace_id TEXT,key TEXT,value TEXT);
        INSERT INTO system_settings VALUES('a','deployment_environments','{"version":1,"values":["Preview","Production"]}'),('b','deployment_environments','{"version":1,"values":["Secret"]}');`);
      const env={DB:{prepare:(sql:string)=>({bind:(...values:string[])=>({first:async()=>db.prepare(sql).get(...values)??null})})}} as unknown as Env;
      const actor={id:'member-a',role:'member',team:'T',slack_user:'U'};
      const adapter=createCloudQaSlackActions(env,'a',{waitUntil:():void=>{}});
      expect(await adapter.environments(actor)).toEqual(['Preview','Production']);
      db.exec("UPDATE system_settings SET value='null' WHERE workspace_id='a'");
      await expect(adapter.environments(actor)).rejects.toThrow('qa_invalid_environment');
      db.exec("DELETE FROM system_settings WHERE workspace_id='a'");
      expect(await adapter.environments(actor)).toEqual(['Dev','QA','Stage','Live Staging','Prod']);
    } finally { db.close(); }
  });
});
