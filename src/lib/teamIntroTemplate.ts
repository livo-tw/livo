import type { TFunction } from 'i18next';
import type { TeamIntroField } from '../../worker/src/teamIntroTemplate';
export {
  defaultTeamIntroTemplate, isManualTextKey, MANUAL_TEXT_KEYS,
  MAX_TEAM_INTRO_FIELDS, parseTeamIntroTemplate, TEAM_INTRO_TEMPLATE_KEY,
} from '../../worker/src/teamIntroTemplate';
export type { TeamIntroField, TeamIntroTemplate, ManualTextKey } from '../../worker/src/teamIntroTemplate';

const LABEL_KEYS: Record<string, string> = {
  best_state: 'bestState', communication: 'communication', difficulty: 'difficulty',
  landmine: 'landmine', bonus: 'bonus', projects: 'projects',
};

export function defaultFieldLabel(key: string, t: TFunction): string {
  return LABEL_KEYS[key] ? t(`teamIntro.fields.${LABEL_KEYS[key]}`) : '';
}

export function teamIntroFieldLabel(field: TeamIntroField, t: TFunction): string {
  return field.label || defaultFieldLabel(field.key, t);
}
