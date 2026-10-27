import { createContext, useContext, useId, useLayoutEffect } from 'react';

export const QaDetailDraftContext = createContext<((id: string, dirty: boolean) => void) | null>(null);

// Each mounted editor owns one draft marker; removing a panel removes only its marker.
export function useQaDetailDraft(dirty: boolean) {
  const report = useContext(QaDetailDraftContext);
  const id = useId();
  useLayoutEffect(() => { report?.(id, dirty); return () => report?.(id, false); }, [report, id, dirty]);
}
