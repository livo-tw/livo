// Direct invitation PostgreSQL assertions use synthetic identity rows only.
// No GoTrue HTTP, email, production server, or automatic auth deletion.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const q = x => "'" + String(x).replaceAll("'", "''") + "'";
const hash = x => createHash('sha256').update(x).digest('hex');
const auth = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
const serviceSQL = "RESET ROLE; SET ROLE service_role; SET request.jwt.claim.role='service_role'; SET request.jwt.claim.sub='';";
const invite = (id, role = 'member', title = '', qa = false) => `INSERT INTO public.member_invitations(id,token_hash,role,job_title,is_qa_admin,created_by) VALUES(${q(id)},${q(hash(id))},${q(role)},${q(title)},${qa},'m-super');`;
const login = (n, id, email = id+'@example.com') => `INSERT INTO auth.users(id,email,created_at,email_confirmed_at,raw_app_meta_data) VALUES(${q(auth(n))}::uuid,${q(email)},clock_timestamp(),clock_timestamp(),jsonb_build_object('email_identity_verified',false,'livo_member_invitation_direct',jsonb_build_object('invitation_id',${q(id)},'token_hash',${q(hash(id))},'created_state','pending_member_attachment')));`;
const accept = (id, n, member = 'direct-'+id, email = id+'@example.com', name = 'Example Direct Member') => `public.livo_member_invitation_accept_direct(${q(id)},${q(hash(id))},${q(auth(n))}::uuid,${q(member)},${q(name)},${q(email)})`;

