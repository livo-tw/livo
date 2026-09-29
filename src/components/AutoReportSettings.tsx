import { BarChart3, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAutoReportSettings } from './auto-report/useAutoReportSettings';
import ReportConfigForm from './auto-report/ReportConfigForm';

const AutoReportSettings = () => {
  const { t } = useTranslation();
  const {
    daily, setDaily,
    weekly, setWeekly,
    loading,
    savingDaily, setSavingDaily,
    savingWeekly, setSavingWeekly,
    activeTab, setActiveTab,
    showPreview, setShowPreview,
    dailyTextareaRef, weeklyTextareaRef,
    groupedProjects,
    handleSave,
    insertVariable,
  } = useAutoReportSettings();

  if (loading) return <div className="text-sm text-muted-foreground">{t('autoReport.loading')}</div>;

  const isDaily = activeTab === 'daily';
  const cfg = isDaily ? daily : weekly;
  const setCfg = isDaily ? setDaily : setWeekly;
  const saving = isDaily ? savingDaily : savingWeekly;
  const setSaving = isDaily ? setSavingDaily : setSavingWeekly;
  const textareaRef = isDaily ? dailyTextareaRef : weeklyTextareaRef;

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        {t('autoReport.infoBanner')}
      </div>
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('daily')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'daily' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <FileText size={14} /> {t('autoReport.dailyConfig')}
        </button>
        <button
          onClick={() => setActiveTab('weekly')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
            activeTab === 'weekly' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <BarChart3 size={14} /> {t('autoReport.weeklyConfig')}
        </button>
      </div>

      <ReportConfigForm
        cfg={cfg}
        setCfg={setCfg}
        saving={saving}
        onSave={() => handleSave(cfg, setSaving)}
        textareaRef={textareaRef}
        groupedProjects={groupedProjects}
        showPreview={showPreview}
        onTogglePreview={() => setShowPreview(!showPreview)}
        onInsertVariable={varText => insertVariable(varText, setCfg, textareaRef)}
      />
    </div>
  );
};

export default AutoReportSettings;
