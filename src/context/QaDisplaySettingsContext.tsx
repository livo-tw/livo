import { createContext, useContext } from 'react';
import { defaultQaDisplaySettings, type QaDisplaySettings } from '@/lib/qa/displaySettings';

// Standalone cards retain the public default. Data-backed QA surfaces supply the
// current workspace configuration, including null while its read is unknown.
export const QaDisplaySettingsContext = createContext<QaDisplaySettings | null>(defaultQaDisplaySettings());
export const useQaDisplayConfiguration = () => useContext(QaDisplaySettingsContext);