export function appendDirectJoinAssertions({ raw, check, error, service, owner, session }, migration) {
  owner();
  check('direct migration preserves every historical member as email verified', 'NOT EXISTS(SELECT 1 FROM public.members WHERE NOT email_identity_verified)');
  check('direct RPC is service only and has no new auth discard function', "has_function_privilege('service_role','public.livo_member_invitation_accept_direct(text,text,uuid,text,text,text)','EXECUTE') AND to_regprocedure('public.livo_member_invitation_discard_direct_auth(text,text,uuid)') IS NULL");
  service();
  raw(invite('direct-success','member','Engineer',true)+login(400,'direct-success'));
  check('direct acceptance returns committed success', `(${accept('direct-success',400)}->>'success')::boolean`);
  check('direct acceptance creates a fresh member using fixed invitation grants', `(SELECT role::text='member' AND job_title='Engineer' AND is_qa_admin AND is_active AND auth_id=${q(auth(400))}::uuid AND NOT email_identity_verified FROM public.members WHERE id='direct-direct-success')`);
  check('direct acceptance consumes once without a mail confirmation row', "(SELECT used_at IS NOT NULL AND used_member_id='direct-direct-success' FROM public.member_invitations WHERE id='direct-success') AND NOT EXISTS(SELECT 1 FROM public.member_invitation_confirmations WHERE invitation_id='direct-success')");
  error('direct used token cannot create a second member', 'SELECT '+accept('direct-success',400,'direct-replay'), 'PT409','invalid_token');
  // Actual schema allows QA capability only on role=member; privileged role
  // grants therefore need their own legal QA=false fixture.
  raw(invite('direct-admin-success','admin')+login(407,'direct-admin-success'));
  check('direct admin grant returns committed success', `(${accept('direct-admin-success',407)}->>'success')::boolean`);
  check('direct admin grant keeps its fixed role without QA capability or Email trust', "(SELECT role::text='admin' AND NOT is_qa_admin AND NOT email_identity_verified FROM public.members WHERE id='direct-direct-admin-success')");

  owner(); raw(migration);
  check('second direct migration preserves false new identity and true legacy identity', "(SELECT NOT email_identity_verified FROM public.members WHERE id='direct-direct-success') AND (SELECT email_identity_verified FROM public.members WHERE id='m-super') AND (SELECT email_identity_verified FROM public.members WHERE id='joined-qa-confirm')");

  for (const [role,n] of [['anon',0],['authenticated',1],['authenticated',2],['authenticated',3]]) {
    session(role,n);
    error('direct RPC forbidden to session '+role+' '+n,'SELECT '+accept('direct-success',400),'42501','permission denied');
  }
  owner();
  raw('GRANT INSERT,UPDATE ON public.members TO authenticated; CREATE POLICY direct_fixture_write ON public.members FOR ALL TO authenticated USING(true) WITH CHECK(true);');
  for (const n of [1,2,3]) {
    session('authenticated',n);
    raw(`INSERT INTO public.members(id,name,email,avatar,email_identity_verified) VALUES('direct-client-${n}','Example Client','direct-client-${n}@example.com','C',true);`);
    check('generic insert cannot inherit or force trusted Email '+n, `(SELECT NOT email_identity_verified FROM public.members WHERE id='direct-client-${n}')`);
    error('generic caller cannot promote false Email identity '+n, `UPDATE public.members SET email_identity_verified=true WHERE id='direct-client-${n}'`, 'PT403','email_identity_server_only');
    const id = n===1 ? 'm-member' : n===2 ? 'm-admin' : 'm-super';
    raw(`UPDATE public.members SET email=${q('direct-changed-'+n+'@example.com')} WHERE id=${q(id)};`);
    check('generic Email change clears trust '+n, `(SELECT NOT email_identity_verified FROM public.members WHERE id=${q(id)})`);
    error('generic caller cannot restore own Email trust '+n, `UPDATE public.members SET email_identity_verified=true WHERE id=${q(id)}`, 'PT403','email_identity_server_only');
    service(); raw(`UPDATE public.members SET email=${q(n===1?'member@example.com':n===2?'admin@example.com':'super@example.com')} WHERE id=${q(id)};`);
    // Restore fixture trust independently after the mailbox-change gate.
    raw(`UPDATE public.members SET email_identity_verified=true WHERE id=${q(id)};`);
  }
  service();
  raw("UPDATE public.members SET email='service-email-change@example.com',email_identity_verified=true WHERE id='m-super';");
  check('service Email change also invalidates ownership despite an explicit true flag', "(SELECT NOT email_identity_verified FROM public.members WHERE id='m-super')");
  raw("UPDATE public.members SET email='super@example.com' WHERE id='m-super'; UPDATE public.members SET email_identity_verified=true WHERE id='m-super';");
  owner(); raw('DROP POLICY direct_fixture_write ON public.members; REVOKE INSERT,UPDATE ON public.members FROM authenticated;');
  service();
  raw(invite('direct-proof')+login(401,'direct-proof'));
  // Derive a reserved .invalid placeholder from a synthetic example.com fixture only.
  const reservedPlaceholder = 'placeholder@example.com'.replace('.com', '.invalid');
  for (const [name,email] of [['','direct-proof@example.com'],['Example','bad'],['Example',reservedPlaceholder],['Line\nBreak','direct-proof@example.com']]) error('direct invalid fields '+JSON.stringify([name,email]),'SELECT '+accept('direct-proof',401,'direct-fields',email,name),'PT400','invalid_request');
  error('direct wrong token hash is rejected', `SELECT public.livo_member_invitation_accept_direct('direct-proof',${q(hash('wrong'))},${q(auth(401))}::uuid,'direct-wrong','Example','direct-proof@example.com')`,'PT409','invalid_token');
  const badProofs = [
    ['missing','{}'],
    ['verified','{"email_identity_verified":true,"livo_member_invitation_direct":{"invitation_id":"direct-proof","token_hash":"'+hash('direct-proof')+'"}}'],
    ['other-invite','{"email_identity_verified":false,"livo_member_invitation_direct":{"invitation_id":"other","token_hash":"'+hash('direct-proof')+'"}}'],
    ['other-hash','{"email_identity_verified":false,"livo_member_invitation_direct":{"invitation_id":"direct-proof","token_hash":"'+hash('other')+'"}}'],
  ];
  for (const [label,meta] of badProofs) {
    raw(`UPDATE auth.users SET raw_app_meta_data=${q(meta)}::jsonb WHERE id=${q(auth(401))}::uuid;`);
    error('direct refuses existing or mismatched auth proof '+label,'SELECT '+accept('direct-proof',401),'PT403','forbidden');
  }
  raw(`DELETE FROM auth.users WHERE id=${q(auth(401))}::uuid;`+login(401,'direct-proof'));
  for (const [label,change,undo] of [
    ['old','created_at=now()-interval \'30 days\'','created_at=clock_timestamp()'],
    ['banned','banned_until=now()+interval \'1 day\'','banned_until=NULL'],
    ['unconfirmed','email_confirmed_at=NULL','email_confirmed_at=clock_timestamp()'],
  ]) {
    raw(`UPDATE auth.users SET ${change} WHERE id=${q(auth(401))}::uuid;`);
    error('direct refuses '+label+' auth','SELECT '+accept('direct-proof',401),'PT403','forbidden');
    raw(`UPDATE auth.users SET ${undo} WHERE id=${q(auth(401))}::uuid;`);
  }
  for (const [id,n,state] of [['direct-expired',402,"expires_at=now()-interval '1 minute'"],['direct-revoked',403,'revoked_at=now()']]) {
    raw(invite(id)+login(n,id)+`UPDATE public.member_invitations SET ${state} WHERE id=${q(id)};`);
    error('direct '+id+' is unavailable','SELECT '+accept(id,n),'PT409','invalid_token');
    check('failed '+id+' preserves isolated pending auth',`EXISTS(SELECT 1 FROM auth.users WHERE id=${q(auth(n))}::uuid) AND NOT EXISTS(SELECT 1 FROM public.members WHERE auth_id=${q(auth(n))}::uuid)`);
  }
  raw(invite('direct-taken')+login(404,'direct-taken')+"INSERT INTO public.members(id,name,email,avatar) VALUES('direct-existing','Example Existing','DIRECT-TAKEN@example.com','E');");
  error('direct Email conflict never adopts the existing member','SELECT '+accept('direct-taken',404),'PT409','email_taken');
  check('direct Email conflict preserves both original member and fresh pending auth',`(SELECT auth_id IS NULL FROM public.members WHERE id='direct-existing') AND EXISTS(SELECT 1 FROM auth.users WHERE id=${q(auth(404))}::uuid) AND (SELECT used_at IS NULL FROM public.member_invitations WHERE id='direct-taken')`);
  owner();
  raw("CREATE FUNCTION qa_test.direct_capacity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='direct-capacity-member' THEN RAISE EXCEPTION 'member_capacity' USING ERRCODE='PT409'; END IF; RETURN NEW; END $$; CREATE TRIGGER direct_capacity_fixture BEFORE INSERT ON public.members FOR EACH ROW EXECUTE FUNCTION qa_test.direct_capacity_guard();");
  service(); raw(invite('direct-capacity')+login(405,'direct-capacity'));
  error('member constraint failure rolls back direct attachment','SELECT '+accept('direct-capacity',405,'direct-capacity-member'),'PT409','member_capacity');
  raw(`INSERT INTO storage.objects(owner_id,owner) VALUES(${q(auth(405))},${q(auth(405))}::uuid);`);
  check('failed attachment leaves auth and storage intact and does not consume invitation',`EXISTS(SELECT 1 FROM auth.users WHERE id=${q(auth(405))}::uuid) AND EXISTS(SELECT 1 FROM storage.objects WHERE owner_id=${q(auth(405))} AND owner=${q(auth(405))}::uuid) AND NOT EXISTS(SELECT 1 FROM public.members WHERE auth_id=${q(auth(405))}::uuid) AND (SELECT used_at IS NULL FROM public.member_invitations WHERE id='direct-capacity')`);
  session('authenticated',405);
  check('isolated pending direct login has no active-member table access','(SELECT count(*)=0 FROM public.members)');
  owner(); raw('DROP TRIGGER direct_capacity_fixture ON public.members; DROP FUNCTION qa_test.direct_capacity_guard();');
  service();
  raw(invite('direct-attached')+login(406,'direct-attached')+`INSERT INTO public.members(id,name,email,avatar,auth_id) VALUES('direct-already-linked','Example Linked','other-linked@example.com','L',${q(auth(406))}::uuid);`);
  error('direct refuses an auth already linked to another member','SELECT '+accept('direct-attached',406),'PT409','email_taken');
  check('direct refuses attached auth without changing original binding',`(SELECT email='other-linked@example.com' AND auth_id=${q(auth(406))}::uuid FROM public.members WHERE id='direct-already-linked') AND (SELECT used_at IS NULL FROM public.member_invitations WHERE id='direct-attached')`);
}

