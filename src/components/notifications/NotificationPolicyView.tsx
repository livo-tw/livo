import { useEffect, useCallback } from 'react';
import { useNotificationTemplates } from '@/hooks/useNotificationTemplates';
import { useNotificationRules } from '@/hooks/useNotificationRules';
import { useAuthContext } from '@/context/AuthContext';
import { logActivity } from '@/lib/activityLog';
import i18n from '@/i18n';
import type { NotificationTemplate, NotificationRule } from '@/lib/notificationQueries';
import NotificationRuleList from './NotificationRuleList';
import NotificationTemplateManager from './NotificationTemplateManager';

const NotificationPolicyView = () => {
  const { currentMemberId } = useAuthContext();
  const {
    templates,
    loading: templatesLoading,
    fetchTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
  } = useNotificationTemplates();

  const {
    rules,
    loading: rulesLoading,
    fetchRules,
    createRule,
    deleteRule,
    toggleRule,
  } = useNotificationRules();

  useEffect(() => {
    void fetchTemplates();
    void fetchRules();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Rules handlers ─────────────────────────────────────────

  const handleToggleRule = useCallback(async (id: string, enabled: boolean) => {
    await toggleRule(id, enabled);
    if (currentMemberId) logActivity(currentMemberId, 'notification_rule_toggled', i18n.t('activityLog.notificationRuleToggled', { action: enabled ? 'enabled' : 'disabled' }), undefined, undefined, 'system');
  }, [toggleRule, currentMemberId]);

  const handleDeleteRule = useCallback(async (id: string) => {
    await deleteRule(id);
    if (currentMemberId) logActivity(currentMemberId, 'notification_rule_deleted', i18n.t('activityLog.notificationRuleDeleted'), undefined, undefined, 'system');
  }, [deleteRule, currentMemberId]);

  const handleCreateRule = useCallback(async (
    data: Omit<NotificationRule, 'id' | 'created_at' | 'updated_at'>
  ) => {
    await createRule(data);
    if (currentMemberId) logActivity(currentMemberId, 'notification_rule_created', i18n.t('activityLog.notificationRuleCreated', { event: data.event_type }), undefined, undefined, 'system');
  }, [createRule, currentMemberId]);

  // ── Template handlers ──────────────────────────────────────

  const handleUpdateTemplate = useCallback(async (
    id: string,
    patch: Partial<NotificationTemplate>
  ) => {
    await updateTemplate(id, patch);
    if (currentMemberId) logActivity(currentMemberId, 'notification_template_updated', i18n.t('activityLog.notificationTemplateUpdated', { name: patch.name ?? id }), undefined, undefined, 'system');
  }, [updateTemplate, currentMemberId]);

  const handleDeleteTemplate = useCallback(async (id: string) => {
    await deleteTemplate(id);
    if (currentMemberId) logActivity(currentMemberId, 'notification_template_deleted', i18n.t('activityLog.notificationTemplateDeleted'), undefined, undefined, 'system');
  }, [deleteTemplate, currentMemberId]);

  const handleAddTemplate = useCallback(async (
    data: Omit<NotificationTemplate, 'id' | 'created_at' | 'updated_at' | 'created_by'>
  ) => {
    await createTemplate({ ...data, created_by: null });
    if (currentMemberId) logActivity(currentMemberId, 'notification_template_created', i18n.t('activityLog.notificationTemplateCreated', { name: data.name }), undefined, undefined, 'system');
  }, [createTemplate, currentMemberId]);

  return (
    <div className="space-y-6">
      <NotificationRuleList
        rules={rules}
        templates={templates}
        loading={rulesLoading}
        onToggle={handleToggleRule}
        onDelete={handleDeleteRule}
        onCreate={handleCreateRule}
      />

      <div className="border-t border-border pt-6">
        <NotificationTemplateManager
          templates={templates}
          loading={templatesLoading}
          onUpdate={handleUpdateTemplate}
          onDelete={handleDeleteTemplate}
          onAdd={handleAddTemplate}
        />
      </div>
    </div>
  );
};

export default NotificationPolicyView;
