export type NotificationImageKind =
  | "attendance_absent"
  | "quiz_result"
  | "fee_upcoming"
  | "fee_overdue"
  | "fee_reminder"
  | "monthly_report"
  | "announcement";

export type NotificationImagePayload = Record<string, unknown> & {
  kind: NotificationImageKind;
  academyName: string;
  studentName?: string;
  className: string;
  classCode: string;
  announcementTitle?: string;
  announcementMessage?: string;
};

export function cleanNotificationText(value: unknown, max?: number): string;
export function escapeSvgText(value: unknown): string;
export function validateNotificationImagePayload(payload: unknown): {
  valid: boolean;
  kind?: NotificationImageKind;
  error?: string;
};
export function buildNotificationSvg(payload: NotificationImagePayload, logoDataUri: string, avatars?: { teacher?: string; student?: string }): string;

export function formatNotificationDate(value: unknown): string;
