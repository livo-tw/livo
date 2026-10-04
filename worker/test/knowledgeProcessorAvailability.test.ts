// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createKnowledgeImport, defaultImportPolicy, ImportError, parseWithProcessor, PROCESSOR_TIMEOUT_MS, type ImportConfig, type ImportRepository } from '../src/knowledgeImport';

const token = 'processor-token-'.repeat(3);
const md = new TextEncoder().encode('# Example');
const processor = (fetcher: typeof fetch): ImportConfig => ({ processorUrl: 'http://knowledge-processor:8091', processorToken: token, fetcher });
const failure = async (config: ImportConfig) => {
  try { await parseWithProcessor(config, 'md', md); } catch (error) { if (error instanceof ImportError) return error; throw error; }
  throw new Error('expected an ImportError');
};

describe('optional knowledge processor', () => {
  it('reports an absent, stopped or unreachable processor as a clear item error', async () => {
    expect((await failure({ processorUrl: '', processorToken: token })).code).toBe('processor_not_configured');
    expect((await failure({ processorUrl: 'not a url', processorToken: token })).code).toBe('invalid_processor_configuration');
    const refused = await failure(processor(async () => { throw new TypeError('fetch failed'); }));
    expect([refused.code, refused.status]).toEqual(['processor_unavailable', 503]);
    expect((await failure(processor(async () => { throw new DOMException('timed out', 'TimeoutError'); }))).code).toBe('processing_timeout');
    expect((await failure(processor(async () => new Response('<html>Bad gateway</html>', { status: 502 })))).code).toBe('processor_unavailable');
    expect((await failure(processor(async () => new Response(JSON.stringify({ error: 'processor_not_configured' }), { status: 503 })))).code).toBe('processor_not_configured');
    expect((await failure(processor(async () => new Response(JSON.stringify({ error: 'processor_busy' }), { status: 429 })))).code).toBe('processor_busy');
  });

  it('waits for the processor longer than its parse budget and less than the function limit', () => {
    const server = readFileSync(new URL('../../docker/knowledge-processor/server.py', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../../docker/volumes/functions/main/index.ts', import.meta.url), 'utf8');
    const budget = Number(server.match(/^BUDGET = (\d+)$/m)?.[1]) * 1000;
    const functionLimit = Number(main.match(/serviceName === 'knowledge-import' \? ([\d_]+)/)?.[1].replace(/_/g, ''));
    expect(budget).toBeGreaterThan(0);
    expect(PROCESSOR_TIMEOUT_MS).toBeGreaterThan(budget);
    expect(functionLimit).toBeGreaterThan(PROCESSOR_TIMEOUT_MS);
  });

  it('tells the importer the processor is not configured when its URL is empty', async () => {
    const repo = { actor: async () => ({ id: 'person', role: 'super_admin', job_title: 'PM', is_active: true }), policy: async () => defaultImportPolicy(), pages: async () => [] } as unknown as ImportRepository;
    expect(await createKnowledgeImport(repo, { processorUrl: '', processorToken: token })({ action: 'capability' })).toMatchObject({ allowed: true, processor_configured: false });
    expect(await createKnowledgeImport(repo, { processorUrl: 'http://knowledge-processor:8091', processorToken: token })({ action: 'capability' })).toMatchObject({ processor_configured: true });
  });
});
