// Jira CSV importer (self-hosted edge function).
// Contract C2 (mirrors worker/src/functions/importJira.ts):
//   - non-professional callers get a SAFE DRY-RUN (parse + stats, ZERO writes)
//   - professional callers get the real, destructive import
// Fixes vs. the legacy version: members are loaded from the DB (no hardwired
// demo ids), unknown members get unique placeholder emails, creator falls back
// to the importing user, missing projects are auto-created, and stats reflect
// ACTUAL inserts instead of parsed counts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ── License check (inline — docker tree functions are self-contained) ──
type LicenseTier = 'none' | 'standard' | 'professional';

async function verifyLicense(supabase: any): Promise<{ tier: LicenseTier; isValid: boolean }> {
  try {
    const { data, error } = await supabase.rpc('check_license');
    if (error) throw error;
    return {
      tier: data?.valid ? (data.tier as LicenseTier) : 'none',
      isValid: data?.valid || false,
    };
  } catch (e) {
    console.error('[license] check_license RPC failed:', e);
    return { tier: 'none', isValid: false };
  }
}

// ── Chinese date parsing ──
const monthMap: Record<string, number> = {
  '一月': 0, '二月': 1, '三月': 2, '四月': 3, '五月': 4, '六月': 5,
  '七月': 6, '八月': 7, '九月': 8, '十月': 9, '十一月': 10, '十二月': 11,
};

function parseChineseDateTime(s: string): string | null {
  if (!s?.trim()) return null;
  const m = s.match(/(\d+)\/([一-鿿]+)\/(\d+)\s+(\d+):(\d+)\s*(上午|下午)/);
  if (!m) return null;
  const [, day, mCh, yr, hr, min, ap] = m;
  const month = monthMap[mCh];
  if (month === undefined) return null;
  let h = parseInt(hr);
  if (ap === '下午' && h !== 12) h += 12;
  if (ap === '上午' && h === 12) h = 0;
  const d = new Date(2000 + parseInt(yr), month, parseInt(day), h, parseInt(min));
  return d.toISOString().split('.')[0] + 'Z';
}

function parseDateOnly(s: string): string | null {
  if (!s?.trim()) return null;
  const m = s.match(/(\d+)\/([一-鿿]+)\/(\d+)/);
  if (!m) return null;
  const [, day, mCh, yr] = m;
  const month = monthMap[mCh];
  if (month === undefined) return null;
  return `${2000 + parseInt(yr)}-${String(month + 1).padStart(2, '0')}-${String(parseInt(day)).padStart(2, '0')}`;
}

/** "2026-04-01T..." → "2026-04-01"; strings without 'T' pass through unchanged. */
function dateOnlyPart(s: string): string {
  const i = s.indexOf('T');
  return i >= 0 ? s.slice(0, i) : s;
}

// ── Simple CSV parser that handles quoted multi-line fields ──
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const len = text.length;

  // Remove BOM
  if (text.charCodeAt(0) === 0xFEFF) i = 1;

  while (i < len) {
    const row: string[] = [];
    while (i < len) {
      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        let field = '';
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field);
      } else {
        // Unquoted field
        let field = '';
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i];
          i++;
        }
        row.push(field);
      }

      if (i < len && text[i] === ',') {
        i++; // skip comma
      } else {
        break; // end of row
      }
    }
    // Skip newline(s)
    while (i < len && (text[i] === '\r' || text[i] === '\n')) i++;

    if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
      rows.push(row);
    }
  }
  return rows;
}

