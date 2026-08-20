/**
 * Ephemeral admin↔member pop-up messages ("pings").
 *
 * Pings ride Supabase Realtime BROADCAST on private channels — they are
 * never stored anywhere. Each user has one channel, `ping:<userId>`:
 * admins send a "ping" into a member's channel and stay subscribed for the
 * "reply"; the member's global listener pops the message up and sends the
 * reply back on the same channel. Channel access is enforced by the
 * realtime.messages policies in migration 0082.
 */

export const PING_EVENT = "ping";
export const REPLY_EVENT = "reply";

/** How recently a member must have been active to count as online. */
export const ONLINE_WINDOW_MS = 5 * 60_000;

export function pingTopic(userId: string) {
  return `ping:${userId}`;
}

export type PingPayload = {
  id: string;
  from: string;
  text: string;
};
