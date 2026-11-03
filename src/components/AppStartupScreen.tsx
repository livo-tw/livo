import i18n from '@/i18n';

interface AppStartupScreenProps {
  memberVerified: boolean;
  isLoading: boolean;
  loadFailed: boolean;
  onRetry: () => void;
}

// Keep unknown application data behind an explicit loading/error state.
export function AppStartupScreen({ memberVerified, isLoading, loadFailed, onRetry }: AppStartupScreenProps) {
  if (loadFailed) {
    return (
      <div className="min-h-screen flex flex-col gap-4 items-center justify-center bg-background" role="alert">
        <span className="text-muted-foreground">{i18n.t('common.loadFailed')}</span>
        <button type="button" onClick={onRetry} className="rounded-md border border-border px-4 py-2 hover:bg-accent">
          {i18n.t('common.retry')}
        </button>
      </div>
    );
  }
  if (!memberVerified || isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-background" role="status">
      <span className="text-muted-foreground">{i18n.t(memberVerified ? 'common.loading' : 'common.verifyingIdentity')}</span>
    </div>;
  }
  return null;
}