// ── Convert Jira wiki markup / markdown-ish to HTML ──
function textToHtml(text: string, jiraIdToName?: Record<string, string>, memberMap?: Record<string, string>): string {
  if (!text) return '';

  // If content already contains HTML tags (like <p>, <h2>), return as-is
  // but still process mentions
  if (/<[a-z][\s\S]*>/i.test(text)) {
    // Still resolve mentions in existing HTML
    let html = text;
    if (jiraIdToName && memberMap) {
      html = html.replace(/\[~accountid:([^\]]+)\]/g, (_m, accId) => {
        const name = jiraIdToName[accId.trim()];
        if (name) {
          const memberId = memberMap[name] || '';
          return `<span class="mention" data-id="${memberId}">@${name}</span>`;
        }
        return '@unknown';
      });
    }
    html = html.replace(/@user/g, '@成員');
    return html;
  }

  // Process line by line for Jira wiki markup
  const lines = text.split('\n');
  const result: string[] = [];
  let inList = false;
  let listLevel = 0;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Jira table header row: ||col1||col2||
    if (/^\|\|.+\|\|/.test(line)) {
      if (inList) { for (let d = listLevel; d > 0; d--) result.push('</ul>'); inList = false; listLevel = 0; }
      if (!inTable) { result.push('<table>'); inTable = true; }
      const cells = line.split('||').filter(c => c !== '');
      result.push('<tr>' + cells.map(c => `<th>${processInline(c.trim(), jiraIdToName, memberMap)}</th>`).join('') + '</tr>');
      continue;
    }

    // Jira table data row: |col1|col2|
    if (/^\|[^|]/.test(line) && line.endsWith('|')) {
      if (inList) { for (let d = listLevel; d > 0; d--) result.push('</ul>'); inList = false; listLevel = 0; }
      if (!inTable) { result.push('<table>'); inTable = true; }
      const cells = line.slice(1, -1).split('|');
      result.push('<tr>' + cells.map(c => `<td>${processInline(c.trim(), jiraIdToName, memberMap)}</td>`).join('') + '</tr>');
      continue;
    }

    // Close table if we're no longer in table rows
    if (inTable) { result.push('</table>'); inTable = false; }

    // Jira headings: h1. h2. h3. h4. h5. h6.
    const headingMatch = line.match(/^h([1-6])\.\s+(.+)$/);
    if (headingMatch) {
      if (inList) { result.push('</ul>'); inList = false; }
      const level = headingMatch[1];
      const content = processInline(headingMatch[2], jiraIdToName, memberMap);
      result.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    // Jira bullet lists: * item, ** sub-item, *** sub-sub-item
    const bulletMatch = line.match(/^(\*+)\s+(.+)$/);
    if (bulletMatch) {
      const depth = bulletMatch[1].length;
      const content = processInline(bulletMatch[2], jiraIdToName, memberMap);
      if (!inList) { result.push('<ul>'); inList = true; listLevel = depth; }
      else if (depth > listLevel) { result.push('<ul>'); listLevel = depth; }
      else if (depth < listLevel) {
        for (let d = listLevel; d > depth; d--) result.push('</ul>');
        listLevel = depth;
      }
      result.push(`<li>${content}</li>`);
      continue;
    }

    // Jira numbered lists: # item, ## sub-item
    const numberedMatch = line.match(/^(#+)\s+(.+)$/);
    if (numberedMatch) {
      const content = processInline(numberedMatch[2], jiraIdToName, memberMap);
      if (!inList) { result.push('<ol>'); inList = true; }
      result.push(`<li>${content}</li>`);
      continue;
    }

    // Markdown-style bullet: - item
    const mdBulletMatch = line.match(/^-\s+(.+)$/);
    if (mdBulletMatch) {
      const content = processInline(mdBulletMatch[1], jiraIdToName, memberMap);
      if (!inList) { result.push('<ul>'); inList = true; }
      result.push(`<li>${content}</li>`);
      continue;
    }

    // Markdown-style numbered: 1. item
    const mdNumMatch = line.match(/^\d+\.\s+(.+)$/);
    if (mdNumMatch) {
      const content = processInline(mdNumMatch[1], jiraIdToName, memberMap);
      if (!inList) { result.push('<ol>'); inList = true; }
      result.push(`<li>${content}</li>`);
      continue;
    }

    // Close list if we hit a non-list line
    if (inList) {
      for (let d = listLevel; d > 0; d--) result.push('</ul>');
      inList = false;
      listLevel = 0;
    }

    // Empty line → paragraph break
    if (line.trim() === '') {
      continue;
    }

    // Horizontal rule: ----
    if (/^-{4,}$/.test(line.trim())) {
      result.push('<hr/>');
      continue;
    }

    // Regular paragraph line
    result.push(`<p>${processInline(line, jiraIdToName, memberMap)}</p>`);
  }

  // Close any remaining structures
  if (inTable) result.push('</table>');
  if (inList) {
    for (let d = listLevel; d > 0; d--) result.push('</ul>');
  }

  return result.join('\n');
}

// Process inline Jira wiki markup
function processInline(text: string, jiraIdToName?: Record<string, string>, memberMap?: Record<string, string>): string {
  // Escape HTML entities first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Jira bold: *text*  (but not ** which is sub-bullet)
  html = html.replace(/\*([^\s*][^*]*[^\s*])\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^\s*])\*/g, '<strong>$1</strong>');

  // Markdown bold: **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Jira italic: _text_
  html = html.replace(/_([^\s_][^_]*[^\s_])_/g, '<em>$1</em>');
  html = html.replace(/_([^\s_])_/g, '<em>$1</em>');

  // Jira strikethrough: -text- (strict + safe mode to avoid corrupting URLs / links / tech tokens)
  html = html.replace(/(^|[\s([{「『“‘"'`])-([^\n\r\-]{1,60}?)-(?=$|[\s)\]}」』”’"'`.,;!?])/g, (full, prefix, inner) => {
    const value = String(inner || '').trim();
    if (!value) return full;
    if (/(https?:\/\/|www\.|\.com|\.net|\.org|\.io|@|\/|\\|\|)/i.test(value)) return full;
    return `${prefix}<s>${value}</s>`;
  });

  // Markdown strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Jira inline code: {{text}}
  html = html.replace(/\{\{(.+?)\}\}/g, '<code>$1</code>');

  // Markdown inline code: `text`
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');

  // Jira color: {color:#hex}text{color}
  html = html.replace(/\{color:(#[0-9a-fA-F]+)\}(.*?)\{color\}/g, '<span style="color:$1">$2</span>');

  // Jira images: !image.png|width=X,height=Y! → [image]
  html = html.replace(/!([^|!]+)\|[^!]*!/g, '[圖片: $1]');
  html = html.replace(/!([^!]+)!/g, '[圖片: $1]');

  // Jira links: [text|url] or [url]
  html = html.replace(/\[([^|]+)\|([^\]]+)\]/g, '<a href="$2">$1</a>');
  html = html.replace(/\[(https?:\/\/[^\]]+)\]/g, '<a href="$1">$1</a>');

  // Jira user mentions: [~accountid:xxx] → resolve to actual name
  if (jiraIdToName && memberMap) {
    html = html.replace(/\[~accountid:([^\]]+)\]/g, (_m: string, accId: string) => {
      const name = jiraIdToName[accId.trim()];
      if (name) {
        const memberId = memberMap[name] || '';
        return `<span class="mention" data-id="${memberId}">@${name}</span>`;
      }
      return '@成員';
    });
  } else {
    html = html.replace(/\[~accountid:[^\]]+\]/g, '@成員');
  }
  return html;
}

// ── Priority mapping ──
function mapPriority(p: string): string {
  const m: Record<string, string> = {
    'Highest': 'highest', 'High': 'high', 'Medium': 'medium',
    'Low': 'low', 'Lowest': 'lowest',
  };
  return m[p] || 'medium';
}

// ── Status mapping (Jira → DB status ID) ──
function mapStatusId(s: string): string {
  const m: Record<string, string> = {
    '待办': 's1', '待辦': 's1',
    '正在进行': 's2', '正在進行': 's2',
    '待驗收': 's3', '待验收': 's3',
    '待討論確認': 's4', '待讨论确认': 's4',
    '等待部署': 's5',
    '已完成': 's6', '完成': 's6',
    '不做了': 's7',
  };
  return m[s] || 's1';
}

// Resolve the importing user's member id from the Authorization header.
// Falls back to the first admin, then the first member, then legacy 'u1' —
// the legacy hardcoded 'u1' doesn't exist on fresh customer installs and
// would make every task insert fail its creator_id FK.
async function resolveImporterMemberId(supabase: any, req: Request): Promise<string> {
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      const { data: userData } = await supabase.auth.getUser(token);
      const user = userData?.user;
      if (user) {
        const { data: byAuthId } = await supabase
          .from('members').select('id').eq('auth_id', user.id).limit(1);
        if (byAuthId && byAuthId[0]?.id) return byAuthId[0].id;
        if (user.email) {
          const { data: byEmail } = await supabase
            .from('members').select('id').eq('email', user.email).limit(1);
          if (byEmail && byEmail[0]?.id) return byEmail[0].id;
        }
      }
    }
  } catch (e) {
    console.error('Resolve importer error:', e);
  }
  try {
    const { data: admins } = await supabase
      .from('members').select('id').in('role', ['super_admin', 'admin']).limit(1);
    if (admins && admins[0]?.id) return admins[0].id;
    const { data: anyMember } = await supabase.from('members').select('id').limit(1);
    if (anyMember && anyMember[0]?.id) return anyMember[0].id;
  } catch (e) {
    console.error('Fallback member lookup error:', e);
  }
  return 'u1';
}

