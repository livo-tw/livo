import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import UpgradePrompt from '@/components/UpgradePrompt';
import type { BackupSettings } from './AdminBackupSection';
import type { FeatureName } from '@/lib/license';

interface AdminNotifySectionProps {
  hasFeature: (feature: FeatureName) => boolean;
  backupSettings: BackupSettings | null;
  saveBackupSettings: (updates: Partial<BackupSettings>) => Promise<void>;
}

const NOTIFY_EVENT_I18N: { key: string; labelKey: string; descKey: string }[] = [
  { key: 'task_created', labelKey: 'adminNotify.events.taskCreated', descKey: 'adminNotify.events.taskCreatedDesc' },
  { key: 'status_changed', labelKey: 'adminNotify.events.statusChanged', descKey: 'adminNotify.events.statusChangedDesc' },
  { key: 'assignee_changed', labelKey: 'adminNotify.events.assigneeChanged', descKey: 'adminNotify.events.assigneeChangedDesc' },
  { key: 'priority_changed', labelKey: 'adminNotify.events.priorityChanged', descKey: 'adminNotify.events.priorityChangedDesc' },
  { key: 'comment_added', labelKey: 'adminNotify.events.commentAdded', descKey: 'adminNotify.events.commentAddedDesc' },
];

const AdminNotifySection = ({ hasFeature, backupSettings, saveBackupSettings }: AdminNotifySectionProps) => {
  const { t } = useTranslation();

  const NOTIFY_EVENTS = NOTIFY_EVENT_I18N.map(e => ({
    key: e.key,
    label: t(e.labelKey),
    desc: t(e.descKey),
  }));
  const [taskNotifyChannel, setTaskNotifyChannel] = useState(backupSettings?.task_notify_channel || '');
  const [taskNotifyTypes, setTaskNotifyTypes] = useState<string[]>(
    backupSettings?.task_notify_types || ['task_created', 'status_changed', 'assignee_changed', 'comment_added']
  );
  const [dmNotifyEnabled, setDmNotifyEnabled] = useState(backupSettings?.dm_notify_enabled ?? true);
  const [dmNotifyStartHour, setDmNotifyStartHour] = useState(backupSettings?.dm_notify_start_hour ?? 9);
  const [dmNotifyEndHour, setDmNotifyEndHour] = useState(backupSettings?.dm_notify_end_hour ?? 18);

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-foreground flex items-center gap-2 border-b border-border pb-2">
        <Bell size={18} className="text-primary" />
        {t('adminNotify.sectionTitle')}
      </h2>
      {!hasFeature('slack-notify') ? (
        <UpgradePrompt feature="slack-notify" inline />
      ) : (
      <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bell size={20} className="text-primary" />
            {t('adminNotify.taskNotificationTitle')}
          </CardTitle>
          <CardDescription>{t('adminNotify.taskNotificationDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {backupSettings && (
            <>
              <div className="space-y-2 max-w-md">
                <Label className="text-sm">{t('adminNotify.channelLabel')}</Label>
                <Input
                  placeholder={t('adminNotify.channelPlaceholder')}
                  value={taskNotifyChannel}
                  onChange={(e) => setTaskNotifyChannel(e.target.value)}
                  onBlur={() => saveBackupSettings({ task_notify_channel: taskNotifyChannel })}
                />
              </div>
              <div className="space-y-3">
                <Label className="text-sm">{t('adminNotify.eventsLabel')}</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {NOTIFY_EVENTS.map(item => (
                    <label key={item.key} className="flex items-start gap-3 cursor-pointer p-2.5 rounded-md hover:bg-muted/50 transition-colors">
                      <Checkbox
                        checked={taskNotifyTypes.includes(item.key)}
                        onCheckedChange={(checked) => {
                          const newTypes = checked
                            ? [...taskNotifyTypes, item.key]
                            : taskNotifyTypes.filter(t => t !== item.key);
                          setTaskNotifyTypes(newTypes);
                          saveBackupSettings({ task_notify_types: newTypes });
                        }}
                      />
                      <div className="-mt-0.5">
                        <span className="text-sm font-medium text-foreground">{item.label}</span>
                        <p className="text-xs text-muted-foreground">{item.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bell size={20} className="text-primary" />
            {t('adminNotify.dmNotificationTitle')}
          </CardTitle>
          <CardDescription>{t('adminNotify.dmNotificationDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {backupSettings && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">{t('adminNotify.dmEnableLabel')}</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('adminNotify.dmEnableDesc')}</p>
                </div>
                <Switch
                  checked={dmNotifyEnabled}
                  onCheckedChange={(checked) => {
                    setDmNotifyEnabled(checked);
                    saveBackupSettings({ dm_notify_enabled: checked });
                  }}
                />
              </div>
              {dmNotifyEnabled && (
                <div className="space-y-3">
                  <div>
                    <Label className="text-sm font-medium">{t('adminNotify.dmTimeRangeLabel')}</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('adminNotify.dmTimeRangeDesc')}</p>
                  </div>
                  <div className="flex items-center gap-3 max-w-xs">
                    <Select
                      value={String(dmNotifyStartHour)}
                      onValueChange={(v) => {
                        const val = parseInt(v);
                        setDmNotifyStartHour(val);
                        saveBackupSettings({ dm_notify_start_hour: val });
                      }}
                    >
                      <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={String(i)}>{String(i).padStart(2, '0')}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-sm text-muted-foreground">{t('adminNotify.timeTo')}</span>
                    <Select
                      value={String(dmNotifyEndHour)}
                      onValueChange={(v) => {
                        const val = parseInt(v);
                        setDmNotifyEndHour(val);
                        saveBackupSettings({ dm_notify_end_hour: val });
                      }}
                    >
                      <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 24 }, (_, i) => (
                          <SelectItem key={i} value={String(i)}>{String(i).padStart(2, '0')}:00</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('adminNotify.dmTimeRangeExample')}
                  </p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
      </>
      )}
    </div>
  );
};

export default AdminNotifySection;
