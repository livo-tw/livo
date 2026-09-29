import { useEffect, useRef } from 'react';
import { Clock, Eye, Plus, PlusCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ReportConfig } from './types';
import { DEFAULT_CUSTOM_TEMPLATE } from './constants';
import ReportPreview from './ReportPreview';
import {
  REPORT_GROUPS,
  getReportLabel, getReportGroupLabel,
  reportToDisplay, reportToStorage,
} from '@/lib/templateVariables';

interface GroupedProject {
  line: { id: string; name: string; icon?: string };
  projects: { id: string; name: string }[];
}

interface ReportConfigFormProps {
  cfg: ReportConfig;
  setCfg: (fn: (prev: ReportConfig) => ReportConfig) => void;
  saving: boolean;
  onSave: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  groupedProjects: GroupedProject[];
  showPreview: boolean;
  onTogglePreview: () => void;
  onInsertVariable: (varText: string) => void;
}

const ReportConfigForm = ({
  cfg, setCfg, saving, onSave, textareaRef,
  groupedProjects, showPreview, onTogglePreview, onInsertVariable,
}: ReportConfigFormProps) => {
  const { t } = useTranslation();
  const WEEKDAYS = [t('slackNotify.weekdays.sun'), t('slackNotify.weekdays.mon'), t('slackNotify.weekdays.tue'), t('slackNotify.weekdays.wed'), t('slackNotify.weekdays.thu'), t('slackNotify.weekdays.fri'), t('slackNotify.weekdays.sat')];

  // Track whether we've initialized display format
  const initializedRef = useRef(false);

  // When switching to custom template, pre-fill default if empty
  useEffect(() => {
    if (cfg.templateKey === 'custom' && !cfg.customTemplate && !initializedRef.current) {
      initializedRef.current = true;
      setCfg(prev => ({ ...prev, customTemplate: reportToDisplay(DEFAULT_CUSTOM_TEMPLATE) }));
    }
    if (cfg.templateKey !== 'custom') {
      initializedRef.current = false;
    }
  }, [cfg.templateKey, cfg.customTemplate, setCfg]);

  // Wrapper: insert variable in display format
  const handleInsertVariable = (key: string) => {
    const label = getReportLabel(key as any);
    onInsertVariable(`【${label}】`);
  };

  return (
  <div className="space-y-4">
    {/* Enable toggle */}
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium text-foreground">
        {t('autoReport.enablePrefix')}{cfg.reportType === 'daily' ? t('autoReport.dailyLabel') : t('autoReport.weeklyLabel')}
      </span>
      <button
        onClick={() => setCfg(prev => ({ ...prev, enabled: !prev.enabled }))}
        className={`relative w-11 h-6 rounded-full transition-colors ${cfg.enabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${cfg.enabled ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </div>

    {cfg.enabled && (
      <>
        {/* Time */}
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block flex items-center gap-1.5">
            <Clock size={14} /> {t('autoReport.sendTimeLabel')}
          </label>
          <div className="flex items-center gap-2">
            {cfg.reportType === 'weekly' && (
              <select
                value={cfg.weekday}
                onChange={e => setCfg(prev => ({ ...prev, weekday: parseInt(e.target.value) }))}
                className="border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary"
              >
                {WEEKDAYS.map((label, i) => <option key={i} value={i}>{label}</option>)}
              </select>
            )}
            <select
              value={cfg.hour}
              onChange={e => setCfg(prev => ({ ...prev, hour: parseInt(e.target.value) }))}
              className="border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary"
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>{String(i).padStart(2, '0')}</option>
              ))}
            </select>
            <span className="text-foreground">:</span>
            <select
              value={cfg.minute}
              onChange={e => setCfg(prev => ({ ...prev, minute: parseInt(e.target.value) }))}
              className="border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary"
            >
              {[0, 15, 30, 45].map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
            </select>
          </div>
        </div>

        {/* Scope */}
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('autoReport.scopeLabel')}</label>
          <div className="space-y-2">
            {[
              { value: 'assigned_to_me', label: t('autoReport.scopeAssignedToMe') },
              { value: 'my_projects', label: t('autoReport.scopeMyProjects') },
              { value: 'specific_projects', label: t('autoReport.scopeSpecificProjects') },
            ].map(opt => (
              <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name={`scope-${cfg.reportType}`}
                  checked={cfg.scope === opt.value}
                  onChange={() => setCfg(prev => ({ ...prev, scope: opt.value as ReportConfig['scope'] }))}
                  className="text-primary focus:ring-primary"
                />
                <span className="text-sm text-foreground">{opt.label}</span>
              </label>
            ))}
          </div>
          {cfg.scope === 'specific_projects' && (
            <div className="mt-2 ml-6 max-h-40 overflow-y-auto border border-border rounded-lg p-2 space-y-1">
              {groupedProjects.map(g => (
                <div key={g.line.id}>
                  <div className="text-xs font-medium text-muted-foreground mb-0.5">{g.line.icon} {g.line.name}</div>
                  {g.projects.map(p => (
                    <label key={p.id} className="flex items-center gap-2 py-0.5 pl-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cfg.scopeProjectIds.includes(p.id)}
                        onChange={() => {
                          setCfg(prev => ({
                            ...prev,
                            scopeProjectIds: prev.scopeProjectIds.includes(p.id)
                              ? prev.scopeProjectIds.filter(id => id !== p.id)
                              : [...prev.scopeProjectIds, p.id],
                          }));
                        }}
                        className="rounded border-border text-primary focus:ring-primary"
                      />
                      <span className="text-sm text-foreground">{p.name}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Template */}
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('autoReport.templateLabel')}</label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`template-${cfg.reportType}`}
                checked={cfg.templateKey !== 'custom'}
                onChange={() => setCfg(prev => ({ ...prev, templateKey: cfg.reportType === 'daily' ? 'default_daily' : 'default_weekly' }))}
                className="text-primary focus:ring-primary"
              />
              <span className="text-sm text-foreground">
                {t('autoReport.defaultTemplatePrefix')}{cfg.reportType === 'daily' ? t('autoReport.dailyFormat') : t('autoReport.weeklyFormat')}）
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name={`template-${cfg.reportType}`}
                checked={cfg.templateKey === 'custom'}
                onChange={() => setCfg(prev => ({ ...prev, templateKey: 'custom' }))}
                className="text-primary focus:ring-primary"
              />
              <span className="text-sm text-foreground">{t('autoReport.customTemplate')}</span>
            </label>
          </div>
          {cfg.templateKey === 'custom' && (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-muted/40 text-xs text-muted-foreground">
                {t('autoReport.channelDeliveryNote')}
              </div>
              <div className="border border-border rounded-lg p-2.5 bg-muted/30">
                <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-muted-foreground">
                  <PlusCircle size={12} />
                  {t('autoReport.clickToInsert')}
                </div>
                <div className="space-y-2">
                  {REPORT_GROUPS.map(({ group, keys }) => (
                    <div key={group}>
                      <span className="text-[9px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
                        {getReportGroupLabel(group)}
                      </span>
                      <div className="flex flex-wrap gap-1.5 mt-0.5">
                        {keys.map(k => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => handleInsertVariable(k)}
                            className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 hover:border-primary/40 transition-colors cursor-pointer"
                          >
                            <Plus size={9} className="shrink-0 opacity-60" />
                            {getReportLabel(k)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <textarea
                ref={textareaRef}
                value={cfg.customTemplate}
                onChange={e => setCfg(prev => ({ ...prev, customTemplate: e.target.value }))}
                placeholder={t('autoReport.templatePlaceholder')}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary min-h-[120px]"
              />
            </div>
          )}
        </div>

        {/* Send target */}
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('autoReport.sendTargetLabel')}</label>
          <div className="flex gap-2 mb-2">
            {[
              { value: 'dm', label: t('autoReport.sendTargetDm') },
              { value: 'channel', label: t('autoReport.sendTargetChannel') },
            ].map(opt => (
              <button
                key={opt.value}
                onClick={() => setCfg(prev => ({ ...prev, sendTarget: opt.value as 'dm' | 'channel' }))}
                className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  cfg.sendTarget === opt.value ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:bg-accent'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {cfg.sendTarget === 'channel' && (
            <input
              value={cfg.sendChannel}
              onChange={e => setCfg(prev => ({ ...prev, sendChannel: e.target.value }))}
              placeholder={t('autoReport.channelPlaceholder')}
              className="w-full max-w-xs border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary"
            />
          )}
        </div>

        {/* Actions */}
        <div className="pt-2 flex items-center gap-3">
          <button
            onClick={onSave}
            disabled={saving}
            className="px-5 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? t('common.saving') : t('autoReport.saveButton')}
          </button>
          <button
            onClick={onTogglePreview}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-border text-foreground hover:bg-accent transition-colors flex items-center gap-1.5"
          >
            <Eye size={14} />
            {showPreview ? t('autoReport.hidePreview') : t('autoReport.previewButton')}
          </button>
        </div>

        {showPreview && <ReportPreview cfg={cfg} />}
      </>
    )}
  </div>
  );
};

export default ReportConfigForm;
