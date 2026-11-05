import { toast } from 'sonner';
import type { TFunction } from 'i18next';
import type { Task } from '@/types';
import { taskDeepLinkUrl } from '@/lib/appDeepLink';
import { copyText } from '@/lib/clipboard';

/** Only call after creation is confirmed, with the task returned by the server. */
export function showTaskCreatedToast(task: Pick<Task, 'id' | 'taskKey'>, t: TFunction): void {
  const url = taskDeepLinkUrl(task.id);
  const copyFailed = () => toast.error(t('common.copyFailed'), { description: url });

  toast.success(t('task.created'), {
    duration: 10000,
    description: (
      <a href={url} className="font-medium text-primary underline underline-offset-4 break-all">
        {t('task.viewCreatedTask')} {task.taskKey}
      </a>
    ),
    action: {
      label: t('task.copyLink'),
      onClick: event => {
        // Keep the task link available after copying instead of dismissing it.
        event.preventDefault();
        void copyText(url).then(ok => {
          if (ok) toast.success(t('task.linkCopied'));
          else copyFailed();
        }).catch(copyFailed);
      },
    },
  });
}
