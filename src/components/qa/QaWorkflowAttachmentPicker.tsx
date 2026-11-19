import { CommentAttachmentPicker } from '@/components/comments/CommentAttachmentPicker';
import { qaUploadFileTypes } from '@/lib/qa/client';
import { QA_MAX_COMMENT_ATTACHMENTS } from '@/lib/qa/domain';
import type { useQaDraftFiles } from './QaDraftAttachments';

export type QaWorkflowAttachmentDraft = ReturnType<typeof useQaDraftFiles>;

export default function QaWorkflowAttachmentPicker({ draft, busy }: { draft: QaWorkflowAttachmentDraft; busy: boolean }) {
  return <CommentAttachmentPicker files={draft.files} rejected={draft.rejected} busy={busy}
    maxFiles={QA_MAX_COMMENT_ATTACHMENTS} accept={Object.keys(qaUploadFileTypes()).join(',')}
    onFiles={draft.add} onRemove={draft.remove} />;
}
