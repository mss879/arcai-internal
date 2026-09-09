/**
 * Client-safe types for the Content Office (0130).
 *
 * No `server-only` import anywhere in this file: the floor, the hover cards
 * and the pure simulation all import from here, and so does the server-side
 * snapshot loader.
 */

import type {
  Database,
  OfficeAgentKey,
  OfficeEffort,
  SocialPlatform,
} from "@/lib/database.types";

type Tables = Database["public"]["Tables"];

export type OfficeAgentRow = Tables["office_agents"]["Row"];
export type OfficeMissionRow = Tables["office_missions"]["Row"];
export type OfficeTaskRow = Tables["office_tasks"]["Row"];
export type OfficeEventRow = Tables["office_events"]["Row"];
export type OfficeScheduleRow = Tables["office_schedules"]["Row"];
export type OfficeBrandProfileRow = Tables["office_brand_profiles"]["Row"];

/** Where on the floor an agent sits or goes. */
export type OfficeZoneKey =
  | "managerOffice"
  | "library"
  | "strategyTable"
  | "writingDesk"
  | "designStudio"
  | "brandCorner"
  | "qaDesk"
  | "dispatchDesk"
  | "opsStudio"
  | "meetingRoom"
  | "reception"
  | "breakout"
  | "corridor";

/** What a robot is visibly doing. */
export type RobotState =
  | "idle"
  | "walking"
  | "working"
  | "thinking"
  | "searching"
  | "talking"
  | "blocked"
  | "done";

/** The roster entry as the UI sees it: code defaults merged with the row. */
export type OfficeAgentView = {
  key: OfficeAgentKey;
  name: string;
  title: string;
  description: string;
  color: string;
  /** The model the next call will try first. */
  model: string;
  /** The full fallback chain, first is `model`. */
  chain: string[];
  effort: OfficeEffort;
  enabled: boolean;
  zone: OfficeZoneKey;
  /** Which seat in the zone is theirs (two generalists share a studio). */
  seat: number;
  instructions: string;
  tools: string[];
  webSearch: boolean;
  /** True when the row (not the code) chose the model. */
  overridden: boolean;
};

/** A carousel the office drafted, as the drawer shows it. */
export type OfficeCarouselLite = {
  id: string;
  mission_id: string | null;
  office_task_id: string | null;
  topic: string;
  status: string;
  scheduled_for: string;
  caption: string;
  hashtags: string[];
  rendered: number;
  total: number;
  chosen_option_id: string | null;
  client_status: string;
};

export type OfficeSocialAccountLite = {
  id: string;
  platform: SocialPlatform;
  name: string;
  clientId: string | null;
};

export type OfficeSpend = {
  todayUsd: number;
  monthUsd: number;
  capUsd: number;
};

/** Everything the Office view needs, in one object. */
export type OfficeSnapshot = {
  /** False when 0130 is not applied yet: the floor renders, nothing runs. */
  ready: boolean;
  isAdmin: boolean;
  agents: OfficeAgentView[];
  missions: OfficeMissionRow[];
  tasks: OfficeTaskRow[];
  events: OfficeEventRow[];
  schedules: OfficeScheduleRow[];
  brandProfiles: OfficeBrandProfileRow[];
  carousels: OfficeCarouselLite[];
  spend: OfficeSpend;
  social: {
    accounts: OfficeSocialAccountLite[];
    dryRun: boolean;
    tokenKeySet: boolean;
  };
  clients: { id: string; name: string }[];
  /** For the delta poll: events newer than this are fetched next time. */
  lastEventId: number;
  loadedAt: string;
};

/** What `driveOffice` returns: only what changed. */
export type OfficeDelta = {
  tasks: OfficeTaskRow[];
  missions: OfficeMissionRow[];
  events: OfficeEventRow[];
  carousels: OfficeCarouselLite[];
  spend: OfficeSpend;
  lastEventId: number;
  stepped: { polled: number; started: number; advanced: number; failed: number; busy: number };
};
