import { useState, useMemo } from 'react';
import { CalendarIcon, X } from 'lucide-react';
import { format, addDays, addWeeks, addMonths, nextMonday, isMonday, parseISO } from 'date-fns';
import { zhTW, zhCN, enUS } from 'date-fns/locale';
import { useTranslation } from 'react-i18next';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';

type DatePickerFieldProps = {
  value: string | undefined;           // YYYY-MM-DD or undefined
  onChange: (date: string | undefined) => void;
  minDate?: string;                    // YYYY-MM-DD — dates before this are disabled
  defaultMonth?: Date;                 // calendar opens at this month
  mode: 'start' | 'due';
  startDate?: string;                  // for due-date quick picks based on start
};

const getLocale = (lang: string) => {
  if (lang.startsWith('zh-TW') || lang === 'zh-Hant') return zhTW;
  if (lang.startsWith('zh')) return zhCN;
  return enUS;
};

export default function DatePickerField({ value, onChange, minDate, defaultMonth, mode, startDate }: DatePickerFieldProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const locale = getLocale(i18n.language);

  const selected = value ? parseISO(value) : undefined;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const minDateObj = minDate ? parseISO(minDate) : undefined;

  const calendarDefault = useMemo(() => {
    if (selected) return selected;
    if (defaultMonth) return defaultMonth;
    if (mode === 'due' && startDate) {
      const d = parseISO(startDate);
      d.setDate(d.getDate() + 7);
      return d;
    }
    return today;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, defaultMonth, mode, startDate]);

  const quickPicks = useMemo(() => {
    if (mode === 'start') {
      const nm = isMonday(today) ? addWeeks(today, 1) : nextMonday(today);
      return [
        { label: t('datePicker.today'), date: today },
        { label: t('datePicker.tomorrow'), date: addDays(today, 1) },
        { label: t('datePicker.nextMonday'), date: nm },
        { label: t('datePicker.twoWeeks'), date: addWeeks(today, 2) },
      ];
    }
    // due mode — base on startDate or today
    const base = startDate ? parseISO(startDate) : today;
    return [
      { label: t('datePicker.oneWeekLater'), date: addWeeks(base, 1) },
      { label: t('datePicker.twoWeeksLater'), date: addWeeks(base, 2) },
      { label: t('datePicker.oneMonthLater'), date: addMonths(base, 1) },
    ];
  }, [mode, startDate, today, t]);

  const handleSelect = (day: Date | undefined) => {
    if (day) {
      onChange(format(day, 'yyyy-MM-dd'));
    }
    setOpen(false);
  };

  const handleQuick = (date: Date) => {
    onChange(format(date, 'yyyy-MM-dd'));
    setOpen(false);
  };

  const displayValue = selected
    ? format(selected, 'yyyy/MM/dd', { locale })
    : '';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full mt-1 text-sm rounded px-2 py-1.5 outline-none bg-muted text-foreground flex items-center justify-between gap-1 hover:bg-accent transition-colors text-left"
        >
          <span className={displayValue ? '' : 'text-muted-foreground/50 text-xs'}>
            {displayValue || t('taskCreate.selectDate')}
          </span>
          <span className="flex items-center gap-0.5 flex-shrink-0">
            {value && (
              <span
                role="button"
                className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                onClick={e => { e.stopPropagation(); onChange(undefined); }}
              >
                <X size={12} />
              </span>
            )}
            <CalendarIcon size={13} className="text-muted-foreground" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" sideOffset={4}>
        {/* Quick pick buttons */}
        <div className="flex flex-wrap gap-1 px-3 pt-3 pb-1">
          {quickPicks.map(qp => (
            <button
              key={qp.label}
              type="button"
              onClick={() => handleQuick(qp.date)}
              className="text-[11px] px-2 py-1 rounded-full border border-border bg-muted hover:bg-primary hover:text-primary-foreground hover:border-primary transition-colors font-medium"
            >
              {qp.label}
            </button>
          ))}
        </div>
        <Calendar
          mode="single"
          selected={selected}
          onSelect={handleSelect}
          defaultMonth={calendarDefault}
          locale={locale}
          disabled={minDateObj ? { before: minDateObj } : undefined}
          today={today}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}
