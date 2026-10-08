// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {memberEmailIdentityVerified} from '@/lib/slackNotifyCore';
import {matchEmail,slackEmailBelongsToOther} from '../../docker/volumes/functions/slack-interact/core';
import {deliveryStore} from '../../docker/volumes/functions/slack-deliver/backend';

afterEach(()=>vi.unstubAllGlobals());
const direct={id:'direct',email:'person@example.com',auth_id:'auth-direct',is_active:true,email_identity_verified:false};
const owner={id:'owner',role:'super_admin',is_active:true};
describe('login emails do not assert identity ownership',()=>{
  it.each([false,0,null,undefined,'true'])('rejects an unproved flag %s',flag=>{
    expect(memberEmailIdentityVerified({email_identity_verified:flag})).toBe(false);
    expect(matchEmail([{...direct,email_identity_verified:flag}],'person@example.com')).toBeUndefined();
  });
  it.each([true,1])('accepts the database verified value %s',flag=>{
    const member={...direct,email_identity_verified:flag};
    expect(memberEmailIdentityVerified(member)).toBe(true);
    expect(matchEmail([member],'PERSON@example.com')).toEqual(member);
  });
  it('a self-asserted address cannot block an independently verified manual mapping',()=>{
    expect(slackEmailBelongsToOther([direct],'person@example.com','owner')).toBe(false);
    expect(slackEmailBelongsToOther([{...direct,email_identity_verified:true}],'person@example.com','owner')).toBe(true);
  });
  it.each([
    ['email',undefined,false,undefined],
    ['admin','owner',false,'UEXAMPLE'],
    ['admin','plain',false,undefined],
    ['email',undefined,true,'UEXAMPLE'],
  ])('Docker recipient trusts %s by %s with flag %s only accordingly',async(kind,issuer,flag,expected)=>{
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const url=new URL(String(input)),table=url.pathname.split('/').pop();
      const rows=table==='members'?[{...direct,email_identity_verified:flag},owner,{id:'plain',role:'admin',is_active:true}]
        :table==='external_account_bindings'?[{id:'binding',member_id:'direct',platform:'slack',platform_team_id:'TEXAMPLE',platform_user_id:'UEXAMPLE',is_verified:true,verified_by:kind,verified_by_member_id:issuer,reconfirm_required:false}]:[];
      return Response.json(rows.filter(row=>[...url.searchParams].every(([key,value])=>!value.startsWith('eq.')||String((row as Record<string,unknown>)[key])===value.slice(3))));
    }));
    expect(await deliveryStore({get:key=>key==='SUPABASE_URL'?'https://db.example.com':'example'}).binding('direct','TEXAMPLE')).toBe(expected);
  });
});
