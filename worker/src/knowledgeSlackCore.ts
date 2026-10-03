/** Private Slack knowledge search. Shared verbatim with both server adapters. */
type Row = Record<string, any>;
export type KnowledgeSearchQuery = { text: string; page: number; category: 'all' | 'general' | 'meeting' };
export type KnowledgeSearchPage = { pages: Row[]; hasMore: boolean; page: number };
export interface KnowledgeSlackActions {
  enabled(): Promise<boolean>;
  actor(payload: Row): Promise<Row>;
  search(actor: Row, query: KnowledgeSearchQuery): Promise<KnowledgeSearchPage>;
  link(page: Row): string;
  slack(method: string, body: Row): Promise<Row>;
  background(work: Promise<unknown>): void;
}
export const KNOWLEDGE_SEARCH_SIZE = 5;
const messages: Record<string, [string, string, string]> = {
  title: ['搜尋知識庫', '搜索知识库', 'Search knowledge'],
  close: ['關閉', '关闭', 'Close'],
  search: ['搜尋', '搜索', 'Search'],
  query: ['標題或內容關鍵字', '标题或内容关键词', 'Title or content keywords'],
  scope: ['搜尋類別', '搜索类别', 'Category'],
  all: ['全部', '全部', 'All'],
  general: ['一般知識', '一般知识', 'Knowledge'],
  meeting: ['會議記錄', '会议记录', 'Meetings'],
  loading: ['正在搜尋可讀文件…', '正在搜索可读文件…', 'Searching accessible documents…'],
  empty: ['找不到符合且你有權限查看的內容。', '找不到符合且你有权限查看的内容。', 'No matching documents you can access.'],
  private: ['結果只提供給你；完整內容與附件請在 LIVO 開啟。', '结果只提供给你；完整内容与附件请在 LIVO 打开。', 'Only you can see these results. Open LIVO to read documents and attachments.'],
  open: ['在 LIVO 開啟', '在 LIVO 打开', 'Open in LIVO'],
  next: ['下一頁', '下一页', 'Next'],
  previous: ['上一頁', '上一页', 'Previous'],
  newSearch: ['搜尋其他文件', '搜索其他文件', 'New search'],
  invalid: ['請輸入最多 100 字的關鍵字。', '请输入最多 100 字的关键词。', 'Enter keywords, up to 100 characters.'],
  error: ['無法搜尋，請確認帳號連結與權限後重新執行 /livo kb。', '无法搜索，请确认账号关联与权限后重新执行 /livo kb。', 'Search unavailable. Check your account link and permissions, then run /livo kb again.'],
  disabled: ['Slack 功能尚未啟用，請洽最高管理員。', 'Slack 功能尚未启用，请联系最高管理员。', 'Slack integration is disabled. Contact a workspace owner.'],
};
const tr = (key: string, locale?: string) => messages[key][locale?.startsWith('en') ? 2 : /^(zh-CN|zh-Hans)/i.test(locale || '') ? 1 : 0];
export const knowledgeSearchLabel = (locale?: string) => tr('title', locale);
const escape = (value: unknown, max = 500) => String(value ?? '').slice(0, max)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const section = (text: string): Row => ({ type: 'section', text: { type: 'mrkdwn', text } });
const plain = (text: string): Row => ({ type: 'context', elements: [{ type: 'plain_text', text }] });
const button = (id: string, text: string, value: Row): Row => ({ type: 'button', action_id: id,
  text: { type: 'plain_text', text }, value: JSON.stringify(value) });
