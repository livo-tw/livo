import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.98.0';
import { importJobPrefix, IMPORT_CLEANUP_FILE_LIMIT, runImportCleanup, type ImportCleanupRepository } from './knowledgeImportCleanup.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  // Service role only. A valid member JWT (including super_admin) is insufficient.
  if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) return json({ error: 'forbidden' }, 403);
  const client = createClient(Deno.env.get('SUPABASE_URL')!, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = async (action: string, payload: Record<string, unknown> = {}) => {
    const { data, error } = await client.rpc('knowledge_import_cleanup', { p_action: action, p_payload: payload });
    if (error) throw new Error('cleanup_database_failed');
    return data;
  };
  const repository: ImportCleanupRepository = {
    claim: (_now, _lease, token, limit) => db('claim', { token, limit }),
    async files(job) {
      const prefix = importJobPrefix(job), result: string[] = [], directories = [prefix.slice(0, -1)];
      while (directories.length) {
        const directory = directories.shift()!;
        let offset = 0;
        while (true) {
          const { data, error } = await client.storage.from('kb-imports').list(directory, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
          if (error) throw new Error('cleanup_list_failed');
          for (const item of data || []) {
            if (!item.name || item.name.includes('/') || item.name === '.' || item.name === '..') throw new Error('invalid_cleanup_object');
            const key = `${directory}/${item.name}`;
            if (item.id) result.push(key); else directories.push(key);
            if (result.length + directories.length > IMPORT_CLEANUP_FILE_LIMIT) throw new Error('cleanup_object_limit');
          }
          if (!data || data.length < 100) break;
          offset += data.length;
        }
      }
      return result;
    },
    retained: (job, keys) => db('retained', { job_id: job.id, token: job.lease_token, keys }),
    owns: (job) => db('owns', { job_id: job.id, token: job.lease_token }),
    async remove(_job, keys) {
      const { error } = await client.storage.from('kb-imports').remove(keys);
      if (error) throw new Error('cleanup_delete_failed');
      return keys.length;
    },
    finish: (job) => db('finish', { job_id: job.id, token: job.lease_token }),
  };
  try {
    const jobs = await runImportCleanup(repository);
    const scan = await db('orphan_scan');
    const orphans = { visited: Number(scan.visited) || 0, removed: 0, retained: 0, failed: 0 };
    if (!Array.isArray(scan.objects) || scan.objects.length > 100) throw new Error('cleanup_object_limit');
    for (const object of scan.objects) {
      try {
        // This endpoint owns only the dedicated import bucket. Normal knowledge
        // attachments and unknown inventory entries are never deletion targets.
        if (object.bucket_id !== 'kb-imports' || typeof object.key !== 'string' ||
            !/^[-A-Za-z0-9_.]{1,100}\/[-A-Za-z0-9_.]{1,100}\/[^/]+(?:\/[^/]+)*$/.test(object.key) ||
            /(?:^|\/)\.{1,2}(?:\/|$)|[\\\x00-\x1f\x7f]/.test(object.key)) throw new Error('invalid_cleanup_object');
        if (await db('orphan_check', object) !== true) { orphans.retained++; continue; }
        const { error } = await client.storage.from('kb-imports').remove([object.key]);
        if (error) throw new Error('cleanup_delete_failed');
        orphans.removed++;
      } catch { orphans.failed++; }
    }
    return json({ ...jobs, orphans });
  }
  catch { return json({ error: 'cleanup_failed' }, 503); }
});
