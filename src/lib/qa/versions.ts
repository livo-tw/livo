/** Suggestions are product builds recorded by QA, never the issue's CAS version. */
export interface QaVersionSource {
  workspaceId: string;
  projectId: string;
  observedVersion?: unknown;
  targets?: unknown;
  runs?: unknown;
}

export function qaVersionSuggestions(sources: Iterable<QaVersionSource>, workspaceId: string, projectId: string): string[] {
  const versions = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text && text.length <= 200 && !text.includes('\0')) versions.add(text);
  };
  for (const source of sources) {
    if (source.workspaceId !== workspaceId || source.projectId !== projectId) continue;
    add(source.observedVersion);
    for (const entries of [source.targets, source.runs]) {
      if (Array.isArray(entries)) for (const entry of entries) {
        if (entry && typeof entry === 'object') add((entry as { build?: unknown }).build);
      }
    }
  }
  return [...versions].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}
