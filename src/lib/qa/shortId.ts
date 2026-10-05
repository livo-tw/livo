/** How a bug is referred to everywhere in the app: the last eight characters of its id. */
export const qaShortId = (id: string): string => `#${id.slice(-8)}`;
