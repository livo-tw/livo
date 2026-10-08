import type { FeatureName } from '@/lib/license';

interface UpgradePromptProps {
  feature: FeatureName;
  /** Optional: show as inline banner instead of full-page block */
  inline?: boolean;
}

// Open-source edition: every feature is available, so there is never
// anything to upgrade. Kept as a no-op so existing call sites compile.
const UpgradePrompt = (_props: UpgradePromptProps): null => null;

export default UpgradePrompt;
