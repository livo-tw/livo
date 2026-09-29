export interface SlackSettings {
  enabled: boolean;
  webhookUrl: string;
  channel: string;
  events: string[];
}

export interface WebhookSettings {
  enabled: boolean;
  url: string;
  secret: string;
  events: string[];
}

export interface EmailSettings {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  fromName: string;
  fromEmail: string;
  events: string[];
}

export interface GitLabSettings {
  enabled: boolean;
  url: string;
  accessToken: string;
  projectId: string;
}

export interface CalendarSettings {
  enabled: boolean;
  provider: 'google' | 'ical';
  calendarId: string;
  syncDueDates: boolean;
  syncStartDates: boolean;
}
