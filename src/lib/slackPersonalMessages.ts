/** Personal Slack message settings in system_settings.slack_delivery (self-host). */
export type SlackDeliverySetting = { enabled?: boolean; dmEnabled?: boolean; dmMemberIds?: unknown; [key: string]: unknown };

/** What the form shows for a stored setting. No dmMemberIds key means every bound member. */
export function personalMessageSettings(config: SlackDeliverySetting | null) {
  const listed = !!config && Object.prototype.hasOwnProperty.call(config, 'dmMemberIds');
  const ids = listed && Array.isArray(config!.dmMemberIds) ? config!.dmMemberIds.filter((id): id is string => typeof id === 'string') : [];
  return { enabled: config?.dmEnabled === true, onlyListed: listed, memberIds: [...new Set(ids)].sort() };
}

/** The stored setting for the form, keeping every other key (routes, weekly, team). */
export function withPersonalMessages(current: SlackDeliverySetting, enabled: boolean, onlyListed: boolean, memberIds: string[]): SlackDeliverySetting {
  const next: SlackDeliverySetting = { ...current, dmEnabled: enabled };
  if (onlyListed) next.dmMemberIds = [...new Set(memberIds)].sort();
  else delete next.dmMemberIds;
  return next;
}
