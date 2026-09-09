/**
 * The names of every tool an office agent can be given (0130). Pure, so the
 * roster test can check that no agent is promised a tool that does not
 * exist. The implementations live in `tools.ts` (server-only).
 */
export const OFFICE_TOOL_NAMES = [
  "get_brand_profile",
  "get_brand_references",
  "list_recent_posts",
  "get_content_calendar",
  "list_social_accounts",
  "get_carousel_draft",
  "create_carousel_draft",
  "queue_post",
  // 0131 — the generalists' tools.
  "fetch_website",
  "lookup_client",
  "prepare_message",
] as const;

export type OfficeToolName = (typeof OFFICE_TOOL_NAMES)[number];

export function isOfficeToolName(name: string): name is OfficeToolName {
  return (OFFICE_TOOL_NAMES as readonly string[]).includes(name);
}
