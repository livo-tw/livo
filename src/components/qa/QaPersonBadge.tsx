import type { QaPersonProfile } from '@/lib/qa/domain';
import { qaPersonDisplay } from '@/lib/qa/peopleDisplay';

export default function QaPersonBadge({ person }: { person: QaPersonProfile }) {
  const display = qaPersonDisplay(person);
  return <span className="inline-flex min-w-0 items-center gap-1.5" title={[display.name, display.jobTitle].filter(Boolean).join(' · ')}>
    <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white" style={{ backgroundColor: display.color }}>{display.avatar}</span>
    <span className="truncate text-xs">{display.name}</span>
    {display.jobTitle && <span className="truncate text-[10px] font-normal text-muted-foreground">{display.jobTitle}</span>}
  </span>;
}
