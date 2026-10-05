import { knowledgeCan, knowledgeIsAdmin, knowledgeRuleMatches, parseKnowledgePolicy, type KnowledgeActor, type KnowledgeAclPage, type KnowledgePolicy, type KnowledgeRule } from './knowledgeAccess';

export const IMPORT_LIMIT = 10 * 1024 * 1024;
export const IMPORT_TTL = 24 * 60 * 60 * 1000;
export type ImportSource = 'notion' | 'docx' | 'md' | 'pdf';
export type ImportStatus = 'uploaded' | 'parsing' | 'ocr_pending' | 'preview_ready' | 'committing' | 'succeeded' | 'partially_failed' | 'failed' | 'cancelled';
export type ImportAsset = { name: string; type: string; key: string; size: number };
export type ImportParsed = { body: string; warnings: string[]; pages: Array<{ page: number; state: string; text: string; confidence: number | null; [key: string]: unknown }>; parser_version: string; hash: string; incomplete: boolean; needs_review: boolean; assets: Array<{name: string; type: string; data: string}> };
export type ImportItem = { id: string; title: string; source_key: string; source_url?: string; source_hash: string; original: ImportAsset; assets: ImportAsset[]; parsed?: Omit<ImportParsed,'assets'>; status: 'pending' | 'ready' | 'failed' | 'committed'; error?: string; page_id?: string; snapshot_id?: string };
export type ImportJob = { id: string; actor_id: string; source: ImportSource; status: ImportStatus; version: number; policy_version: number; created_at: string; updated_at?: string; run_id?:string; staged_keys?:string[]; expires_at: string; initial_parent: string | null; items: ImportItem[] };
export type ImportPolicy = { version: number; subjects: KnowledgeRule; notion_subjects: KnowledgeRule; notion_pages: string[]; notion_secret?: string };
export type ImportPage = KnowledgeAclPage & { title: string; body: string; version: number; project_id: string | null };
export type ImportDestination = { parent_id: string | null; project_id: string | null; category: 'general'|'meeting'; policy: KnowledgePolicy; target_id: string | null; expected_version: number | null; mode: 'create'|'update'|'copy' };
export type ImportMapping = { item_id: string; destination: ImportDestination; reviewed: boolean; allow_incomplete: boolean; confirm_audience: boolean };
export type ImportStoredSource = { id: string; page_id: string; snapshot_id: string; source_key: string; source_hash: string; original: ImportAsset; assets: ImportAsset[]; version: number; body?: string };
export interface ImportRepository {
  actor(): Promise<KnowledgeActor | null>;
  pages(): Promise<ImportPage[]>;
  policy(): Promise<ImportPolicy>;
  savePolicy(policy: ImportPolicy, expectedVersion: number): Promise<void>;
  getJob(id: string): Promise<ImportJob | null>;
  listJobs(): Promise<ImportJob[]>;
  saveJob(job: ImportJob, expectedVersion: number | null): Promise<boolean>;
  putFile(key: string, data: Uint8Array, type: string): Promise<void>;
  getFile(key: string): Promise<Uint8Array | null>;
  deleteFile(key: string): Promise<void>;
  sources(pageId: string): Promise<ImportStoredSource[]>;
  findSources(keys:string[],parent:string|null,project:string|null): Promise<ImportStoredSource[]>;
  results(jobId: string): Promise<Array<{item_id:string;page_id:string;snapshot_id:string;file_keys?:string[]}>>;
  expiredJobs(): Promise<ImportJob[]>;
  deleteExpiredJob(jobId:string): Promise<void>;
  /** Must recheck actor, live capability, job/version and destination ACL inside a transaction. */
  commit(job: ImportJob, item: ImportItem, mapping: ImportMapping, source: ImportStoredSource): Promise<{page_id: string; snapshot_id: string}>;
  background(promise: Promise<unknown>): void;
}
export type ImportConfig = { processorUrl?: string; processorToken?: string; encryptionSecret?: string; fetcher?: typeof fetch; now?: () => number };
export class ImportError extends Error { constructor(public code: string, public status = 400) { super(code); } }
function deny(): never { throw new ImportError('import_forbidden', 403); }
const id = () => crypto.randomUUID();
const defaultRule = (): KnowledgeRule => ({ roles: ['super_admin'], positions: [], member_ids: [] });
export const defaultImportPolicy = (): ImportPolicy => ({version: 0, subjects: defaultRule(), notion_subjects: defaultRule(), notion_pages: []});
export const importAllowed = (policy: ImportPolicy, actor: KnowledgeActor | null) => !!actor && actor.is_active !== false && actor.is_active !== 0 && knowledgeRuleMatches(policy.subjects,actor);
const asRecord = (x: unknown): Record<string,unknown> => x && typeof x==='object' && !Array.isArray(x) ? x as Record<string,unknown> : {};
// Both directions stay close to the document size: the Docker Edge worker has a 256 MB
// heap and Cloudflare 128 MB. Uint8Array.from(string) first builds a list with one entry
// per byte (about 8 bytes each), which alone exceeded the limit for documents near 10 MB.
// Chunks are a multiple of 3 bytes, so the base64 pieces join without inner padding.
export const toBase64 = (bytes: Uint8Array): string => { const parts:string[]=[]; for(let n=0;n<bytes.length;n+=24576) parts.push(btoa(String.fromCharCode(...bytes.subarray(n,n+24576)))); return parts.join(''); };
export function fromBase64(value: unknown): Uint8Array { if(typeof value!=='string'||value.length>Math.ceil(IMPORT_LIMIT*4/3)+8||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new ImportError('file_size_limit'); try {const binary=atob(value);if(!binary.length||binary.length>IMPORT_LIMIT)throw 0;const b=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)b[i]=binary.charCodeAt(i);return b;}catch{throw new ImportError('invalid_file');} }
export const sha256 = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))).map(x=>x.toString(16).padStart(2,'0')).join('');
const mime = (source: ImportSource) => ({notion:'text/markdown',md:'text/markdown',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pdf:'application/pdf'}[source]);
function validRule(value: unknown): KnowledgeRule { const candidate={mode:'custom',view:value,edit:value,comment:value};const p=parseKnowledgePolicy(candidate);if(!p||p.mode!=='custom')throw new ImportError('invalid_policy');return p.view; }
export function notionPageId(value: unknown): string { if(typeof value!=='string')throw new ImportError('invalid_notion_page');let raw=value.trim();if(raw.startsWith('https://')){const u=new URL(raw);if(!['notion.so','www.notion.so'].includes(u.hostname)||u.username||u.password)throw new ImportError('invalid_notion_page');raw=u.pathname.split('/').pop()||'';}const match=raw.match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);if(!match)throw new ImportError('invalid_notion_page');return match[1].replace(/-/g,'').toLowerCase(); }
export function allowedNotionAsset(value:string):boolean {try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['prod-files-secure.s3.us-west-2.amazonaws.com','s3.us-west-2.amazonaws.com','file.notion.so'].includes(u.hostname);}catch{return false;}}
async function boundedResponse(response:Response,limit:number,sizeCode='source_size_limit'):Promise<Uint8Array>{if(Number(response.headers.get('content-length')||0)>limit)throw new ImportError(sizeCode,413);const reader=response.body?.getReader();if(!reader)throw new ImportError('source_missing');const chunks:Uint8Array[]=[];let total=0;try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit)throw new ImportError(sizeCode,413);chunks.push(value);}}finally{await reader.cancel().catch(():void=>{});}const result=new Uint8Array(total);let at=0;for(const c of chunks){result.set(c,at);at+=c.length;}return result;}
async function cryptSecret(value: string, secret: string|undefined, decode = false) { if(!secret||secret.length<32)throw new ImportError('notion_encryption_not_configured',503);const key=await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret)),'AES-GCM',false,[decode?'decrypt':'encrypt']);if(decode){const raw=fromBase64(value);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:raw.slice(0,12)},key,raw.slice(12)));}const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(value)));const bytes=new Uint8Array(iv.length+encrypted.length);bytes.set(iv);bytes.set(encrypted,12);return toBase64(bytes); }
function publicPolicy(policy: ImportPolicy) { const {notion_secret:_,...rest}=policy;return {...rest,notion_configured:!!policy.notion_secret}; }
const UNSAFE_ELEMENTS=new Set(['script','iframe','object','embed','svg','math','img','style','link','meta','base','form','frame','frameset']);
const URL_ATTRIBUTES=new Set(['href','src','action','formaction','xlink:href','data','poster','background','srcset','cite','longdesc','lowsrc','dynsrc','ping','codebase','archive','manifest']);
const NAMED_ENTITIES:Record<string,string>={colon:':',tab:'\t',newline:'\n',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",sol:'/',lpar:'(',rpar:')',nbsp:' '};
const codePoint=(n:number)=>n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
/** A browser-equivalent view of an attribute value: entities decoded, controls and spaces removed. */
function attributeValue(raw:string):string{
  return raw.replace(/&#x([0-9a-f]+);?/gi,(_,hex:string)=>codePoint(parseInt(hex,16))).replace(/&#(\d+);?/g,(_,dec:string)=>codePoint(Number(dec)))
    .replace(/&([a-z]+);/gi,(entity,name:string)=>NAMED_ENTITIES[name.toLowerCase()]??entity)
    .replace(/[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u205f\u3000\ufeff]/g,'').toLowerCase();
}
/**
 * Defense in depth if a misconfigured processor does not run the bundled
 * allowlist. Inspects real markup only: element names, event-handler
 * attributes and URL schemes inside attributes. Escaped text such as
 * "Test data:", "Metadata:" or "one = 1" is ordinary content.
 */
export function unsafeProcessorHtml(html:string):boolean{
  for(let i=html.indexOf('<');i!==-1&&i<html.length;i=html.indexOf('<',i)){
    const open=/^<\/?([A-Za-z][^\s/>]*)/.exec(html.slice(i,i+80));
    if(!open){i++;continue;}
    if(UNSAFE_ELEMENTS.has(open[1].toLowerCase()))return true;
    i+=open[0].length;
    while(i<html.length&&html[i]!=='>'){
      if(/[\s/]/.test(html[i])){i++;continue;}
      const start=i;
      while(i<html.length&&!/[\s/>=]/.test(html[i]))i++;
      const name=html.slice(start,i).toLowerCase();
      while(i<html.length&&/\s/.test(html[i]))i++;
      let value:string|null=null;
      if(html[i]==='='){
        i++;while(i<html.length&&/\s/.test(html[i]))i++;
        const quote=html[i];
        if(quote==='"'||quote==="'"){const end=html.indexOf(quote,i+1);value=html.slice(i+1,end===-1?html.length:end);i=end===-1?html.length:end+1;}
        else{const from=i;while(i<html.length&&!/[\s>]/.test(html[i]))i++;value=html.slice(from,i);}
      }
      if(!name)continue; // a stray "=value" was consumed above
      if(name.startsWith('on'))return true;
      if(value===null)continue;
      const normalized=attributeValue(value);
      // srcset, ping and archive hold lists of URLs; every other URL attribute holds one.
      const urls=['srcset','ping','archive'].includes(name)?normalized.split(','):[normalized];
      if(URL_ATTRIBUTES.has(name)&&urls.some(url=>/^(?:javascript|vbscript|data):/.test(url)))return true;
      if(name==='style'&&/(?:javascript|vbscript):|expression\(/.test(normalized))return true;
    }
  }
  return false;
}
function checkParsed(value: unknown): ImportParsed {
  const p=asRecord(value);if(typeof p.body==='string'&&new TextEncoder().encode(p.body).byteLength>900000)throw new ImportError('parsed_document_too_large',413);
  if(typeof p.body!=='string'||!Array.isArray(p.warnings)||!Array.isArray(p.pages)||!Array.isArray(p.assets)||p.pages.length>40||p.assets.length>24)throw new ImportError('invalid_processor_result',502);
  if(unsafeProcessorHtml(p.body))throw new ImportError('unsafe_processor_result',502);
  if(!p.body.trim()&&!p.incomplete)throw new ImportError('empty_document');return p as ImportParsed;
}
// Nested time budgets: the processor parses for at most 85 s (server.py BUDGET),
// this caller waits 95 s, and the self-host knowledge-import function may run
// 150 s (functions/main). Aborting the request also stops the processor's parse.
export const PROCESSOR_TIMEOUT_MS = 95_000;
export async function parseWithProcessor(config: ImportConfig, source: 'md'|'docx'|'pdf', bytes: Uint8Array, previous?:ImportItem): Promise<ImportParsed> {
  // Markdown (and Notion, which arrives as Markdown) is plain text: without a processor it is converted here.
  if(source==='md'&&!config.processorUrl)return parseMarkdownLocally(bytes);
  if(!config.processorUrl||!config.processorToken||config.processorToken.length<32)throw new ImportError('processor_not_configured',503);
  let url:URL;try{url=new URL(config.processorUrl);}catch{throw new ImportError('invalid_processor_configuration',503);}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new ImportError('invalid_processor_configuration',503);
  // An absent, stopped or unreachable processor is a clear item error, never a crash.
  const unavailable=(error:unknown):never=>{if(error instanceof ImportError)throw error;throw new ImportError((error as {name?:unknown}|null)?.name==='TimeoutError'?'processing_timeout':'processor_unavailable',503);};
  let result:Response,body:Record<string,unknown>;
  try{result=await (config.fetcher||fetch)(new URL('/parse',url),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.processorToken}`},body:JSON.stringify({source,data:toBase64(bytes),...(source==='pdf'&&previous?.parsed?{previous_pages:previous.parsed.pages,previous_hash:previous.source_hash}:{})}),signal:AbortSignal.timeout(PROCESSOR_TIMEOUT_MS)});}
  catch(error){return unavailable(error);}
  try{body=asRecord(JSON.parse(new TextDecoder().decode(await boundedResponse(result,IMPORT_LIMIT,'parsed_document_too_large'))));}
  catch(error){return unavailable(error);}
  if(!result.ok)throw new ImportError(typeof body.error==='string'?body.error:'processing_failed',result.status);return checkParsed(body.result);
}

// ---------- Markdown without the private processor ----------
// The same passive result as the processor's markdown-it rendering (docker/knowledge-processor/parser.py):
// raw HTML is shown as text, images are never fetched, links keep only http(s) and #anchors, and only
// the tags the processor's sanitizer allows are produced.
const MARKDOWN_TEXT_LIMIT = 800_000;
const escapeImportHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
function safeImportUrl(value: string): string | null {
  const url = value.trim();
  if ([...url].some(char => char.charCodeAt(0) < 32)) return null;
  if (/^#[A-Za-z0-9_-]+$/.test(url)) return url;
  try { const parsed = new URL(url); if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname && !parsed.username && !parsed.password) return url; } catch { /* not a URL */ }
  return null;
}
const emphasis = (escaped: string) => escaped
  .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>').replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
  .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>')
  .replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*/g, '<em>$1</em>').replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?=$|[^\w])/g, '$1<em>$2</em>');
function markdownInline(text: string): string {
  const kept: string[] = [];
  // Finished HTML is parked behind private-use markers so the escaping below leaves it alone.
  const keep = (html: string) => `\uE000${kept.push(html) - 1}\uE001`;
  let value = text.replace(/[\uE000\uE001]/g, '');
  value = value.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) => keep(`<code>${escapeImportHtml(code.trim())}</code>`));
  value = value.replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_m, alt: string) => keep(escapeImportHtml(`[image: ${alt}]`)));
  value = value.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, href: string) => {
    const url = safeImportUrl(href), inner = emphasis(escapeImportHtml(label));
    return keep(url ? `<a href="${escapeImportHtml(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner);
  });
  value = value.replace(/<(https?:\/\/[^\s<>]+)>/g, (_m, href: string) => { const url = safeImportUrl(href); return keep(url ? `<a href="${escapeImportHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeImportHtml(href)}</a>` : escapeImportHtml(href)); });
  return emphasis(escapeImportHtml(value)).replace(/\uE000(\d+)\uE001/g, (_m, index: string) => kept[Number(index)] ?? '');
}
const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const tableCells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
function markdownBlocks(lines: string[], depth = 0): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => { if (paragraph.length) out.push(`<p>${markdownInline(paragraph.join('\n'))}</p>`); paragraph = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escapeImportHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (paragraph.length && /^\s*=+\s*$/.test(line)) { out.push(`<h1>${markdownInline(paragraph.join('\n'))}</h1>`); paragraph = []; continue; }
    if (paragraph.length && /^\s*-+\s*$/.test(line)) { out.push(`<h2>${markdownInline(paragraph.join('\n'))}</h2>`); paragraph = []; continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { flush(); out.push(`<h${heading[1].length}>${markdownInline(heading[2])}</h${heading[1].length}>`); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if (/^\s{0,3}>/.test(line) && depth < 5) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
      i--;
      out.push(`<blockquote>${markdownBlocks(quoted, depth + 1)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && tableSeparator.test(lines[i + 1])) {
      flush();
      const head = tableCells(line), rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(tableCells(lines[i]));
      i--;
      out.push(`<table><thead><tr>${head.map(cell => `<th>${markdownInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${head.map((_c, index) => `<td>${markdownInline(row[index] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (listItem.test(line)) {
      flush();
      const items: Array<{ indent: number; ordered: boolean; text: string }> = [];
      for (; i < lines.length; i++) {
        const match = listItem.exec(lines[i]);
        if (match) items.push({ indent: match[1].replace(/\t/g, '    ').length, ordered: /\d/.test(match[2]), text: match[3] });
        else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) items[items.length - 1].text += '\n' + lines[i].trim();
        else break;
      }
      i--;
      out.push(markdownList(items));
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return out.join('');
}
function markdownList(items: Array<{ indent: number; ordered: boolean; text: string }>): string {
  let html = '';
  const open: Array<{ indent: number; tag: string }> = [];
  for (const item of items) {
    while (open.length && item.indent < open[open.length - 1].indent) html += `</li></${open.pop()!.tag}>`;
    const top = open[open.length - 1];
    if (!top || item.indent > top.indent) {
      const tag = item.ordered ? 'ol' : 'ul';
      open.push({ indent: item.indent, tag });
      html += `<${tag}><li>`;
    } else html += '</li><li>';
    html += markdownInline(item.text);
  }
  while (open.length) html += `</li></${open.pop()!.tag}>`;
  return html;
}
export async function parseMarkdownLocally(bytes: Uint8Array): Promise<ImportParsed> {
  let text: string;
  // The decoder drops a leading byte-order mark itself (ignoreBOM: false).
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); } catch { throw new ImportError('invalid_document'); }
  if (text.length > MARKDOWN_TEXT_LIMIT) throw new ImportError('parsed_document_too_large', 413);
  const body = markdownBlocks(text.replace(/\r\n?/g, '\n').split('\n'));
  const warnings: string[] = [];
  if (/^\s*[-*+]\s+\[[ xX]\]/m.test(text)) warnings.push('historical_checkboxes');
  if (/!\[|<img|<iframe|<script|\]\((?!https?:\/\/|#)/i.test(text)) warnings.push('embedded_or_relative_content_not_converted');
  return checkParsed({ body, warnings, pages: [], assets: [], parser_version: 'livo-import-md-builtin-1', hash: await sha256(bytes), needs_review: warnings.length > 0, incomplete: false });
}

export function createKnowledgeImport(repo: ImportRepository, config: ImportConfig) {
  const now=()=>config.now?.()??Date.now();
  async function context() {const [actor,policy,pages]=await Promise.all([repo.actor(),repo.policy(),repo.pages()]);if(!actor||actor.is_active===false||actor.is_active===0)deny();return {actor:actor!,policy,pages};}
  async function jobFor(id:unknown) {if(typeof id!=='string'||id.length>80)throw new ImportError('job_not_found',404);const [job,c]=await Promise.all([repo.getJob(id),context()]);if(!job||job.actor_id!==c.actor.id||!importAllowed(c.policy,c.actor))deny();if(Date.parse(job.expires_at)<=now())throw new ImportError('preview_expired',410);if(job.initial_parent&&!knowledgeCan(c.pages,job.initial_parent,c.actor,'view'))deny();if(job.source==='notion'&&(!c.policy.notion_secret||!knowledgeRuleMatches(c.policy.notion_subjects,c.actor)||job.items.some(i=>!c.policy.notion_pages.includes(i.source_key.replace('notion:','')))))deny();return {job,...c};}
  function destination(raw:unknown,c:Awaited<ReturnType<typeof context>>):ImportDestination {
    const d=asRecord(raw),policy=parseKnowledgePolicy(d.policy);if(!policy||!['general','meeting'].includes(String(d.category))||!['create','copy','update'].includes(String(d.mode)))throw new ImportError('invalid_destination');
    const parent=typeof d.parent_id==='string'?d.parent_id:null,target=typeof d.target_id==='string'?d.target_id:null;
    if(parent&&!knowledgeCan(c.pages,parent,c.actor,'edit'))deny();
    if(d.mode==='update'&&(!target||!knowledgeCan(c.pages,target,c.actor,'edit')))deny();
    if(d.mode!=='update'&&policy.mode==='custom'&&(!knowledgeIsAdmin(c.actor.role)||!knowledgeRuleMatches(policy.view,c.actor)))deny();
    const project=typeof d.project_id==='string'?d.project_id:null;
    const parentPage=parent?c.pages.find(p=>p.id===parent):null;
    if(parentPage&&parentPage.project_id!==project)throw new ImportError('scope_mismatch');
    if(parentPage?.parent_id){const grand=c.pages.find(p=>p.id===parentPage.parent_id);if(grand?.parent_id)throw new ImportError('depth_limit');}
    const page=target?c.pages.find(p=>p.id===target):null;
    if(d.mode==='update'&&page?.version!==d.expected_version)throw new ImportError('destination_changed',409);
    return {parent_id:parent,project_id:project,category:d.category as 'general'|'meeting',policy,target_id:target,expected_version:typeof d.expected_version==='number'?d.expected_version:null,mode:d.mode as ImportDestination['mode']};
  }
  async function persist(job:ImportJob,expected:number) {job.version=expected+1;job.updated_at=new Date(now()).toISOString();if(!await repo.saveJob(job,expected))throw new ImportError('job_changed',409);}
  async function process(jobId:string) {
    const c=await jobFor(jobId),job=c.job;if(job.status==='cancelled')return;
    const start=job.version,run=id();job.status='parsing';job.run_id=run;await persist(job,start);
    const owns=async()=>{const live=await jobFor(job.id);if(live.job.run_id!==run||live.job.version!==job.version||live.job.status!=='parsing')throw new ImportError('processing_superseded',409);return live;};
    const heartbeat=async()=>{await owns();await persist(job,job.version);};
    const stage=async(key:string,bytes:Uint8Array,type:string)=>{await owns();job.staged_keys=[...new Set([...(job.staged_keys||[]),key])];if(job.staged_keys.length>500)throw new ImportError('asset_size_limit');await persist(job,job.version);try{await repo.putFile(key,bytes,type);await owns();}catch(error){await repo.deleteFile(key).catch(():void=>{});throw error;}};
    for(const item of job.items.filter(x=>x.status!=='committed'&&x.status!=='ready')) {
      try {
        await heartbeat();const live=await owns();
        let bytes:Uint8Array|null=null;let notionAssets:ImportParsed['assets']=[];
        if(job.source==='notion'){const pageId=item.source_key.replace('notion:','');const fetched=await notionRead(pageId,live.policy,heartbeat);await owns();bytes=fetched.bytes;notionAssets=fetched.assets;item.title=fetched.title;item.original.name=fetched.title+'.md';item.original.key=`${job.actor_id}/${job.id}/${item.id}/${run}/original`;item.original.size=bytes.length;item.source_hash=await sha256(bytes);item.error=fetched.warnings.join(',');await stage(item.original.key,bytes,'text/markdown');}
        else bytes=await repo.getFile(item.original.key);if(!bytes)throw new ImportError('source_missing');if(job.items.reduce((sum,other)=>sum+(other.id===item.id?bytes!.length:other.original.size),0)>IMPORT_LIMIT)throw new ImportError('file_size_limit');
        const parsed=await parseWithProcessor(config,job.source==='notion'?'md':job.source,bytes,item);
        await owns();
        let total=0;item.assets=[];
        for(const [index,asset] of [...notionAssets,...parsed.assets].entries()){const data=fromBase64(asset.data);total+=data.length;if(total>IMPORT_LIMIT||index>=24)throw new ImportError('asset_size_limit');const key=`${job.actor_id}/${job.id}/${item.id}/${run}/asset-${index}`;await stage(key,data,asset.type);item.assets.push({name:asset.name.slice(0,200),key,type:asset.type,size:data.length});}
        const {assets:_,...safe}=parsed;if(item.error?.startsWith('notion_')){safe.warnings.push(...item.error.split(','));safe.needs_review=true;if(item.error.includes('truncated'))safe.incomplete=true;}item.parsed=safe;item.status='ready';delete item.error;
      } catch(error) {if(error instanceof ImportError&&['processing_superseded','job_changed','import_forbidden'].includes(error.code))return;item.status='failed';item.error=error instanceof ImportError?error.code:'processing_failed';}
      await heartbeat();
    }
    await owns();
    job.status=job.items.some(i=>i.parsed?.incomplete)?'ocr_pending':job.items.some(i=>i.status==='ready')?'preview_ready':'failed';
    await persist(job,job.version);
  }
  async function notionRead(pageId:string,policy:ImportPolicy,heartbeat:()=>Promise<void>) {
    if(!policy.notion_secret||!policy.notion_pages.includes(pageId))deny();
    const token=await cryptSecret(policy.notion_secret,config.encryptionSecret,true);
    const get=async(path:string)=>{for(let attempt=0;attempt<3;attempt++){const r=await(config.fetcher||fetch)(`https://api.notion.com/v1/${path}`,{redirect:'error',headers:{Authorization:`Bearer ${token}`,'Notion-Version':'2025-09-03'},signal:AbortSignal.timeout(20000)});if(r.status===429&&attempt<2){await new Promise(resolve=>setTimeout(resolve,Math.min(3,Math.max(1,Number(r.headers.get('retry-after'))||1))*1000));continue;}if(!r.ok)throw new ImportError(r.status===401?'notion_connection_expired':r.status===403||r.status===404?'notion_source_unavailable':'notion_request_failed',r.status);const raw=await r.text();if(raw.length>IMPORT_LIMIT)throw new ImportError('source_size_limit');return asRecord(JSON.parse(raw));}throw new ImportError('notion_rate_limited',429);};
    await heartbeat();const page=await get(`pages/${pageId}`);await heartbeat();const markdown=await get(`pages/${pageId}/markdown`);let title='Notion';
    for(const property of Object.values(asRecord(page.properties))){const p=asRecord(property);if(p.type==='title'&&Array.isArray(p.title))title=p.title.map(x=>String(asRecord(x).plain_text||'')).join('')||title;}
    if(typeof markdown.markdown!=='string'||!markdown.markdown.trim())throw new ImportError('empty_document');
    const warnings=['notion_layout_review'];if(markdown.truncated)warnings.push('notion_truncated');if(Array.isArray(markdown.unknown_block_ids)&&markdown.unknown_block_ids.length)warnings.push('notion_unknown_blocks');
    const assets:ImportParsed['assets']=[];let content=markdown.markdown,total=0;
    const urls=[...new Set(Array.from(content.matchAll(/https:\/\/[^\s<>"()]+/g),m=>m[0]).filter(allowedNotionAsset))];
    for(const [index,url] of urls.entries()){await heartbeat();content=content.split(url).join('');if(index>=24){warnings.push('notion_asset_limit');continue;}try{const response=await(config.fetcher||fetch)(url,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new ImportError('notion_attachment_unavailable');const type=(response.headers.get('content-type')||'').split(';')[0],extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','application/pdf':'pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx'};if(!extensions[type])throw new ImportError('notion_attachment_unsupported');const bytes=await boundedResponse(response,2*1024*1024);total+=bytes.length;if(total>IMPORT_LIMIT)throw new ImportError('notion_asset_limit');assets.push({name:`attachment-${index+1}.${extensions[type]}`,type,data:toBase64(bytes)});}catch{warnings.push('notion_attachment_not_converted');}}
    return {title:title.slice(0,200),bytes:new TextEncoder().encode(content),warnings:[...new Set(warnings)],assets};
  }
  return async function execute(request:unknown):Promise<unknown> {
    const body=asRecord(request),action=body.action;
    if(action==='capability'){const c=await context();return {allowed:importAllowed(c.policy,c.actor),can_manage:c.actor.role==='super_admin',notion_available:!!c.policy.notion_secret&&knowledgeRuleMatches(c.policy.notion_subjects,c.actor),processor_configured:!!config.processorUrl};}
    if(action==='policy'||action==='save_policy'){
      const c=await context();if(c.actor.role!=='super_admin')deny();if(action==='policy')return publicPolicy(c.policy);
      if(body.version!==c.policy.version)throw new ImportError('policy_changed',409);
      const subjects=validRule(body.subjects),notionSubjects=validRule(body.notion_subjects);if(!Array.isArray(body.notion_pages)||body.notion_pages.length>100)throw new ImportError('invalid_notion_pages');
      const policy:ImportPolicy={version:c.policy.version+1,subjects,notion_subjects:notionSubjects,notion_pages:[...new Set(body.notion_pages.map(notionPageId))],notion_secret:c.policy.notion_secret};
      if(body.disconnect_notion===true)delete policy.notion_secret;
      if(typeof body.notion_token==='string'&&body.notion_token.trim()){if(body.notion_token.length>500)throw new ImportError('invalid_notion_token');policy.notion_secret=await cryptSecret(body.notion_token.trim(),config.encryptionSecret);}
      await repo.savePolicy(policy,c.policy.version);return publicPolicy(policy);
    }
    if(action==='sources'||action==='download_source'){
      const c=await context();if(typeof body.page_id!=='string'||!knowledgeCan(c.pages,body.page_id,c.actor,'view'))deny();const sources=await repo.sources(body.page_id);
      if(action==='sources')return sources.map(({original,assets,...s})=>({...s,original:{name:original.name,type:original.type,size:original.size},assets:assets.map(({name,type,size})=>({name,type,size}))}));
      const source=sources.find(s=>s.id===body.source_id);if(!source)deny();const file=body.asset_index===undefined?source!.original:source!.assets[Number(body.asset_index)];if(!file)throw new ImportError('file_not_found',404);const data=await repo.getFile(file.key);if(!data)throw new ImportError('file_not_found',404);return {name:file.name,type:file.type,data:toBase64(data)};
    }
    // Retention is performed by the system scheduler even when this actor is disabled.
    if(action==='list'){const c=await context();if(!importAllowed(c.policy,c.actor))deny();return(await repo.listJobs()).filter(j=>j.actor_id===c.actor.id&&Date.parse(j.expires_at)>now()&&(!j.initial_parent||knowledgeCan(c.pages,j.initial_parent,c.actor,'view'))&&(j.source!=='notion'||(!!c.policy.notion_secret&&knowledgeRuleMatches(c.policy.notion_subjects,c.actor)&&j.items.every(i=>c.policy.notion_pages.includes(i.source_key.replace('notion:','')))))).map(({items,...j})=>({...j,item_count:items.length}));}
    if(action==='start'){
      const c=await context();if(!importAllowed(c.policy,c.actor))deny();if((await repo.listJobs()).filter(j=>!['succeeded','cancelled','failed'].includes(j.status)).length>=10)throw new ImportError('active_job_limit',429);const source=body.source as ImportSource;if(!['notion','md','pdf','docx'].includes(source))throw new ImportError('unsupported_format');
      const parent=typeof body.parent_id==='string'?body.parent_id:null;if(parent&&!knowledgeCan(c.pages,parent,c.actor,'edit'))deny();
      const job:ImportJob={id:id(),actor_id:c.actor.id,source,status:'uploaded',version:1,policy_version:c.policy.version,created_at:new Date(now()).toISOString(),expires_at:new Date(now()+IMPORT_TTL).toISOString(),initial_parent:parent,items:[]};
      const inputs:Array<{name:string;bytes:Uint8Array;key?:string;url?:string;warnings?:string[]}>=[];
      if(source==='notion'){if(!c.policy.notion_secret||!knowledgeRuleMatches(c.policy.notion_subjects,c.actor))deny();if(!Array.isArray(body.page_ids)||!body.page_ids.length||body.page_ids.length>10)throw new ImportError('notion_selection_limit');for(const page of [...new Set(body.page_ids.map(notionPageId))]){if(!c.policy.notion_pages.includes(page))deny();inputs.push({name:'Notion.md',bytes:new Uint8Array(),key:'notion:'+page,url:'https://www.notion.so/'+page});}}
      else {if(typeof body.name!=='string'||body.name.length>200||!body.name.toLowerCase().endsWith('.'+source))throw new ImportError('unsupported_format');inputs.push({name:body.name.replace(/[\\/\x00-\x1f]/g,'_'),bytes:fromBase64(body.data)});body.data='';}
      if(inputs.reduce((n,x)=>n+x.bytes.length,0)>IMPORT_LIMIT)throw new ImportError('file_size_limit');
      for(const input of inputs){const itemId=id(),hash=await sha256(input.bytes),key=`${c.actor.id}/${job.id}/${itemId}/original`;job.items.push({id:itemId,title:input.name.replace(/\.(md|docx|pdf)$/i,''),source_key:input.key||'file:'+hash,source_url:input.url,source_hash:hash,original:{key,name:input.name,type:mime(source),size:input.bytes.length},assets:[],status:'pending',...(input.warnings?.length?{error:input.warnings.join(',')}: {})});}
      // Persist the retention identity before the first object-store write. An interrupted
      // request now leaves a discoverable job prefix instead of an untracked private file.
      if(!await repo.saveJob(job,null))throw new ImportError('job_changed',409);
      try{for(const [index,input] of inputs.entries()){if(!input.bytes.length)continue;await jobFor(job.id);await repo.putFile(job.items[index].original.key,input.bytes,mime(source));await jobFor(job.id);}}
      catch(error){for(const item of job.items)await repo.deleteFile(item.original.key).catch(():void=>{});job.status='failed';await persist(job,job.version).catch(():void=>{});throw error;}
      repo.background(process(job.id).catch(():void=>{}));return job;
    }
    const c=await jobFor(body.job_id),job=c.job;
    if(action==='download_preview'){const item=job.items.find(i=>i.id===body.item_id);if(!item)throw new ImportError('file_not_found',404);const file=await repo.getFile(item.original.key);if(!file)throw new ImportError('file_not_found',404);return {name:item.original.name,type:item.original.type,data:toBase64(file)};}
    if(action==='get'){
      // Recover after an edge process stops between an atomic item commit and job readback.
      if(['parsing','committing'].includes(job.status)&&now()-Date.parse(job.updated_at||job.created_at)>180000){const results=await repo.results(job.id);for(const result of results){const item=job.items.find(i=>i.id===result.item_id);if(item&&knowledgeCan(c.pages,result.page_id,c.actor,'view')){item.status='committed';item.page_id=result.page_id;item.snapshot_id=result.snapshot_id;}}job.status=job.items.every(i=>i.status==='committed')?'succeeded':job.items.some(i=>i.status==='committed'||i.parsed)?'partially_failed':'failed';await persist(job,job.version);}return job;
    }
    if(action==='cancel'){
      if(job.status==='committing')throw new ImportError('commit_in_progress',409);
      job.status='cancelled';await persist(job,job.version);
      // The successful CAS fences pending parsers and commits. Adapters recheck
      // durable source references, including a commit whose response was lost.
      const keys=new Set([...(job.staged_keys||[]),...job.items.flatMap(item=>[item.original.key,...item.assets.map(asset=>asset.key)])]);
      for(const key of keys)await repo.deleteFile(key).catch(():void=>{});
      return job;
    }
    if(action==='retry'){
      if(['committing','parsing','succeeded','cancelled'].includes(job.status))throw new ImportError('job_not_retryable',409);
      for(const item of job.items)if(item.status!=='committed'&&(item.status==='failed'||item.parsed?.incomplete)){item.status='pending';delete item.error;}
      job.policy_version=c.policy.version;await persist(job,job.version);repo.background(process(job.id).catch(():void=>{}));return job;
    }
    if(action==='preview_target'){
      const d=destination(body.destination,c);let sources:ImportStoredSource[]=[];const target=d.target_id?c.pages.find(p=>p.id===d.target_id):null;
      if(target)sources=await repo.sources(target.id);
      job.policy_version=c.policy.version;await persist(job,job.version);
      const matches=d.mode==='create'?await repo.findSources(job.items.map(i=>i.source_key),d.parent_id,d.project_id):[];
      const duplicates=matches.flatMap(s=>{const page=c.pages.find(p=>p.id===s.page_id);return page&&knowledgeCan(c.pages,page.id,c.actor,'view')?[{page_id:page.id,title:page.title,source_key:s.source_key,source_hash:s.source_hash,version:page.version}]:[];});
      return {job,destination:d,current:target?{title:target.title,body:target.body,version:target.version}:null,previous:sources.map(s=>({source_key:s.source_key,source_hash:s.source_hash,version:s.version,body:s.body})),duplicates,preserve_manual_body:d.mode==='update'};
    }
    if(action==='commit'){
      if(body.version!==job.version||job.policy_version!==c.policy.version)throw new ImportError('preview_changed',409);
      if(!['preview_ready','ocr_pending','partially_failed'].includes(job.status))throw new ImportError('job_not_ready',409);
      if(!Array.isArray(body.mappings)||!body.mappings.length||body.mappings.length>job.items.length)throw new ImportError('invalid_mapping');
      const mappings=body.mappings.map(raw=>{const m=asRecord(raw);const item=job.items.find(i=>i.id===m.item_id);if(!item||!item.parsed||item.status==='failed')throw new ImportError('item_not_ready');if(m.reviewed!==true||m.confirm_audience!==true||(item.parsed.incomplete&&m.allow_incomplete!==true))throw new ImportError('review_required');return {item_id:item.id,destination:destination(m.destination,c),reviewed:true,allow_incomplete:m.allow_incomplete===true,confirm_audience:true};});
      if(new Set(mappings.map(m=>m.item_id)).size!==mappings.length)throw new ImportError('duplicate_mapping');
      job.status='committing';await persist(job,job.version);
      for(const mapping of mappings){const item=job.items.find(i=>i.id===mapping.item_id)!;if(item.status==='committed')continue;
        try {const live=await context();if(!importAllowed(live.policy,live.actor)||live.policy.version!==job.policy_version)deny();if(job.source==='notion'&&(!live.policy.notion_secret||!knowledgeRuleMatches(live.policy.notion_subjects,live.actor)))deny();destination(mapping.destination,live);
          const source:ImportStoredSource={id:id(),page_id:mapping.destination.target_id||id(),snapshot_id:id(),source_key:item.source_key,source_hash:item.source_hash,original:item.original,assets:item.assets,version:1};
          const result=await repo.commit(job,item,mapping,source);item.status='committed';item.page_id=result.page_id;item.snapshot_id=result.snapshot_id;delete item.error;
        }catch(error){item.error=error instanceof ImportError?error.code:'commit_failed';}}
      job.status=job.items.every(i=>i.status==='committed')?'succeeded':'partially_failed';await persist(job,job.version);return job;
    }
    throw new ImportError('unknown_action');
  };
}
