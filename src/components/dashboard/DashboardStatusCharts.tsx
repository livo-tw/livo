import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useTranslation } from 'react-i18next';
import { getDwellColor } from './useDashboardData';

interface StatusItem { name: string; count: number; color: string; pct: number; }
interface DwellItem { id: string; name: string; avg: number; samples: number; }

interface DashboardStatusChartsProps {
  statusData: StatusItem[];
  dwellData: DwellItem[];
  isMobile: boolean;
}

const DashboardStatusCharts = ({ statusData, dwellData, isMobile }: DashboardStatusChartsProps) => {
  const { t } = useTranslation();
  const maxDwell = Math.max(...dwellData.map(d => d.avg), 1);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 mb-4 md:mb-6">
      <div className="bg-card rounded-lg border border-border p-3 md:p-4">
        <h3 className="text-sm md:text-base font-semibold text-foreground mb-3">{t('dashboard.statusDistributionTitle')}</h3>
        <ResponsiveContainer width="100%" height={isMobile ? 180 : 220}>
          <BarChart data={statusData} layout="vertical">
            <XAxis type="number" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} width={isMobile ? 50 : 70} />
            <Tooltip
              formatter={(value: number, name: string) => [t('dashboard.cardCountFormat', { count: value }), name]}
              contentStyle={{ fontSize: 12, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
            />
            <Bar dataKey="count" radius={[0, 4, 4, 0]}>
              {statusData.map((entry, i) => (<Cell key={i} fill={entry.color} />))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-card rounded-lg border border-border p-3 md:p-4">
        <h3 className="text-sm md:text-base font-semibold text-foreground mb-3">{t('dashboard.avgDwellTimeTitle')}</h3>
        <div className="space-y-2 md:space-y-3">
          {dwellData.map(d => (
            <div key={d.id} className="flex items-center gap-1.5 md:gap-2">
              <span className="text-[13px] text-muted-foreground w-[60px] md:w-[70px] text-right shrink-0 truncate">{d.name}</span>
              <div className="flex-1 bg-muted rounded-full h-4 md:h-5 relative overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${Math.max((d.avg / maxDwell) * 100, d.avg > 0 ? 8 : 0)}%`, backgroundColor: getDwellColor(d.avg) }}
                />
              </div>
              <span className="text-[13px] font-semibold w-12 text-right" style={{ color: getDwellColor(d.avg) }}>{t('dashboard.dwellDays', { days: d.avg })}</span>
              <span className="text-[13px] text-muted-foreground w-8">{t('dashboard.sampleCount', { count: d.samples })}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 mt-3 md:mt-4 text-[13px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> {t('dashboard.dwellLegendGood')}</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> {t('dashboard.dwellLegendWarn')}</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-500" /> {t('dashboard.dwellLegendBad')}</span>
        </div>
      </div>
    </div>
  );
};

export default DashboardStatusCharts;
