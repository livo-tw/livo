import { DISABLED, messageModal, type Row } from './core.ts';
import type { Actions } from './handler.ts';
import type { MemberDatabase } from './workspace-backend.ts';
import { workspaceText } from './workspace-i18n.ts';

const PAGE_SIZE = 8;
const actionIds = new Set(['livo_knowledge_search', 'livo_knowledge_page', 'livo_knowledge_open']);
const fail = (message: string): never => { throw Object.assign(new Error(message), { name: 'ActionError' }); };
const pageNumber = (page: unknown) => Number.isSafeInteger(page) && Number(page) >= 0 ? Math.min(Number(page), 10000) : 0;
const keyword = (value: unknown) => String(value || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 100);
const identifier = (value: unknown) => {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/.test(value)) fail('文件不存在或你沒有檢視權限。');
  return value as string;
};
type KnowledgeResults = { pages: Row[]; page: number; hasMore: boolean; query: string };
export interface KnowledgeData {
  search(actor: Row, query: unknown, page?: unknown): Promise<KnowledgeResults>;
  detail(actor: Row, id: unknown): Promise<Row>;
  link(page: Row): string;
}

/** Never use the integration/service account for knowledge reads: its role cannot replace the reader's ACL. */
export function createKnowledgeData(memberDb: (actor: Row) => MemberDatabase, appBaseUrl: string): KnowledgeData {
  return {
    async search(actor, input, requestedPage = 0) {
      const query = keyword(input), page = pageNumber(requestedPage);
      if (!query) fail('請輸入文件標題或內容關鍵字。');
      const rows = await memberDb(actor).rows('kb_pages', {
        select: 'id,title,category,version,updated_at', is_archived: 'eq.false',
        or: `(title.ilike.*${query}*,body.ilike.*${query}*)`, order: 'title.asc,id.asc',
        limit: String(PAGE_SIZE + 1), offset: String(page * PAGE_SIZE),
      });
      return { pages: rows.slice(0, PAGE_SIZE), page, hasMore: rows.length > PAGE_SIZE, query };
    },
    async detail(actor, input) {
      // A saved button is not permission evidence. Every open rechecks RLS, including ancestor policies.
      const rows = await memberDb(actor).rows('kb_pages', {
        select: 'id,title,body,category,version,updated_at', id: `eq.${identifier(input)}`,
        is_archived: 'eq.false', limit: '1',
      });
      if (!rows[0]) fail('文件不存在或你沒有檢視權限。');
      return rows[0];
    },
    link: page => `${appBaseUrl.replace(/\/$/, '')}/?knowledge=${encodeURIComponent(page.id)}`,
  };
}

const tr = (source: Row, value: string, variables: Record<string, string | number> = {}) => workspaceText(value, source.locale, variables);
const button = (action: string, label: string, value: Row): Row => ({ type: 'button', action_id: action,
  text: { type: 'plain_text', text: label.slice(0, 75) }, value: JSON.stringify(value) });
const plainSection = (value: string): Row => ({ type: 'section', text: { type: 'plain_text', text: value.slice(0, 2900) || '—' } });
const metadata = (source: Row) => Object.fromEntries(['channel', 'thread', 'user', 'team', 'locale']
  .filter(key => typeof source[key] === 'string').map(key => [key, source[key].slice(0, 150)]));
