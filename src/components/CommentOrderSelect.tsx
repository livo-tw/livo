import { useTranslation } from 'react-i18next';
import type { CommentOrder } from '@/lib/commentOrdering';

export function CommentOrderSelect({ order, onChange }: {
  order: CommentOrder;
  onChange: (order: CommentOrder) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="mb-3 flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
      <span>{t('taskDetail.comments.sortLabel')}</span>
      <select
        value={order}
        onChange={event => onChange(event.currentTarget.value === 'oldest' ? 'oldest' : 'newest')}
        className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
      >
        <option value="newest">{t('taskDetail.comments.newestFirst')}</option>
        <option value="oldest">{t('taskDetail.comments.oldestFirst')}</option>
      </select>
    </label>
  );
}
