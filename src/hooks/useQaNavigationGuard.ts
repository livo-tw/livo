import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { registerQaNavigationGuard } from '@/lib/qa/navigationGuard';

/** Protect a pending QA operation; explicit cancellation or forced teardown releases it. */
export function useQaNavigationGuard(active: boolean): void {
  const { t } = useTranslation();
  const notify = useRef(() => {});
  notify.current = () => { toast.info(t('qa.finishPending'), { id: 'qa-pending-navigation' }); };
  useLayoutEffect(() => {
    if (!active) return;
    return registerQaNavigationGuard(() => notify.current());
  }, [active]);
}
