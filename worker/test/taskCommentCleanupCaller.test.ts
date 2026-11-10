// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({task:vi.fn(),qa:vi.fn()}));
vi.mock('../src/taskComments',()=>({cleanupExpiredTaskCommentUploads:mock.task}));
vi.mock('../src/qaUploadCleanup',()=>({QA_UPLOAD_CLEANUP_LIMIT:25,QA_UPLOAD_SETTLE_MS:120000,QA_UPLOAD_TOMBSTONE_MS:86400000,runQaUploadCleanup:mock.qa}));
import { runScheduledQaUploadCleanup } from '../src/functions/qaUploadCleanup';
describe('existing workspace janitor shares its bounded budget fairly',()=>{
  let cursors:unknown[][];
  const environment=()=>({DB:{prepare:(sql:string)=>({first:async()=>({cursor:''}),bind:(...args:unknown[])=>({all:async()=>({results:[{id:'ws-a'},{id:'ws-b'}]}),run:async()=>{if(sql.includes('INSERT INTO qa_upload_maintenance_state'))cursors.push(args);return{};}})})},ATTACHMENTS:{}} as any);
  beforeEach(()=>{vi.clearAllMocks();cursors=[];mock.task.mockResolvedValue({claimed:4,removed:4,retained:0,failed:0});mock.qa.mockImplementation(async(_repository,limit)=>({claimed:limit,removed:limit,retained:0,failed:0}));});
  it('checks task files before a permanent QA backlog while preserving the total twenty-five limit and cursor',async()=>{
    const result=await runScheduledQaUploadCleanup(environment());
    expect(mock.task.mock.calls[0].slice(1)).toEqual(['ws-a',4]);expect(mock.qa.mock.calls[0][1]).toBe(21);expect(result.claimed).toBe(25);expect(cursors.at(-1)).toEqual(['ws-a']);
  });
  it('lets QA use all twenty-five slots when no task work was claimed',async()=>{
    mock.task.mockResolvedValue({claimed:0,removed:0,retained:0,failed:0});const result=await runScheduledQaUploadCleanup(environment());expect(mock.qa.mock.calls[0][1]).toBe(25);expect(result.claimed).toBe(25);
  });
  it('does not spend another provider budget after an unknown partial task claim failure',async()=>{
    mock.task.mockRejectedValue(new Error('unknown_DB_commit'));const result=await runScheduledQaUploadCleanup(environment());expect(mock.qa).not.toHaveBeenCalled();expect(result.failed).toBe(1);expect(cursors.at(-1)).toEqual(['ws-a']);
  });
});