export async function verifyDirectJoinRaces(execute) {
  let raceAssertions=0, realTwoSessionRaces=0;
  const assert=(ok,label)=>{if(!ok) throw new Error('Direct race assertion failed: '+label); raceAssertions++;};
  const count=async sql=>Number(await execute(sql));
  const rejected=(r,code,message)=>r.status==='rejected' && (!r.reason.code||r.reason.code===code) && r.reason.message.includes(message);
  await execute(serviceSQL+invite('direct-race-same')+login(450,'direct-race-same','direct-one@example.com')+login(451,'direct-race-same','direct-two@example.com'));
  const outcomes=await Promise.allSettled([execute(serviceSQL+'SELECT '+accept('direct-race-same',450,'direct-race-one','direct-one@example.com')),execute(serviceSQL+'SELECT '+accept('direct-race-same',451,'direct-race-two','direct-two@example.com'))]);
  realTwoSessionRaces++;
  assert(outcomes.filter(r=>r.status==='fulfilled').length===1,'one bearer invitation has one winner');
  assert(outcomes.filter(r=>rejected(r,'PT409','invalid_token')).length===1,'loser sees consumed invitation');
  assert(await count("SELECT count(*) FROM public.members WHERE id IN ('direct-race-one','direct-race-two') AND NOT email_identity_verified")===1,'only one unverified member attaches');
  assert(await count(`SELECT count(*) FROM auth.users WHERE id IN (${q(auth(450))}::uuid,${q(auth(451))}::uuid)`)===2,'loser fresh auth is preserved without automatic deletion');
  const ordered=async(id,n,change,undo,code,message,role='member')=>{
    await execute(serviceSQL+invite(id,role)+login(n,id));
    const marker='direct_'+id.replaceAll('-','_');
    const holder=execute(`SET application_name=${q(marker)}; BEGIN; ${change}; SELECT pg_sleep(0.8); COMMIT;`);
    holder.catch(()=>{});
    let observed=false;
    for(let i=0;i<80;i++){if(await count(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${q(marker)} AND wait_event='PgSleep'`)===1){observed=true;break;}await delay(10);}
    if(!observed){await holder;throw new Error('Direct lock holder not observed: '+id);}
    const result=await Promise.allSettled([holder,execute(serviceSQL+'SELECT '+accept(id,n))]);
    realTwoSessionRaces++;
    assert(result[0].status==='fulfilled',id+' mutation committed');
    assert(rejected(result[1],code,message),id+' rechecked after waiting');
    assert(await count(`SELECT count(*) FROM public.member_invitations WHERE id=${q(id)} AND used_at IS NULL`)===1,id+' token stays available');
    assert(await count(`SELECT count(*) FROM public.members WHERE auth_id=${q(auth(n))}::uuid`)===0,id+' no member attached');
    assert(await count(`SELECT count(*) FROM auth.users WHERE id=${q(auth(n))}::uuid`)===1,id+' new auth retained');
    if(undo)await execute(undo);
  };
  await ordered('direct-race-inactive',452,"UPDATE public.members SET is_active=false WHERE id='m-super'","UPDATE public.members SET is_active=true WHERE id='m-super'",'PT409','invalid_token');
  await ordered('direct-race-downgrade',453,"UPDATE public.members SET role='admin' WHERE id='m-super'","UPDATE public.members SET role='super_admin' WHERE id='m-super'",'PT409','invalid_token','admin');
  await ordered('direct-race-ban',454,`UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=${q(auth(454))}::uuid`,`UPDATE auth.users SET banned_until=NULL WHERE id=${q(auth(454))}::uuid`,'PT403','forbidden');
  await ordered('direct-race-email',455,"INSERT INTO public.members(id,name,email,avatar) VALUES('direct-race-other','Example Other','DIRECT-RACE-EMAIL@example.com','O')",'','PT409','email_taken');
  await ordered('direct-race-revoke',456,"UPDATE public.member_invitations SET revoked_at=now() WHERE id='direct-race-revoke'",'','PT409','invalid_token');
  await ordered('direct-race-expire',457,"UPDATE public.member_invitations SET expires_at=now()-interval '1 minute' WHERE id='direct-race-expire'",'','PT409','invalid_token');
  return {raceAssertions,realTwoSessionRaces};
}
