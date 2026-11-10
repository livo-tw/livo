// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { taskCommentBackupManifest } from '../src/functions/backup';
import type { Env } from '../src/env';
describe('private task-comment JSON manifest',()=>{
 it.each([0,3])('records retained count %s while excluding all private rows, bytes and command receipts',async count=>{
  const first=vi.fn().mockResolvedValue({retained:count}),bind=vi.fn((_ws:string)=>({first})),prepare=vi.fn((_sql:string)=>({bind}));
  const manifest=await taskCommentBackupManifest({DB:{prepare}} as unknown as Pick<Env,'DB'>,'example-workspace');
  expect(bind).toHaveBeenCalledWith('example-workspace');expect(prepare.mock.calls[0][0]).toContain("state<>'aborted'");
  expect(manifest).toMatchObject({kind:'task_comment_private_media',retainedMetadata:count,coverageKnown:true,coveredByJsonBackup:false,privateObjectBytesExcluded:true,commandReceiptsExcluded:true,commandReceiptsNeverReplayed:true,requiresDatabaseAndPrivateStorageBackup:true});
  expect(manifest.excludedTables).toEqual(['task_comment_uploads','task_comment_commands']);expect(manifest).not.toHaveProperty('storage_key');
 });
 it.each([undefined,{retained:null},{retained:'0'},{retained:-1}])('never converts incomplete inventory %j to zero',async row=>{
  const manifest=await taskCommentBackupManifest({DB:{prepare:()=>({bind:()=>({first:async()=>row})})}} as unknown as Pick<Env,'DB'>,'example-workspace');
  expect(manifest).toMatchObject({retainedMetadata:null,coverageKnown:false});
 });
 it('preserves unknown coverage when the inventory query fails',async()=>{
  const manifest=await taskCommentBackupManifest({DB:{prepare:()=>({bind:()=>({first:async()=>{throw new Error('read denied');}})})}} as unknown as Pick<Env,'DB'>,'example-workspace');
  expect(manifest).toMatchObject({retainedMetadata:null,coverageKnown:false});
 });
});
