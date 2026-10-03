// Synthetic native database checks. This file never contacts Slack.
export function addReleaseDeliveryCases(sql,check,denied){
 const bid='delivery-batch',lease='delivery-owner-1',binding='00000000-0000-0000-0000-000000000011';
 sql.push(`RESET ROLE;
 UPDATE members SET is_active=true,role='admin' WHERE id='admin';
 UPDATE projects SET is_archived=false WHERE id='p';
 UPDATE external_account_bindings SET member_id='admin',platform='slack',platform_team_id='TEXAMPLE',platform_user_id='URELEASE',is_verified=true,verified_by='admin' WHERE id='${binding}';
 INSERT INTO system_settings(key,value) VALUES('slack_delivery','{"enabled":true,"teamId":"TEXAMPLE","routes":[{"projectId":"p","channelId":"CEXAMPLE"}]}'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
 INSERT INTO system_settings(key,value) VALUES('feature_toggles','{"slackActions":true}'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
 INSERT INTO release_batches(workspace_id,id,title,owner_id,status,version,revision,data,updated_at)
 VALUES('default','${bid}','Delivery fixture','admin','active',5,1,
 '{"id":"${bid}","workspaceId":"default","ownerId":"admin","title":"Delivery fixture","status":"active","version":5,"manifestRevision":1,"components":[{"id":"component","projectId":"p","name":"Server","taskIds":[],"targets":[{"environment":"Prod","build":"b","config":"c","data":"d"}]}]}'::jsonb,now());
 INSERT INTO release_batch_projects(workspace_id,batch_id,project_id) VALUES('default','${bid}','p');
 INSERT INTO release_publications(workspace_id,batch_id,team_id,channel_id,published_by,binding_id,published_at,command_id,first_version)
 VALUES('default','${bid}','TEXAMPLE','CEXAMPLE','admin','${binding}',now(),'publication-fixture',5);
 INSERT INTO release_events(workspace_id,id,batch_id,actor_id,operation,version,revision,created_at)
 VALUES('default','delivery-before','${bid}','admin','edit_manifest',4,1,now()),('default','delivery-first','${bid}','admin','publish_thread',5,1,now());
 INSERT INTO release_outbox(workspace_id,id,batch_id,event_id) VALUES('default','delivery-before','${bid}','delivery-before'),('default','delivery-first','${bid}','delivery-first');`);
 for(const [name,actor] of [['member','1'],['admin','2'],['super_admin','3']]){
  sql.push(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000${actor}',false);`);
  denied(name+' cannot claim release delivery',`SELECT public.livo_release_claim_delivery('${lease}','${bid}')`,'permission denied');
  denied(name+' cannot directly publish release',`UPDATE public.release_publications SET channel_id='COTHER' WHERE batch_id='${bid}'`,'permission denied');
  denied(name+' cannot forge delivery receipt',`SELECT public.livo_release_finish_delivery('delivery-first','${lease}','sent','1.1','1.1',NULL,0)`,'permission denied');
  sql.push('RESET ROLE;');
 }
 sql.push('SET ROLE service_role;');
 check('release route checks every project',`public.livo_release_route_allowed((SELECT data FROM release_batches WHERE id='${bid}'),'TEXAMPLE','CEXAMPLE')`);
 check('release route rejects a different channel',`NOT public.livo_release_route_allowed((SELECT data FROM release_batches WHERE id='${bid}'),'TEXAMPLE','COTHER')`);
 check('release route rejects a different workspace',`NOT public.livo_release_route_allowed((SELECT data FROM release_batches WHERE id='${bid}'),'TOTHER','CEXAMPLE')`);
 check('release route rejects missing component project',`NOT public.livo_release_route_allowed(jsonb_set((SELECT data FROM release_batches WHERE id='${bid}'),'{components,0,projectId}','"missing-project"'),'TEXAMPLE','CEXAMPLE')`);
 sql.push(`SELECT public.livo_release_claim_delivery('${lease}','${bid}');`);
 check('before optin events skipped not backfilled',`(SELECT status='skipped' FROM release_outbox WHERE id='delivery-before')`);
 check('publication event claimed once',`(SELECT status='sending' AND lease_owner='${lease}' AND attempts=1 FROM release_outbox WHERE id='delivery-first') AND NOT EXISTS(SELECT 1 FROM public.livo_release_claim_delivery('another-owner','${bid}'))`);
 const can=(user='URELEASE',team='TEXAMPLE',channel='CEXAMPLE',version=5)=>`public.livo_release_can_deliver('delivery-first','${lease}',${version},'${user}','${team}','${channel}')`;
 check('current release publication can send',can());
 check('checked publisher identity pinned',`NOT ${can('UCHANGED')}`);
 check('checked Slack destination pinned',`NOT ${can('URELEASE','TEXAMPLE','COTHER')}`);
 check('current aggregate version pinned',`NOT ${can('URELEASE','TEXAMPLE','CEXAMPLE',4)}`);
 sql.push("UPDATE members SET role='member' WHERE id='admin';");check('publisher demotion blocks send',`NOT ${can()}`);sql.push("UPDATE members SET role='admin' WHERE id='admin';");
 sql.push(`UPDATE external_account_bindings SET platform_user_id='UCHANGED' WHERE id='${binding}';`);check('binding changed after membership blocks send',`NOT ${can()}`);sql.push(`UPDATE external_account_bindings SET platform_user_id='URELEASE' WHERE id='${binding}';`);
 sql.push(`UPDATE external_account_bindings SET is_verified=false WHERE id='${binding}';`);check('binding revoked blocks send',`NOT ${can()}`);sql.push(`UPDATE external_account_bindings SET is_verified=true WHERE id='${binding}';`);
 sql.push("UPDATE system_settings SET value=jsonb_set(value,'{enabled}','false') WHERE key='slack_delivery';");check('channel delivery disabled blocks send',`NOT ${can()}`);sql.push("UPDATE system_settings SET value=jsonb_set(value,'{enabled}','true') WHERE key='slack_delivery';");
 check('wrong lease cannot finish',`NOT public.livo_release_finish_delivery('delivery-first','wrong-owner','sent','1600000000.1','1600000000.1',NULL,0)`);
 check('valid root receipt stored',`public.livo_release_finish_delivery('delivery-first','${lease}','sent','1600000000.1','1600000000.1',NULL,0)`);
 check('root retained beyond task window',`(SELECT thread_ts='1600000000.1' FROM release_slack_links WHERE batch_id='${bid}')`);
 sql.push(`INSERT INTO release_events(workspace_id,id,batch_id,actor_id,operation,version,revision,created_at) VALUES('default','delivery-second','${bid}','admin','record_result',6,1,now());
 INSERT INTO release_outbox(workspace_id,id,batch_id,event_id) VALUES('default','delivery-second','${bid}','delivery-second');
 SELECT public.livo_release_claim_delivery('${lease}','${bid}');`);
 check('cannot replace established root',`NOT public.livo_release_finish_delivery('delivery-second','${lease}','sent','1900000000.2','1900000000.2',NULL,0)`);
 check('reply uses established root',`public.livo_release_finish_delivery('delivery-second','${lease}','sent','1900000000.2','1600000000.1',NULL,0)`);
 check('latest receipt updates card without resetting root',`(SELECT thread_ts='1600000000.1' AND card_ts='1900000000.2' FROM release_slack_links WHERE batch_id='${bid}')`);
 sql.push(`INSERT INTO release_events(workspace_id,id,batch_id,actor_id,operation,version,revision,created_at) VALUES('default','delivery-unknown','${bid}','admin','record_result',7,1,now()),('default','delivery-later','${bid}','admin','record_result',8,1,now());
 INSERT INTO release_outbox(workspace_id,id,batch_id,event_id) VALUES('default','delivery-unknown','${bid}','delivery-unknown'),('default','delivery-later','${bid}','delivery-later');
 SELECT public.livo_release_claim_delivery('${lease}','${bid}');
 UPDATE release_outbox SET lease_until=now()-interval '1 second' WHERE id='delivery-unknown';
 SELECT public.livo_release_claim_delivery('replacement-owner','${bid}');`);
 check('expired sending promoted to review',`(SELECT status='review' AND last_error='delivery_receipt_unknown' FROM release_outbox WHERE id='delivery-unknown')`);
 check('unknown receipt blocks later replies',`(SELECT status='pending' AND attempts=0 FROM release_outbox WHERE id='delivery-later') AND NOT EXISTS(SELECT 1 FROM public.livo_release_claim_delivery('replacement-owner','${bid}'))`);
 check('expired lease cannot record success',`NOT public.livo_release_finish_delivery('delivery-unknown','${lease}','sent','1900000000.3','1600000000.1',NULL,0)`);
 sql.push('RESET ROLE;');
}
