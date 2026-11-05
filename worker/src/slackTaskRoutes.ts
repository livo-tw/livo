/** The same task-notification audience policy is used for delivery and unfurls. */
type Row = Record<string, any>;
export function matchingChannels(config: Row | undefined, project: Row | undefined): string[] {
  if (!project || project.is_archived) return [];
  const routes = Array.isArray(config?.routes) ? config.routes : [];
  return [...new Set<string>(routes.filter((r: Row) => r && r.enabled !== false && /^[CG][A-Z0-9]+$/.test(r.channelId || '') &&
    ((r.projectId && r.projectId === project.id) || (r.lineId && r.lineId === project.line_id)))
    .map((r: Row) => r.channelId))];
}
