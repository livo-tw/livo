import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.98.0';
import { runQaUploadCleanup, type QaCleanupUpload, type QaUploadCleanupRepository } from './qaUploadCleanup.ts';
import { runTaskCommentUploadCleanup } from './taskCommentCleanup.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || request.headers.get('Authorization') !== `Bearer ${secret}`) return json({ error: 'forbidden' }, 403);
  const client = createClient(Deno.env.get('SUPABASE_URL')!, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = async (action: string, payload: Record<string, unknown> = {}) => {
    const { data, error } = await client.rpc('livo_qa_upload_cleanup', { p_action: action, p_payload: payload });
    if (error) throw new Error('qa_cleanup_database_failed');
    return data;
  };
  const identity = (upload: QaCleanupUpload) => ({ id: upload.id, token: upload.token });
  const valid = (upload: QaCleanupUpload) => upload.workspaceId === 'default' &&
    [upload.id, upload.issueId].every(value => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) &&
    upload.storageKey === `default/${upload.issueId}/${upload.id}`;
  const repository: QaUploadCleanupRepository = {
    claim: limit => db('claim', { limit }),
    owns: upload => valid(upload) ? db('owns', identity(upload)) : Promise.resolve(false),
    referenced: upload => db('referenced', identity(upload)),
    abortMultipart: async () => {},
    async remove(upload) {
      const { error } = await client.storage.from('qa-evidence').remove([upload.storageKey]);
      if (error) throw new Error('qa_cleanup_delete_failed');
    },
    finish: upload => db('finish', identity(upload)),
  };
  try {
    // A bounded task share runs before QA, so a permanent QA backlog cannot starve it.
    const task=await runTaskCommentUploadCleanup(client,4),remaining=25-task.claimed;
    const qa=remaining>0?await runQaUploadCleanup(repository,remaining):{claimed:0,removed:0,retained:0,failed:0};
    return json({claimed:task.claimed+qa.claimed,removed:task.removed+qa.removed,retained:task.retained+qa.retained,failed:task.failed+qa.failed,task,qa});
  }
  catch { return json({ error: 'qa_cleanup_failed' }, 503); }
});
