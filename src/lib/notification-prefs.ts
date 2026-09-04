import type { NotificationChannelPrefs } from "@/lib/database.types";

/**
 * The shape of one person's notification settings, client-side.
 *
 * Lives here rather than beside its server action because a `"use server"`
 * module may only export async functions — a plain const there breaks the
 * Turbopack build. The form and the action both import it from here, so the
 * defaults can't drift apart.
 */
export type NotificationPrefsInput = {
  channels: NotificationChannelPrefs;
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  timezone: string;
  digestDaily: boolean;
  digestWeekly: boolean;
  mutedLinks: string[];
};

/**
 * What an unsaved row behaves like — and it must behave EXACTLY like no row
 * at all, or saving the form once would silently change what reaches you.
 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefsInput = {
  channels: {},
  quietHoursEnabled: false,
  quietHoursStart: 21,
  quietHoursEnd: 8,
  timezone: "Asia/Colombo",
  digestDaily: false,
  digestWeekly: false,
  mutedLinks: [],
};
