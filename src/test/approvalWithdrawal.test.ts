import {describe,expect,it,vi} from 'vitest';
import {withdrawApproval,withdrawAllAndDisable} from '@/lib/withdrawApproval';
type DB=Parameters<typeof withdrawApproval>[0];
const request={id:'request-1',version:3};
function fixture() {
 const query={select:vi.fn(()=>query),eq:vi.fn(()=>query),single:vi.fn(async()=>({data:request,error:null}))};
 const from=vi.fn(()=>query);
 return {db:{from} as unknown as DB,query,from};
}
describe('atomic approval withdrawal client',()=>{
 it('only reads the observed request then submits a versioned command',async()=>{
  const {db,from}=fixture();
  const run=vi.fn(async()=>({})) as unknown as NonNullable<Parameters<typeof withdrawApproval>[2]>;
  await withdrawApproval(db,'request-1',run);
  expect(from).toHaveBeenCalledOnce();expect(from).toHaveBeenCalledWith('approval_requests');
  expect(run).toHaveBeenCalledWith({operation:'withdraw',requestId:'request-1',expectedVersion:3});
 });
 it('propagates server failure instead of clearing task fields',async()=>{
  const {db,from}=fixture();
  const run=vi.fn(async()=>{throw new Error('approval_forbidden');});
  await expect(withdrawApproval(db,'request-1',run)).rejects.toThrow('approval_forbidden');
  expect(from).toHaveBeenCalledOnce();
 });
 it('refuses to submit when the current request cannot be read',async()=>{
  const {db,query}=fixture();query.single.mockResolvedValueOnce({data:null as never,error:null});
  const run=vi.fn(async()=>{throw new Error('should not call');});
  await expect(withdrawApproval(db,'request-1',run)).rejects.toThrow('approval_unavailable');expect(run).not.toHaveBeenCalled();
 });
 it('withdraws every request and rechecks before OFF',async()=>{
  const order:string[]=[];
  await withdrawAllAndDisable([{id:'r1'},{id:'r2'}],async id=>{order.push(id);return true;},async()=>{order.push('recheck');return[];},async()=>{order.push('disable');});
  expect(order).toEqual(['r1','r2','recheck','disable']);
 });
 it('never turns OFF after failure or concurrent new request',async()=>{
  const disable=vi.fn();
  await expect(withdrawAllAndDisable([{id:'r'}],async()=>false,async()=>[],disable)).rejects.toThrow();
  await expect(withdrawAllAndDisable([],async()=>true,async()=>[{id:'new'}],disable)).rejects.toThrow();
  expect(disable).not.toHaveBeenCalled();
 });
});
