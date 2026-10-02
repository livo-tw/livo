import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Direct Slack Web API — no Lovable gateway. Self-contained to match the other
// docker/volumes/functions.
const SLACK_API = 'https://slack.com/api';

// Customer-bound bot token (slack_config) wins; SLACK_BOT_TOKEN env is fallback.
async function resolveSlackToken(supabase: any): Promise<string | undefined> {
  try {
    const { data } = await supabase
      .from('slack_config')
      .select('bot_token')
      .eq('id', 'singleton')
      .maybeSingle();
    if (data?.bot_token) return data.bot_token;
  } catch {
    // slack_config table may not exist on a pre-migration DB — fall through.
  }
  return Deno.env.get('SLACK_BOT_TOKEN') || undefined;
}

// Resolve a channel setting (name, '#name' or ID) to a channel ID.
async function resolveSlackChannelId(token: string, setting: string): Promise<string> {
  const name = setting.replace(/^#/, '');
  const resp = await fetch(
    `${SLACK_API}/conversations.list?limit=200&exclude_archived=true&types=public_channel,private_channel`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await resp.json();
  if (data.ok && data.channels) {
    const found = data.channels.find((c: any) => c.name === name || c.id === setting);
    if (found) return found.id;
  }
  return setting;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Check if this is a manual trigger or scheduled
    let isManual = false;
    try {
      const body = await req.json();
      isManual = body?.manual === true;
    } catch {
      // No body or invalid JSON
    }

    // ── Permission floor: manual invoke is super_admin-only ────────────────
    // The hourly scheduler sidecar (docker-compose livo-scheduler) calls this
    // function with the service-role key and no `manual` flag; that path (and
    // any caller presenting the service-role key) is exempt. A user-JWT
    // caller asking for a manual backup must be a super_admin member
    // (members.auth_id first, email fallback — same pattern as manage-member).
    if (isManual) {
      const authHeader = req.headers.get('Authorization') || '';
      const callerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if (callerToken !== serviceKey) {
        const deny = (error: string, status: number) =>
          new Response(JSON.stringify({ error }), {
            status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        if (!callerToken) return deny('Unauthorized', 401);
        const { data: { user: callerAuth }, error: callerErr } =
          await supabase.auth.getUser(callerToken);
        if (callerErr || !callerAuth) return deny('Invalid token', 401);
        let callerRole: string | null = null;
        const { data: byAuth } = await supabase
          .from('members').select('role').eq('auth_id', callerAuth.id).maybeSingle();
        callerRole = (byAuth as { role?: string } | null)?.role ?? null;
        if (!callerRole && callerAuth.email) {
          const { data: byEmail } = await supabase
            .from('members').select('role').eq('email', callerAuth.email).maybeSingle();
          callerRole = (byEmail as { role?: string } | null)?.role ?? null;
        }
        if (callerRole !== 'super_admin') {
          return deny('Permission denied: super_admin role required', 403);
        }
      }
    }

    // If scheduled, check if backup is enabled and due
    if (!isManual) {
      const { data: settings, error: settingsErr } = await supabase
        .from('backup_settings')
        .select('*')
        .limit(1)
        .single();

      console.log('Backup settings:', JSON.stringify({ enabled: settings?.enabled, backup_hour: settings?.backup_hour, interval_days: settings?.interval_days, last_backup_at: settings?.last_backup_at }), 'error:', settingsErr?.message);

      if (!settings?.enabled) {
        console.log('Backup not enabled, skipping');
        return new Response(JSON.stringify({ skipped: true, reason: 'Backup not enabled' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const now = new Date();
      const currentHourUTC = now.getUTCHours();
      const backupHourTW = settings.backup_hour ?? 3;
      const backupHourUTC = (backupHourTW - 8 + 24) % 24;

      console.log(`Hour check: currentUTC=${currentHourUTC}, configTW=${backupHourTW}, targetUTC=${backupHourUTC}`);

      // Only run at the configured hour (UTC)
      if (currentHourUTC !== backupHourUTC) {
        return new Response(JSON.stringify({ skipped: true, reason: `Not backup hour. Current UTC: ${currentHourUTC}, configured TW: ${backupHourTW} (UTC: ${backupHourUTC})` }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Check interval - but only compare against last SCHEDULED backup (not manual)
      // Use a simpler check: if a backup was done in the last (interval_days * 24 - 2) hours, skip
      if (settings.last_backup_at) {
        const lastBackup = new Date(settings.last_backup_at);
        const diffHours = (now.getTime() - lastBackup.getTime()) / (1000 * 60 * 60);
        const minIntervalHours = Math.max((settings.interval_days || 1) * 24 - 2, 12);
        console.log(`Interval check: lastBackup=${diffHours.toFixed(1)}h ago, minInterval=${minIntervalHours}h`);
        if (diffHours < minIntervalHours) {
          return new Response(JSON.stringify({ skipped: true, reason: `Not yet due. Last: ${diffHours.toFixed(1)}h ago, interval: ${minIntervalHours}h` }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      console.log('All checks passed, proceeding with backup');
    }

    // Perform backup - fetch ALL tables
    const tables = [
      'tasks', 'members', 'projects', 'statuses', 'sprints',
      'product_lines', 'comments', 'task_specs', 'task_checks',
      'task_todos', 'status_logs', 'task_deployments',
      'member_manuals', 'notifications', 'backup_settings',
      'activity_logs', 'task_attachments', 'user_column_configs', 'profiles',
      'qa_issues', 'qa_commands', 'qa_events', 'qa_comments', 'qa_uploads', 'qa_attachments', 'qa_slack_links',
    ];

    const backup: Record<string, any[]> = {};
    for (const table of tables) {
      if (table.startsWith('qa_')) {
        // QA tables are service-only. Include every metadata page; storage
        // objects remain in the separately backed-up Docker storage volume.
        backup[table] = [];
        for (let offset = 0; ; offset += 500) {
          const { data, error } = await supabase.from(table).select('*').eq('workspace_id', 'default').order('id').range(offset, offset + 499);
          if (error) throw new Error(`QA backup failed: ${table}`);
          backup[table].push(...(data || []));
          if (!data || data.length < 500) break;
        }
        continue;
      }
      const { data } = await supabase.from(table).select('*');
      backup[table] = data || [];
    }

    const jsonContent = JSON.stringify(backup, null, 2);
    const now = new Date();
    const filename = `backup_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.json`;

    // Upload to storage
    const { error: uploadError } = await supabase.storage
      .from('backups')
      .upload(filename, jsonContent, {
        contentType: 'application/json',
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return new Response(JSON.stringify({ error: 'Upload failed: ' + uploadError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const fileSize = new Blob([jsonContent]).size;
    const totalRecords = Object.values(backup).reduce((sum, arr) => sum + arr.length, 0);

    // Record in backup_history
    await supabase.from('backup_history').insert({
      filename,
      file_size: fileSize,
      storage_path: filename,
    });

    // Update last_backup_at only for scheduled backups (not manual)
    if (!isManual) {
      await supabase
        .from('backup_settings')
        .update({ last_backup_at: now.toISOString() } as any)
        .not('id', 'is', null);
    }

    // Send Slack notification if configured
    const { data: settings } = await supabase
      .from('backup_settings')
      .select('notify_channel')
      .limit(1)
      .single();

    let slackSent = false;
    const notifyChannel = (settings as any)?.notify_channel;

    if (notifyChannel) {
      // Direct Slack Web API with the customer-bound bot token (slack_config) or
      // the SLACK_BOT_TOKEN env fallback — no Lovable gateway.
      const slackToken = await resolveSlackToken(supabase);

      if (slackToken) {
        try {
          const resolvedChannel = await resolveSlackChannelId(slackToken, notifyChannel);

          const fileSizeStr = fileSize < 1024 ? `${fileSize} B`
            : fileSize < 1024 * 1024 ? `${(fileSize / 1024).toFixed(1)} KB`
            : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;

          const tableSummary = Object.entries(backup)
            .filter(([_, rows]) => rows.length > 0)
            .map(([name, rows]) => `• ${name}: ${rows.length} 筆`)
            .join('\n');

          const message = [
            `✅ *系統備份完成*`,
            ``,
            `📁 檔案：\`${filename}\``,
            `📊 總資料量：${totalRecords} 筆`,
            `💾 檔案大小：${fileSizeStr}`,
            `🕐 時間：${new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0]} (台灣時間)`,
            ``,
            `*各表格明細：*`,
            tableSummary,
          ].join('\n');

          const slackResp = await fetch(`${SLACK_API}/chat.postMessage`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${slackToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify({
              channel: resolvedChannel,
              text: message,
              username: 'PM 系統備份',
              icon_emoji: ':floppy_disk:',
            }),
          });

          const slackData = await slackResp.json();
          if (slackData.ok) {
            slackSent = true;
            console.log('[slack] backup notification sent');
          } else {
            console.error('[slack] backup notify error:', slackData.error);
          }
        } catch (slackErr) {
          console.error('[slack] backup notification error:', slackErr);
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      filename,
      totalRecords,
      fileSize,
      slackNotified: slackSent,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Backup error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
