import { afterEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import en from '@/i18n/locales/en.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import { QA_STATES } from '@/lib/qa/domain';

const keys = (value: Record<string, unknown>, prefix = ''): string[] => Object.entries(value).flatMap(([key, item]) =>
  item && typeof item === 'object' ? keys(item as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`]).sort();

afterEach(async () => { await i18n.changeLanguage('zh-TW'); });
describe('QA translations use the shared locale resources', () => {
  it.each(['en', 'zh-TW', 'zh-CN'])('translates every workflow state and new reporting action in %s', language => {
    const required = [...QA_STATES.map(state => `qa.state.${state}`),
      'qa.dropPermission', 'qa.dropSaved', 'qa.dropSaving', 'qa.dropUncertain', 'qa.dropFiles', 'qa.createBug', 'qa.priorityDefault',
      'qa.slackSource', 'qa.notProvided', 'qa.finishPending',
      'standup.settings.shuffle', 'standup.noActiveMembers', 'standup.turnUnit', 'sidebar.standup',
      'deploymentEnvironments.title', 'deploymentEnvironments.restoreMissing'];
    for (const key of required) expect(i18n.getResource(language, 'translation', key), key).toEqual(expect.stringMatching(/\S/));
  });
  it('provides matching QA keys and nonempty translations in all three locale files', () => {
    const expected = keys(en.qa);
    expect(keys(zhTW.qa)).toEqual(expected);
    expect(keys(zhCN.qa)).toEqual(expected);
    for (const language of ['en', 'zh-TW', 'zh-CN']) {
      for (const key of expected) {
        expect(i18n.getResource(language, 'translation', `qa.${key}`)).toEqual(expect.stringMatching(/\S/));
      }
    }
  });
  it.each([
    ['en', 'Board', 'QA workflow settings'],
    ['zh-TW', '看板', 'QA 流程設定'],
    ['zh-CN', '看板', 'QA 流程设置'],
  ])('loads the QA view and workflow labels through i18n in %s', async (language, board, workflow) => {
    await i18n.changeLanguage(language);
    expect(i18n.t('qa.board')).toBe(board);
    expect(i18n.t('qa.workflowTitle')).toBe(workflow);
    expect(i18n.t('qa.workflowMoveUp', { name: 'Stage A' })).toContain('Stage A');
  });
});
