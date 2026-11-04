import { useState } from 'react';
import type { CommentOrder } from '@/lib/commentOrdering';

function readOrder(key: string | null): CommentOrder {
  try {
    if (key && localStorage.getItem(key) === 'oldest') return 'oldest';
  } catch { /* The current card can still change the order without storage. */ }
  return 'newest';
}

export function useCommentOrder(memberId: string | null | undefined) {
  const key = memberId ? `livo_comment_order:v1:${memberId}` : null;
  const [selection, setSelection] = useState<{ key: string | null; order: CommentOrder }>();
  const order = selection?.key === key ? selection.order : readOrder(key);

  const setOrder = (next: CommentOrder) => {
    setSelection({ key, order: next });
    try {
      if (key) localStorage.setItem(key, next);
    } catch { /* Keep the current card's selection. */ }
  };

  return [order, setOrder] as const;
}
