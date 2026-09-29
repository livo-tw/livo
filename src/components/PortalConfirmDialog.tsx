import { useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface ConfirmOptions {
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export function usePortalConfirmDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({ description: '' });
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions | string): Promise<boolean> => {
    const parsed = typeof opts === 'string' ? { description: opts } : opts;
    setOptions(parsed);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    setOpen(false);
    resolveRef.current?.(true);
    resolveRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    setOpen(false);
    resolveRef.current?.(false);
    resolveRef.current = null;
  }, []);

  const ConfirmDialog = open
    ? createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 animate-in fade-in duration-150"
          onClick={handleCancel}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-card rounded-xl shadow-xl border border-border p-5 w-full max-w-sm mx-4 animate-in fade-in zoom-in-95 duration-150"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-foreground mb-2">
              {options.title || t('confirm.defaultTitle')}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">{options.description}</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={handleCancel}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {options.cancelLabel || t('common.cancel')}
              </button>
              <button
                onClick={handleConfirm}
                className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                  options.destructive
                    ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                }`}
              >
                {options.confirmLabel || t('common.confirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return { confirm, ConfirmDialog };
}
