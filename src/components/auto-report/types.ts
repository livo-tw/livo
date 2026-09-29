export interface ReportConfig {
  id?: string;
  reportType: 'daily' | 'weekly';
  enabled: boolean;
  hour: number;
  minute: number;
  weekday: number;
  templateKey: 'default_daily' | 'default_weekly' | 'custom';
  customTemplate: string;
  scope: 'assigned_to_me' | 'my_projects' | 'specific_projects';
  scopeProjectIds: string[];
  sendTarget: 'dm' | 'channel';
  sendChannel: string;
}