const modal = (callback: string, title: string, blocks: Row[], source: Row, submit?: string): Row => ({
  type: 'modal', callback_id: callback, title: { type: 'plain_text', text: title.slice(0, 24) },
  close: { type: 'plain_text', text: tr(source, '關閉') }, private_metadata: JSON.stringify(metadata(source)), blocks,
  ...(submit ? { submit: { type: 'plain_text', text: submit } } : {}),
});
export function knowledgeSearchModal(source: Row): Row {
  return modal('livo_search_knowledge', tr(source, '搜尋 LIVO 文件'), [
    { type: 'input', block_id: 'query', label: { type: 'plain_text', text: tr(source, '文件標題或內容關鍵字') },
      element: { type: 'plain_text_input', action_id: 'query', min_length: 1, max_length: 100 } },
    plainSection(tr(source, '只搜尋你有權限檢視的未封存文件，結果及預覽只有你看得到。')),
  ], source, tr(source, '搜尋'));
}
export function knowledgeResultsModal(result: KnowledgeResults, source: Row): Row {
  const blocks: Row[] = [plainSection(tr(source, '第 {page} 頁', { page: result.page + 1 }) + '\n' + result.query)];
  if (!result.pages.length) blocks.push(plainSection(tr(source, '目前沒有符合條件的文件。')));
  for (const page of result.pages) {
    blocks.push(plainSection(String(page.title || '—')),
      { type: 'actions', elements: [button('livo_knowledge_open', tr(source, '預覽文件'), { id: page.id })] });
  }
  const nav: Row[] = [];
  if (result.page > 0) nav.push(button('livo_knowledge_page', tr(source, '上一頁'), { query: result.query, page: result.page - 1 }));
  if (result.hasMore) nav.push(button('livo_knowledge_page', tr(source, '下一頁'), { query: result.query, page: result.page + 1 }));
  nav.push(button('livo_knowledge_search', tr(source, '搜尋其他文件'), {}));
  blocks.push({ type: 'actions', elements: nav });
  return modal('livo_knowledge_results', tr(source, '搜尋 LIVO 文件'), blocks, source);
}
/** Render user-authored HTML as plain text; no embedded images, attachment links, mention markup or scripts. */
export function knowledgePreview(page: Row, link: string, source: Row): Row {
  const body = String(page.body || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, value: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[value] || '')
    .trim();
  return modal('livo_knowledge_preview', tr(source, 'LIVO 文件'), [
    plainSection(String(page.title || '—')),
    { type: 'context', elements: [{ type: 'plain_text', text: tr(source, '文件修訂 {version} · 更新 {date}',
      { version: page.version || 1, date: String(page.updated_at || '—').slice(0, 32) }) }] },
    plainSection(body.slice(0, 2800) || tr(source, '文件尚無正文。')),
    ...(body.length > 2800 ? [plainSection(tr(source, '這是部分正文預覽；開啟 LIVO 可閱讀完整文件。'))] : []),
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: tr(source, '開啟 LIVO') }, url: link },
      button('livo_knowledge_search', tr(source, '搜尋其他文件'), {})] },
  ], source);
}

export async function handleKnowledgeInteraction(p: Row, d: Actions, source: Row): Promise<Row | undefined> {
  if (!d.knowledge) return undefined;
  const command = p.command ? /^kb(?:\s+(?:search(?:\s+|$))?([\s\S]*))?$/i.exec(String(p.text || '').trim()) : null;
  const action = p.type === 'block_actions' ? p.actions?.[0] : undefined;
  const submission = p.type === 'view_submission' && p.view?.callback_id === 'livo_search_knowledge';
  if (!command && !actionIds.has(action?.action_id) && !submission) return undefined;
  const query = submission ? String(p.view.state?.values?.query?.query?.value || '') : command?.[1] || '';
  if (submission && !keyword(query)) return { response_action: 'errors', errors: { query: tr(source, '請輸入文件標題或內容關鍵字。') } };
  let value: Row = {};
  try { const parsed = JSON.parse(action?.value || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed; } catch { /* Invalid button values fail validation below. */ }
  const opening = submission ? { view: p.view } : p.view?.id
    ? await d.slack('views.update', { view_id: p.view.id, ...(p.view.hash ? { hash: p.view.hash } : {}), view: messageModal(tr(source, '正在載入 LIVO…')) })
    : await d.slack('views.open', { trigger_id: p.trigger_id, view: messageModal(tr(source, '正在載入 LIVO…')) });
  d.background((async () => {
    let view: Row;
    try {
      if (!(await d.enabled())) fail(DISABLED);
      const actor = await d.actor(p); source.locale = actor.locale;
      if (action?.action_id === 'livo_knowledge_open') {
        const page = await d.knowledge!.detail(actor, value.id);
        view = knowledgePreview(page, d.knowledge!.link(page), source);
      } else if (submission || keyword(query) || action?.action_id === 'livo_knowledge_page') {
        view = knowledgeResultsModal(await d.knowledge!.search(actor, submission || command ? query : value.query, value.page), source);
      } else view = knowledgeSearchModal(source);
    } catch (error) {
      view = messageModal(tr(source, error instanceof Error && error.name === 'ActionError' ? error.message
        : '操作未完成，請重新開啟再試一次；若持續失敗，請洽管理員。'));
    }
    // Do not fall back to a channel post or DM containing private document text.
    await d.slack('views.update', { view_id: opening.view?.id || p.view?.id,
      ...(!submission && opening.view?.hash ? { hash: opening.view.hash } : {}), view }).catch(() => {});
  })());
  return submission ? { response_action: 'update', view: messageModal(tr(source, '正在載入 LIVO…')) } : {};
}
