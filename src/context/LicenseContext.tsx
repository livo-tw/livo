import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { type LicenseTier, type LicenseInfo, type FeatureName } from '@/lib/license';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { LICENSE_NOT_REQUIRED, editionText } from '@/lib/edition';

// Open-source edition: there are no license keys and every feature is
// available. The context keeps the same shape as before so every consumer
// (hasFeature gates, integration cards) works unchanged.

interface LicenseContextType {
  license: LicenseInfo;
  tier: LicenseTier;
  hasFeature: (feature: FeatureName) => boolean;
  isLoading: boolean;
  /** True only in the ?demo=pro in-memory preview, where integrations are read-only. */
  isDemoMode: boolean;
  refreshLicense: () => Promise<void>;
  saveLicenseKey: (key: string) => Promise<{ ok: boolean; message: string }>;
  resetLicense: (resetCode: string) => Promise<{ ok: boolean; message: string }>;
}

const LicenseContext = createContext<LicenseContextType | null>(null);

export const useLicense = () => {
  const ctx = useContext(LicenseContext);
  if (!ctx) throw new Error('useLicense must be used within LicenseProvider');
  return ctx;
};

const OPEN_SOURCE_LICENSE: LicenseInfo = {
  tier: 'professional',
  email: null,
  expiresAt: null,
  isExpired: false,
  isValid: true,
  raw: null,
  installationId: null,
  installationBound: false,
};

export const LicenseProvider = ({ children }: { children: ReactNode }) => {
  const hasFeature = useCallback((_feature: FeatureName) => true, []);
  const refreshLicense = useCallback(async () => {}, []);
  const notRequired = useCallback(
    async () => ({ ok: false, message: editionText(LICENSE_NOT_REQUIRED) }),
    []
  );

  return (
    <LicenseContext.Provider value={{
      license: OPEN_SOURCE_LICENSE,
      tier: 'professional',
      hasFeature,
      isLoading: false,
      isDemoMode: IS_DEMO_PRO,
      refreshLicense,
      saveLicenseKey: notRequired,
      resetLicense: notRequired,
    }}>
      {children}
    </LicenseContext.Provider>
  );
};
