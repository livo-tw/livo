import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } } }));
import { knowledgeImportRequest } from '@/lib/knowledgeImportClient';

const httpError = (status: number, body: string) =>
  Object.assign(new Error('Edge Function returned a non-2xx status code'), { name: 'FunctionsHttpError', context: new Response(body, { status }) });

describe('knowledge import request errors', () => {
  beforeEach(() => invoke.mockReset());

  it('passes on the code the import function reports', async () => {
    invoke.mockResolvedValue({ data: null, error: httpError(413, JSON.stringify({ error: 'file_size_limit' })) });
    await expect(knowledgeImportRequest('start')).rejects.toThrow('file_size_limit');
  });

  it('reports a worker the Edge Runtime stopped as an interrupted import', async () => {
    // The runtime answers { msg } when the worker exceeds its memory limit.
    invoke.mockResolvedValue({ data: null, error: httpError(500, JSON.stringify({ msg: 'WorkerRequestCancelled: request has been cancelled by supervisor' })) });
    await expect(knowledgeImportRequest('start')).rejects.toThrow('import_interrupted');
  });

  it('reports a gateway error without JSON as an interrupted import', async () => {
    invoke.mockResolvedValue({ data: null, error: httpError(502, '<html>Bad Gateway</html>') });
    await expect(knowledgeImportRequest('get', { job_id: 'job' })).rejects.toThrow('import_interrupted');
  });

  it('reports a request that never reached the server as an interrupted import', async () => {
    invoke.mockResolvedValue({ data: null, error: Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError' }) });
    await expect(knowledgeImportRequest('get', { job_id: 'job' })).rejects.toThrow('import_interrupted');
  });
});
