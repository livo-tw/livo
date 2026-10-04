import { describe, expect, it } from 'vitest';
import { appDeepLinkSearch } from '@/lib/appDeepLink';
import { knowledgePageText, knowledgePageUrl, knowledgePrintHtml } from '@/lib/knowledgeSharing';
import { identifyKnowledgePreset, knowledgePermissionPreset } from '@/lib/knowledgePermissionPresets';
import { knowledgeCan } from '../../worker/src/knowledgeAccess';

describe('knowledge access shortcuts', () => {
  const owner = { id: 'example-owner', role: 'member' };
  it('keeps Only me private even from administrators and unauthenticated visitors', () => {
    const policy = knowledgePermissionPreset('self', owner.id);
    const pages = [{ id: 'page', parent_id: null as string | null, access_policy: policy }];
    expect(identifyKnowledgePreset(policy, owner.id)).toBe('self');
    expect(knowledgeCan(pages, 'page', owner, 'edit')).toBe(true);
    for (const role of ['member', 'admin', 'super_admin']) expect(knowledgeCan(pages, 'page', { id: 'another-person', role }, 'view')).toBe(false);
    expect(knowledgeCan(pages, 'page', null, 'view')).toBe(false);
  });
  it('grants workspace view/comment without giving everyone edit access', () => {
    const policy = knowledgePermissionPreset('workspace', owner.id);
    const pages = [{ id: 'page', parent_id: null as string | null, access_policy: policy }];
    expect(identifyKnowledgePreset(policy, owner.id)).toBe('workspace');
    for (const role of ['member', 'admin', 'super_admin']) {
      const viewer = { id: 'another-person', role };
      expect(knowledgeCan(pages, 'page', viewer, 'view')).toBe(true);
      expect(knowledgeCan(pages, 'page', viewer, 'comment')).toBe(true);
      expect(knowledgeCan(pages, 'page', viewer, 'edit')).toBe(false);
    }
    expect(knowledgeCan(pages, 'page', { ...owner, is_active: false }, 'view')).toBe(false);
  });
  it('cannot override parent restrictions or an owner-only draft', () => {
    const pages = [{ id: 'parent', parent_id: null, access_policy: knowledgePermissionPreset('self', owner.id) }, { id: 'child', parent_id: 'parent', access_policy: knowledgePermissionPreset('workspace', owner.id) }];
    expect(knowledgeCan(pages, 'child', { id: 'other', role: 'admin' }, 'view')).toBe(false);
    expect(knowledgeCan([{ ...pages[1], parent_id: null, private_draft_owner_id: owner.id }], 'child', { id: 'other', role: 'admin' }, 'view')).toBe(false);
  });
});

describe('knowledge portable copies', () => {
  it('uses the installation base path and preserves the page through sign-in', () => {
    const cloud = knowledgePageUrl('example page', 'https://example.com', '/demo/');
    const local = knowledgePageUrl('example page', 'http://example.com:3000', '/');
    expect(cloud).toBe('https://example.com/demo/?kb=example+page');
    expect(local).toBe('http://example.com:3000/?kb=example+page');
    expect(appDeepLinkSearch(new URL(cloud).search)).toBe('?kb=example+page');
  });
  it('copies complete collapsed source, table cells and links without scripts', () => {
    const text = knowledgePageText('Example guide', '<h2>Overview</h2><p>First<br>Second</p><ul><li>Action</li></ul><ol start="3"><li>Third step</li><li>Fourth step</li></ol><table><tr><td>A</td><td>B</td></tr></table><details><summary>Source</summary><p>Full source</p></details><a href="https://example.com/guide">Guide</a><script>secretScript()</script>');
    expect(text).toContain('Example guide\n\nOverview'); expect(text).toContain('First\nSecond'); expect(text).toContain('• Action'); expect(text).toContain('A\tB'); expect(text).toContain('Full source'); expect(text).toContain('Guide (https://example.com/guide)'); expect(text).not.toContain('secretScript');
    expect(text).toContain('3. Third step'); expect(text).toContain('4. Fourth step');
  });
  it('prints sanitized saved body and escaped metadata, without app navigation or external PDF services', () => {
    const html = knowledgePrintHtml({ title: '<script>Bad title</script>', body: '<p>中文內容</p><details><summary>Source</summary><p>Full source</p></details><img src="https://example.com/image.png" onerror="alert(1)"><script>alert(2)</script>' }, { scope: '<b>Example</b>', updated: '2026-10-04', copyNotice: 'Independent copy' });
    expect(html).toContain('&lt;script&gt;Bad title&lt;/script&gt;'); expect(html).toContain('中文內容'); expect(html).toContain('size:A4'); expect(html).toContain('&lt;b&gt;Example&lt;/b&gt;'); expect(html).not.toMatch(/<script|onerror|fetch\(/); expect(html).toContain("default-src 'none'");
    expect(html).toContain('<details open="">');
  });
});
