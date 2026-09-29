import { GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { GitLabSettings } from './types';
import { ServiceCard, Field, inputCls } from './shared';

interface GitLabCardProps {
  gitlab: GitLabSettings;
  onChange: (s: GitLabSettings) => void;
  onSave: () => void;
  saving: boolean;
}

const GitLabCard = ({ gitlab, onChange, onSave, saving }: GitLabCardProps) => {
  const { t } = useTranslation();
  return (
  <ServiceCard
    icon={<GitBranch size={20} />}
    title={t('integrations.gitlab.title')}
    description={t('integrations.gitlab.desc')}
    enabled={gitlab.enabled}
    onToggle={v => onChange({ ...gitlab, enabled: v })}
    onSave={onSave}
    saving={saving}
  >
    <Field label={t('integrations.gitlab.urlLabel')}>
      <input
        type="url"
        className={inputCls}
        placeholder="https://gitlab.com"
        value={gitlab.url}
        onChange={e => onChange({ ...gitlab, url: e.target.value })}
      />
    </Field>
    <Field label="Personal Access Token">
      <input
        type="password"
        className={inputCls}
        placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
        value={gitlab.accessToken}
        onChange={e => onChange({ ...gitlab, accessToken: e.target.value })}
      />
    </Field>
    <Field label={t('integrations.gitlab.projectIdLabel')}>
      <input
        type="text"
        className={inputCls}
        placeholder="123"
        value={gitlab.projectId}
        onChange={e => onChange({ ...gitlab, projectId: e.target.value })}
      />
    </Field>
  </ServiceCard>
  );
};

export default GitLabCard;