const decode = (value: string) => value.replace(/&(amp|lt|gt);/g, (_, key: string) => ({ amp: '&', lt: '<', gt: '>' })[key] || '');
export function normalizeKnowledgeSearch(value: unknown): KnowledgeSearchQuery {
  const row = value && typeof value === 'object' ? value as Row : {};
  const text = String(row.text || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text || text.length > 100) throw new Error('knowledge_search_invalid');
  return { text, page: Number.isSafeInteger(row.page) && row.page >= 0 ? Math.min(row.page, 10000) : 0,
    category: ['general', 'meeting'].includes(row.category) ? row.category : 'all' };
}
export function isKnowledgeSlackPayload(p: Row): boolean {
  return !!(p.command && /^kb(?:\s|$)/i.test(String(p.text || '').trim()))
    || p.type === 'view_submission' && p.view?.callback_id === 'livo_kb_search'
    || p.type === 'block_actions' && ['livo_kb_search', 'livo_kb_page'].includes(p.actions?.[0]?.action_id)
    || ['message_action', 'shortcut'].includes(p.type) && p.callback_id === 'livo_search_knowledge';
}
function metadata(p: Row, extra: Row = {}): Row {
  return { user: p.user_id || p.user?.id, team: p.team_id || p.team?.id, ...extra };
}
function modal(p: Row, blocks: Row[], locale?: string, extra: Row = {}, submit = false): Row {
  return { type: 'modal', callback_id: submit ? 'livo_kb_search' : 'livo_kb_results',
    title: { type: 'plain_text', text: tr('title', locale) }, close: { type: 'plain_text', text: tr('close', locale) },
    ...(submit ? { submit: { type: 'plain_text', text: tr('search', locale) } } : {}),
    private_metadata: JSON.stringify(metadata(p, extra)), blocks };
}
export function knowledgeSearchModal(p: Row, locale?: string, initial = ''): Row {
  return modal(p, [
    { type: 'input', block_id: 'kb_query', label: { type: 'plain_text', text: tr('query', locale) },
      element: { type: 'plain_text_input', action_id: 'query', min_length: 1, max_length: 100,
        ...(initial ? { initial_value: initial.slice(0, 100) } : {}) } },
    { type: 'input', block_id: 'kb_category', label: { type: 'plain_text', text: tr('scope', locale) },
      element: { type: 'static_select', action_id: 'category', initial_option: { text: { type: 'plain_text', text: tr('all', locale) }, value: 'all' },
        options: ['all', 'general', 'meeting'].map(value => ({ text: { type: 'plain_text', text: tr(value, locale) }, value })) } },
    plain(tr('private', locale)),
  ], locale, {}, true);
}
export function knowledgeResultsModal(p: Row, query: KnowledgeSearchQuery, result: KnowledgeSearchPage,
  link: (page: Row) => string, locale?: string): Row {
  const blocks: Row[] = [plain(tr('private', locale)), section(escape(query.text, 100))];
  if (!result.pages.length) blocks.push(section(tr('empty', locale)));
  for (const page of result.pages.slice(0, KNOWLEDGE_SEARCH_SIZE)) {
    // Even authorized private titles are confined to this modal. No body, ACL,
    // attachment URL, JWT or hidden-result counts are sent to Slack.
    blocks.push(section(`*${escape(page.title, 300)}*`));
    blocks.push(plain([tr(page.category === 'meeting' ? 'meeting' : 'general', locale),
      String(page.project_name || '').slice(0, 100), String(page.updated_at || '').slice(0, 10)].filter(Boolean).join(' · ')));
    const url = link(page);
    if (/^https?:\/\//i.test(url)) blocks.push({ type: 'actions', elements: [{ type: 'button',
      text: { type: 'plain_text', text: tr('open', locale) }, url }] });
  }
  const nav: Row[] = [];
  if (result.page > 0) nav.push(button('livo_kb_page', tr('previous', locale), { ...query, page: result.page - 1 }));
  if (result.hasMore) nav.push(button('livo_kb_page', tr('next', locale), { ...query, page: result.page + 1 }));
  if (nav.length) blocks.push({ type: 'actions', elements: nav });
  blocks.push({ type: 'actions', elements: [button('livo_kb_search', tr('newSearch', locale), {})] });
  return modal(p, blocks, locale);
}
/** ACK immediately. Every document result is modal-only, with no message fallback. */
export async function handleKnowledgeSlack(p: Row, d: KnowledgeSlackActions): Promise<Row | undefined> {
  if (!isKnowledgeSlackPayload(p)) return undefined;
  const submitted = p.type === 'view_submission';
  let query: KnowledgeSearchQuery | undefined;
  let initial = '';
  try {
    if (submitted) query = normalizeKnowledgeSearch({ text: p.view?.state?.values?.kb_query?.query?.value,
      category: p.view?.state?.values?.kb_category?.category?.selected_option?.value });
    else if (p.command) {
      const text = decode(String(p.text || '').trim().replace(/^kb\s*/i, ''));
      if (text) query = normalizeKnowledgeSearch({ text });
    } else if (p.actions?.[0]?.action_id === 'livo_kb_page') query = normalizeKnowledgeSearch(JSON.parse(p.actions[0].value || '{}'));
    else if (p.type === 'message_action') initial = String(p.message?.text || '').replace(/<[^>]+>/g, '').trim().slice(0, 100);
  } catch {
    if (submitted) return { response_action: 'errors', errors: { kb_query: tr('invalid') } };
    return { response_type: 'ephemeral', text: tr('invalid') }; // No document data.
  }
  const loading = modal(p, [plain(tr('loading'))]);
  d.background((async () => {
    let opened: Row | undefined;
    try {
      if (!submitted) opened = await d.slack(p.view?.id ? 'views.update' : 'views.open', {
        ...(p.view?.id ? { view_id: p.view.id, ...(p.view.hash ? { hash: p.view.hash } : {}) } : { trigger_id: p.trigger_id }), view: loading });
      const actor = await d.actor(p);
      if (!await d.enabled()) throw new Error('disabled');
      const view = query ? knowledgeResultsModal(p, query, await d.search(actor, query), d.link, actor.locale)
        : knowledgeSearchModal(p, actor.locale, initial);
      await d.slack('views.update', { view_id: opened?.view?.id || p.view?.id,
        ...(!submitted && opened?.view?.hash ? { hash: opened.view.hash } : {}), view });
    } catch (error) {
      // Failure never calls the legacy public/thread/DM reply fallback.
      if (opened?.view?.id || submitted && p.view?.id) await d.slack('views.update', {
        view_id: opened?.view?.id || p.view.id,
        view: modal(p, [plain(tr(error instanceof Error && error.message === 'disabled' ? 'disabled' : 'error'))]),
      }).catch(() => {});
    }
  })());
  return submitted ? { response_action: 'update', view: loading } : {};
}
