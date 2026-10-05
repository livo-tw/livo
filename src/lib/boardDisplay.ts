import { DEFAULT_CARD_FIELDS, type CardFieldVisibility } from '@/lib/fieldRegistry';

/** What a task card shows on the board: kept in this browser, like the board sort. */
export interface BoardDisplay {
  cardFields: CardFieldVisibility;
  subtaskMode: 'independent' | 'nested';
  customCardFields: Record<string, boolean>;
}

const KEY = 'livo.boardDisplay';
const booleans = (value: unknown): Record<string, boolean> =>
  value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, on]) => typeof on === 'boolean')) as Record<string, boolean> : {};

/** Unknown or damaged values fall back to the defaults; private windows simply start fresh. */
export function readBoardDisplay(): BoardDisplay {
  let stored: Partial<Record<keyof BoardDisplay, unknown>> = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') ?? {}; } catch { /* defaults */ }
  const cardFields = { ...DEFAULT_CARD_FIELDS };
  for (const [field, on] of Object.entries(booleans(stored.cardFields))) if (field in cardFields) (cardFields as unknown as Record<string, boolean>)[field] = on;
  return { cardFields, subtaskMode: stored.subtaskMode === 'nested' ? 'nested' : 'independent', customCardFields: booleans(stored.customCardFields) };
}

export function writeBoardDisplay(display: BoardDisplay) {
  try { localStorage.setItem(KEY, JSON.stringify(display)); } catch { /* the choice still applies until reload */ }
}
