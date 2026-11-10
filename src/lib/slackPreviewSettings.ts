export type SlackPreviewMode = 'project_routes' | 'internal_channels';
export type SlackPreviewSetting = { previewMode?: SlackPreviewMode; [key: string]: unknown };

/** Missing is the existing policy. Unknown values must never broaden access. */
export function readSlackPreviewMode(value: unknown): SlackPreviewMode {
  if (value === undefined || value === 'project_routes') return 'project_routes';
  if (value === 'internal_channels') return value;
  throw new Error('invalid_slack_preview_mode');
}
export function withSlackPreviewMode(current: Record<string, unknown>, value: unknown): SlackPreviewSetting {
  if (value !== 'project_routes' && value !== 'internal_channels') throw new Error('invalid_slack_preview_mode');
  return { ...current, previewMode: value };
}