// Row shapes
type NewMemberRow = {
  id: string; name: string; avatar: string; role: string;
  email: string; color: string; job_title: string; is_active: boolean;
};

type TaskRow = {
  id: string; task_key: string; project_id: string; title: string;
  status_id: string; priority: string; creator_id: string;
  assignee_id: string | null; reviewer_id: string | null;
  due_date: string | null; started_at: string | null; completed_at: string | null;
  sort_order: number; created_at: string; comment_count: number;
  sprint_id: string | null; department: string | null;
};

type CommentRow = { id: string; task_id: string; user_id: string; content: string; created_at: string };
type SpecRow = { id: string; task_id: string; background: string; requirement: string; notes: string };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Permission floor: caller must be an admin/super_admin member ────────
    // The import wipes and rewrites tasks/sprints/comments — a plain member
    // JWT must never reach it. Same caller-role pattern as manage-member
    // (members.auth_id first, email fallback). A caller presenting the
    // service-role key itself (server-side scripting) is allowed through.
    {
      const authHeader = req.headers.get('Authorization') || '';
      const callerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if (callerToken !== serviceKey) {
        if (!callerToken) return json({ error: 'Unauthorized' }, 401);
        const { data: { user: callerAuth }, error: callerErr } =
          await supabase.auth.getUser(callerToken);
        if (callerErr || !callerAuth) return json({ error: 'Invalid token' }, 401);
        let callerRole: string | null = null;
        const { data: byAuth } = await supabase
          .from('members').select('role').eq('auth_id', callerAuth.id).maybeSingle();
        callerRole = (byAuth as { role?: string } | null)?.role ?? null;
        if (!callerRole && callerAuth.email) {
          const { data: byEmail } = await supabase
            .from('members').select('role').eq('email', callerAuth.email).maybeSingle();
          callerRole = (byEmail as { role?: string } | null)?.role ?? null;
        }
        if (!callerRole || !['admin', 'super_admin'].includes(callerRole)) {
          return json({ error: 'Permission denied: admin role required' }, 403);
        }
      }
    }

    // Tier behavior (contract C2): non-professional callers get a SAFE DRY-RUN
    // (parse + stats, ZERO writes); professional callers get the real,
    // destructive import. isPro is resolved up front but only *enforced* after
    // the CSV is fully parsed into memory — the branch happens right before the
    // first DELETE, so a non-pro caller never writes to the DB.
    const license = await verifyLicense(supabase);
    const isPro = license.tier === 'professional';

    const csvText = await req.text();
    console.log('CSV length:', csvText.length);

    const rows = parseCSV(csvText);
    console.log('Parsed rows:', rows.length);

    if (rows.length < 2) {
      return json({ error: 'No data rows' }, 400);
    }

    const headers = rows[0];

    // Find column index by header name
    const col = (name: string) => headers.findIndex(h => h.trim() === name);

    // Find ALL indices for a repeated column name
    const colAll = (name: string) => {
      const indices: number[] = [];
      headers.forEach((h, i) => { if (h.trim() === name) indices.push(i); });
      return indices;
    };

    // Sprint columns may be exported as English (Sprint) or Chinese (冲刺) and can repeat.
    const sprintIndices = Array.from(new Set([
      ...colAll('Sprint'),
      ...colAll('冲刺'),
    ]));

    const extractSprintName = (raw: string): string | null => {
      const s = (raw || '').trim();
      if (!s) return null;

      // Typical Jira export format contains: name=202603W1
      const matches = Array.from(s.matchAll(/name=([^,\]]+)/g));
      if (matches.length > 0) return String(matches[matches.length - 1][1]).trim();

      // JSON-ish payloads
      const jsonMatch = s.match(/"name"\s*:\s*"([^"]+)"/);
      if (jsonMatch) return jsonMatch[1].trim();

      // Plain sprint name fallback
      if (s.length <= 120 && !/com\.atlassian\.|\bid=\d+\b/i.test(s)) return s;

      return null;
    };

    const getSprintNameFromRow = (row: string[]): string => {
      if (sprintIndices.length === 0) return '';
      // Prefer the last non-empty sprint cell (often the most recent)
      for (let j = sprintIndices.length - 1; j >= 0; j--) {
        const idx = sprintIndices[j];
        const name = extractSprintName(row[idx] || '');
        if (name) return name;
      }
      return '';
    };

    const iTitle = col('摘要');
    const iKey = col('事务密钥');
    const iStatus = col('状态');
    const iProjKey = col('项目键');
    const iProjName = col('项目名称');
    const iPriority = col('优先级');
    const iAssignee = col('经办人');
    const iAssigneeId = col('经办人 ID');
    const iReporter = col('报告人');
    const iReporterId = col('报告人 ID');
    const iCreator = col('创建者');
    const iCreatorId = col('创建者 ID');
    const iCreated = col('已创建');
    const iResolved = col('已解决');
    const iDueDate = col('截止日期');
    const iStartDate = col('自定义字段 (Start date)');
    const iDescription = col('描述');
    const commentIndices = colAll('评论');

    console.log('Column indices:', {
      iTitle, iKey, iStatus, iProjKey, iPriority, iAssignee, iReporter, iCreated,
      sprintColumns: sprintIndices.length,
      commentColumns: commentIndices.length,
    });

    // Build jira account ID → name mapping from CSV data
    const jiraIdToName: Record<string, string> = {};
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const assignee = row[iAssignee]?.trim();
      const assigneeId = row[iAssigneeId]?.trim();
      const reporter = row[iReporter]?.trim();
      const reporterId = row[iReporterId]?.trim();
      const creator = row[iCreator]?.trim();
      const creatorId = row[iCreatorId]?.trim();
      if (assignee && assigneeId) jiraIdToName[assigneeId] = assignee;
      if (reporter && reporterId) jiraIdToName[reporterId] = reporter;
      if (creator && creatorId) jiraIdToName[creatorId] = creator;
    }

    // Create missing members. Existing members are reused by exact name;
    // everyone else becomes a new member (re-imports must not recycle
    // already-taken uN ids).
    const allNames = new Set(Object.values(jiraIdToName));
    const { data: existingMembersData, error: existingMembersErr } = await supabase
      .from('members').select('id, name');
    if (existingMembersErr) throw new Error(`Load members failed: ${existingMembersErr.message}`);
    const existingMembers: { id: string; name: string }[] = existingMembersData || [];
    const memberMap: Record<string, string> = {};
    let memberCounter = 10;
    for (const m of existingMembers) {
      if (!memberMap[m.name]) memberMap[m.name] = m.id;
      const um = /^u(\d+)$/.exec(m.id);
      if (um) memberCounter = Math.max(memberCounter, parseInt(um[1], 10) + 1);
    }
    const newMembers: NewMemberRow[] = [];

    for (const name of allNames) {
      if (!memberMap[name]) {
        const id = `u${memberCounter++}`;
        memberMap[name] = id;
        newMembers.push({
          id, name, avatar: name[0]?.toUpperCase() || '?',
          // email must be unique per member — two '' rows would collide on
          // installs that enforce unique member emails.
          role: 'member', email: `${id}@import.invalid`, color: '#6B778C', job_title: '',
          is_active: true,
        });
      }
    }

    // Fallback identity for rows with no resolvable reporter/creator: the
    // importing user (the legacy hardcoded 'u1' doesn't exist on fresh installs).
    const fallbackMemberId = await resolveImporterMemberId(supabase, req);

    // Build jiraId → memberId mapping
    const jiraIdToMemberId: Record<string, string> = {};
    for (const [jiraId, name] of Object.entries(jiraIdToName)) {
      jiraIdToMemberId[jiraId] = memberMap[name] || fallbackMemberId;
    }

    // ── Build sprint mapping (ids generated here so tasks can reference them;
    //    NO DB write yet — the actual insert happens only on the pro path). ──
    const sprintNames = new Set<string>();
    const sprintMap = new Map<string, string>(); // jira sprint name → db sprint id
    for (let r = 1; r < rows.length; r++) {
      const sprintName = getSprintNameFromRow(rows[r]);
      if (sprintName) sprintNames.add(sprintName);
    }
    for (const sprintName of sprintNames) {
      sprintMap.set(sprintName, crypto.randomUUID());
    }

    // ── Projects: one LIVO project per Jira project key. A project with the
    //    same key is reused (projects are not cleared, so a re-import lands in
    //    the same place); any other key becomes a new project named after the
    //    Jira project, created on the real-import path below. ──
    const { data: existingProjectsData, error: existingProjectsErr } = await supabase
      .from('projects').select('id, key');
    if (existingProjectsErr) throw new Error(`Load projects failed: ${existingProjectsErr.message}`);
    const projectIdByKey = new Map<string, string>();
    for (const p of (existingProjectsData || []) as { id: string; key: string }[]) {
      const k = (p.key || '').trim().toUpperCase();
      if (k && !projectIdByKey.has(k)) projectIdByKey.set(k, p.id);
    }
    const newProjects = new Map<string, { id: string; name: string; key: string }>();
    const projectIdFor = (rawKey: string, rawName: string): string => {
      const key = rawKey.trim().toUpperCase();
      const known = projectIdByKey.get(key);
      if (known) return known;
      const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
      const id = `jira-${slug}`;
      projectIdByKey.set(key, id);
      newProjects.set(key, { id, name: rawName.trim() || key, key });
      return id;
    };

    // ── Parse tasks + comments + specs into memory (still NO DB write) ──
    const tasks: TaskRow[] = [];
    const comments: CommentRow[] = [];
    const taskSpecs: SpecRow[] = [];
    let commentId = 1;
    let specId = 1;
    const seenTaskKeys = new Set<string>();

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const taskKey = row[iKey]?.trim();
      if (!taskKey || seenTaskKeys.has(taskKey)) continue;
      seenTaskKeys.add(taskKey);

      const projectKey = row[iProjKey]?.trim();
      if (!projectKey) continue;

      const title = row[iTitle]?.trim() || '';
      const statusStr = row[iStatus]?.trim() || '待办';
      const priorityStr = row[iPriority]?.trim() || 'Medium';
      const assigneeName = row[iAssignee]?.trim() || '';
      const reporterName = row[iReporter]?.trim() || '';
      const creatorName = row[iCreator]?.trim() || '';
      const createdStr = row[iCreated]?.trim() || '';
      const resolvedStr = row[iResolved]?.trim() || '';
      const dueDateStr = row[iDueDate]?.trim() || '';
      const startDateStr = iStartDate >= 0 ? (row[iStartDate]?.trim() || '') : '';
      const sprintName = getSprintNameFromRow(row);

      const projectId = projectIdFor(projectKey, iProjName >= 0 ? row[iProjName] || '' : '');
      const statusId = mapStatusId(statusStr);
      const priority = mapPriority(priorityStr);
      const sprintId = sprintName ? (sprintMap.get(sprintName) || null) : null;

      // Map assignee (经办人=指派人), reporter (报告人=验收人&开卡人)
      const assigneeId = assigneeName ? (memberMap[assigneeName] || null) : null;
      const reviewerId = reporterName ? (memberMap[reporterName] || null) : null;
      const creatorId = reporterName
        ? (memberMap[reporterName] || (creatorName ? memberMap[creatorName] : null) || fallbackMemberId)
        : (creatorName ? memberMap[creatorName] : null) || fallbackMemberId;

      const createdAt = parseDateOnly(createdStr) || dateOnlyPart(new Date().toISOString());
      const completedAt = parseChineseDateTime(resolvedStr);
      const dueDate = parseDateOnly(dueDateStr);
      const startedAt = startDateStr
        ? (/^\d{4}/.test(startDateStr) ? dateOnlyPart(startDateStr) : parseDateOnly(startDateStr))
        : null;

      // Extract comments from comment columns
      let taskCommentCount = 0;
      for (const ci of commentIndices) {
        const cell = row[ci]?.trim();
        if (!cell) continue;

        // Parse comment: "date;jira_id;content"
        const firstSemi = cell.indexOf(';');
        if (firstSemi < 0) continue;
        const secondSemi = cell.indexOf(';', firstSemi + 1);
        if (secondSemi < 0) continue;

        const commentDateStr = cell.substring(0, firstSemi).trim();
        const commentJiraId = cell.substring(firstSemi + 1, secondSemi).trim();
        const commentContent = cell.substring(secondSemi + 1).trim();

        if (!commentContent) continue;

        const commentDate = parseChineseDateTime(commentDateStr);
        const commentUserId = jiraIdToMemberId[commentJiraId] || fallbackMemberId;

        comments.push({
          id: `c${String(commentId++).padStart(5, '0')}`,
          task_id: taskKey,
          user_id: commentUserId,
          content: textToHtml(commentContent, jiraIdToName, memberMap),
          created_at: commentDate || createdAt,
        });
        taskCommentCount++;
      }

      // Extract description → task_specs
      const description = iDescription >= 0 ? (row[iDescription]?.trim() || '') : '';
      if (description) {
        taskSpecs.push({
          id: `ts${String(specId++).padStart(5, '0')}`,
          task_id: taskKey,
          background: '',
          requirement: textToHtml(description, jiraIdToName, memberMap),
          notes: '',
        });
      }

      // Department is back-filled from members.job_title after insert.
      const department: string | null = null;

      tasks.push({
        id: taskKey,
        task_key: taskKey,
        project_id: projectId,
        title,
        status_id: statusId,
        priority,
        creator_id: creatorId,
        assignee_id: assigneeId,
        reviewer_id: reviewerId,
        due_date: dueDate,
        started_at: startedAt,
        completed_at: completedAt ? dateOnlyPart(completedAt) : null,
        sort_order: r,
        created_at: createdAt,
        comment_count: taskCommentCount,
        sprint_id: sprintId,
        department,
      });
    }

    // ── Stats (identical shape for both dry-run and real import) ──
    const stats = {
      totalRows: rows.length - 1,
      tasksParsed: tasks.length,
      commentsParsed: comments.length,
      specsParsed: taskSpecs.length,
      sprintsParsed: sprintMap.size,
      newMembers: newMembers.map(m => m.name),
      newProjects: Array.from(newProjects.values()).map(p => p.name),
    };

    // ── Tier branch (contract C2): non-pro → SAFE DRY-RUN, nothing written. ──
    if (!isPro) {
      console.log('[import-jira] dry-run (non-professional):', JSON.stringify(stats));
      return json({ success: true, dryRun: true, stats });
    }

    // ═══ Professional path: the real, DESTRUCTIVE import (writes begin here) ═══

    // ── Clear existing data (children before parents) ──
    console.log('Clearing existing data...');
    await supabase.from('comments').delete().neq('id', '___none___');
    await supabase.from('task_checks').delete().neq('id', '___none___');
    await supabase.from('task_todos').delete().neq('id', '___none___');
    await supabase.from('task_specs').delete().neq('id', '___none___');
    await supabase.from('task_deployments').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('task_attachments').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('status_logs').delete().neq('id', '___none___');
    await supabase.from('notifications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('tasks').delete().neq('id', '___none___');
    await supabase.from('sprints').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    // ── Create the projects this CSV introduces. Without these rows the
    //    tasks.project_id FK rejects every task insert. ──
    try {
      if (newProjects.size > 0) {
        const { data: lineRows } = await supabase
          .from('product_lines').select('id').order('sort_order', { ascending: true }).limit(1);
        let lineId = lineRows && lineRows[0]?.id;
        if (!lineId) {
          lineId = 'pl-import';
          const { error: lineErr } = await supabase
            .from('product_lines')
            .upsert({ id: lineId, name: '匯入' }, { onConflict: 'id', ignoreDuplicates: true });
          if (lineErr) console.error('Ensure product line error:', lineErr);
        }
        const projectRows = Array.from(newProjects.values()).map(p => ({
          id: p.id, line_id: lineId, name: p.name, key: p.key,
        }));
        const { error: projErr } = await supabase
          .from('projects')
          .upsert(projectRows, { onConflict: 'id', ignoreDuplicates: true });
        if (projErr) console.error('Ensure projects error:', projErr);
      }
    } catch (error) {
      console.error('Ensure projects error:', error);
    }

    // ── Insert new members ──
    if (newMembers.length > 0) {
      console.log('Creating new members:', newMembers.map(m => m.name));
      const { error } = await supabase.from('members').insert(newMembers);
      if (error) console.error('Insert members error:', error);
    }

    // ── Insert sprints. On failure, drop the mapping AND detach the tasks that
    //    referenced the now-missing sprints. ──
    if (sprintMap.size > 0) {
      const sprintRows = Array.from(sprintMap.entries()).map(([name, id]) => ({
        id,
        name,
        is_active: false,
        completed_at: new Date().toISOString(),
        completed_count: 0,
        pending_count: 0,
      }));
      const { error } = await supabase.from('sprints').insert(sprintRows);
      if (error) {
        console.error('Insert sprint error:', error);
        sprintMap.clear(); // failed sprints must not be referenced by tasks
        for (const t of tasks) t.sprint_id = null;
      }
    }
    console.log('Created sprints:', Array.from(sprintMap.keys()));

    console.log(`Inserting ${tasks.length} tasks, ${comments.length} comments, ${taskSpecs.length} specs`);

    // Insert tasks in batches of 50 (failures logged, import continues).
    // Inserted counts are tracked so the response stats reflect what actually
    // landed in the DB, not just what parsed.
    let tasksInserted = 0;
    for (let i = 0; i < tasks.length; i += 50) {
      const batch = tasks.slice(i, i + 50);
      const { error } = await supabase.from('tasks').insert(batch);
      if (error) {
        console.error(`Insert tasks batch ${i} error:`, error, 'First task:', JSON.stringify(batch[0]));
      } else {
        tasksInserted += batch.length;
      }
    }

    // Insert comments in batches of 100
    let commentsInserted = 0;
    for (let i = 0; i < comments.length; i += 100) {
      const batch = comments.slice(i, i + 100);
      const { error } = await supabase.from('comments').insert(batch);
      if (error) {
        console.error(`Insert comments batch ${i} error:`, error);
      } else {
        commentsInserted += batch.length;
      }
    }

    // Insert task_specs in batches of 50
    let specsInserted = 0;
    for (let i = 0; i < taskSpecs.length; i += 50) {
      const batch = taskSpecs.slice(i, i + 50);
      const { error } = await supabase.from('task_specs').insert(batch);
      if (error) {
        console.error(`Insert specs batch ${i} error:`, error);
      } else {
        specsInserted += batch.length;
      }
    }

    // ── Post-insert: set department based on member job_titles ──
    try {
      const { data: memberRows } = await supabase.from('members').select('id, name, job_title');
      if (memberRows) {
        const getDept = (member: { name: string; job_title: string }): string | null => {
          const jt = member.job_title.toLowerCase();
          if (/\b(ceo|cto|coo|cfo|vp|director)\b/.test(jt) || /總監|总监/.test(jt)) return 'MGR';
          if (jt.includes('pm') || jt.includes('product') || jt.includes('產品') || jt.includes('产品')) return 'PM';
          if (jt.includes('sre') || jt.includes('devops') || jt.includes('infrastructure')) return 'SRE';
          if (jt.includes('be') || jt.includes('backend') || jt.includes('後端') || jt.includes('后端')) return 'BE';
          if (jt.includes('fe') || jt.includes('frontend') || jt.includes('前端')) return 'FE';
          if (jt.includes('qa') || jt.includes('test') || jt.includes('測試') || jt.includes('测试')) return 'QA';
          return null;
        };
        const memberDeptMap = new Map<string, string>();
        for (const m of memberRows) {
          const dept = getDept({ name: m.name, job_title: m.job_title || '' });
          if (dept) memberDeptMap.set(m.id, dept);
        }
        // Batch update tasks by assignee department
        for (const [memberId, dept] of memberDeptMap) {
          await supabase.from('tasks').update({ department: dept } as any).eq('assignee_id', memberId).is('department', null);
        }
        console.log(`Set departments for ${memberDeptMap.size} members`);
      }
    } catch (error) {
      console.error('Set departments error:', error);
    }

    // Update sprint dates and counts from task data
    // started_at = earliest created_at of tasks in this sprint
    // completed_at = latest completed_at of tasks in this sprint
    try {
      for (const sprintId of sprintMap.values()) {
        const sprintTasks = tasks.filter(t => t.sprint_id === sprintId);
        const completedCount = sprintTasks.filter(t => ['s6', 's7'].includes(t.status_id)).length;
        const pendingCount = sprintTasks.length - completedCount;

        // started_at: earliest created_at among tasks in this sprint
        const createdDates = sprintTasks
          .map(t => new Date(t.created_at).getTime())
          .filter(ts => !isNaN(ts));
        const minCreated = createdDates.length > 0 ? new Date(Math.min(...createdDates)) : null;

        // completed_at: latest completed_at among tasks in this sprint
        const completedDates = sprintTasks
          .filter(t => t.completed_at)
          .map(t => new Date(t.completed_at as string).getTime())
          .filter(ts => !isNaN(ts));
        const maxCompleted = completedDates.length > 0 ? new Date(Math.max(...completedDates)) : null;

        await supabase.from('sprints').update({
          completed_count: completedCount,
          pending_count: pendingCount,
          ...(maxCompleted ? { completed_at: maxCompleted.toISOString() } : {}),
          ...(minCreated ? { started_at: minCreated.toISOString() } : {}),
        } as any).eq('id', sprintId);
      }
    } catch (error) {
      console.error('Update sprint stats error:', error);
    }

    // ── Create active sprint and assign uncompleted tasks ──
    try {
      const now = new Date();
      const y = now.getFullYear();
      const mo = String(now.getMonth() + 1).padStart(2, '0');
      const activeSprintName = `${y}${mo}W1`;
      const activeSprintId = crypto.randomUUID();

      const { error: activeErr } = await supabase.from('sprints').insert({
        id: activeSprintId, name: activeSprintName, is_active: true,
      });
      if (activeErr) {
        console.error('Create active sprint error:', activeErr);
      } else {
        // Move all uncompleted tasks to the active sprint
        const uncompletedTaskIds = tasks
          .filter(t => !['s6', 's7'].includes(t.status_id))
          .map(t => t.id);

        if (uncompletedTaskIds.length > 0) {
          for (let i = 0; i < uncompletedTaskIds.length; i += 100) {
            const chunk = uncompletedTaskIds.slice(i, i + 100);
            const { error } = await supabase.from('tasks').update({ sprint_id: activeSprintId } as any).in('id', chunk);
            if (error) console.error('Move tasks to active sprint error:', error);
          }
        }
        console.log(`Created active sprint "${activeSprintName}" with ${uncompletedTaskIds.length} uncompleted tasks`);
      }
    } catch (error) {
      console.error('Create active sprint error:', error);
    }

    return json({
      success: true,
      dryRun: false,
      stats: {
        ...stats,
        // Actual insert results (sprintMap is cleared when its insert fails,
        // so its size is the real created count).
        tasksInserted,
        commentsInserted,
        specsInserted,
        sprintsCreated: sprintMap.size,
      },
    });
  } catch (err) {
    console.error('Import error:', err);
    return json({ error: String(err) }, 500);
  }
});
