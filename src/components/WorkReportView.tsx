import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWorkReport } from './work-report/useWorkReport';
import { shiftAnchor } from './work-report/types';
import WorkReportStats from './work-report/WorkReportStats';
import WorkReportEditor from './work-report/WorkReportEditor';
import WorkReportHistory from './work-report/WorkReportHistory';
import ReportSendPanel from './reports/ReportSendPanel';
import { useAuthContext } from '@/context/AuthContext';

const WorkReportView = () => {
  const { t } = useTranslation();
  const { currentMemberId } = useAuthContext();
  const {
    reportType, setReportType,
    anchor, setAnchor,
    title, content, setContent,
    savedReport, setSavedReport,
    loading, saving, saveStatus,
    history, showHistory, setShowHistory,
    completedCount, inProgressCount, overdueCount,
    handleGenerate, handleSave, handleCopy,
  } = useWorkReport();

  const [showSendPanel, setShowSendPanel] = useState(false);

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-4 py-6 md:px-6">
      <div className="max-w-5xl mx-auto space-y-5">

        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">{t('workReport.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t('workReport.subtitle')}</p>
        </div>

        <WorkReportStats
          completedCount={completedCount}
          inProgressCount={inProgressCount}
          overdueCount={overdueCount}
        />

        <WorkReportEditor
          reportType={reportType}
          onTabChange={type => { setReportType(type); setAnchor(new Date()); }}
          anchor={anchor}
          onShiftAnchor={dir => setAnchor(prev => shiftAnchor(reportType, prev, dir))}
          title={title}
          savedReport={savedReport}
          content={content}
          onContentChange={setContent}
          loading={loading}
          saving={saving}
          saveStatus={saveStatus}
          showHistory={showHistory}
          onToggleHistory={() => setShowHistory(!showHistory)}
          onGenerate={handleGenerate}
          onSave={handleSave}
          onCopy={handleCopy}
          onSend={() => setShowSendPanel(true)}
        />

        {showHistory && (
          <WorkReportHistory
            history={history}
            onSelect={(report) => {
              setSavedReport(report);
              setContent(report.content);
              setShowHistory(false);
            }}
          />
        )}

        {/* A work report covers all of a member's projects, so it goes to the workspace-wide
            targets, never to a project channel picked by the (hidden) sidebar selection. */}
        {showSendPanel && (
          <ReportSendPanel
            reportType={reportType}
            content={content}
            currentUserId={currentMemberId}
            onClose={() => setShowSendPanel(false)}
          />
        )}
      </div>
      </div>
    </div>
  );
};

export default WorkReportView;