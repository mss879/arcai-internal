import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names, resolving conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a number as currency (defaults to USD). */
export function formatCurrency(
  amount: number | null | undefined,
  currency = "USD",
) {
  const value = typeof amount === "number" ? amount : 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Compact currency, e.g. $25.1K */
export function formatCompactCurrency(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(amount);
}

/** Initials from a full name, e.g. "Yana Summer" -> "YS". */
export function getInitials(name: string | null | undefined) {
  if (!name) return "?";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** A deterministic pleasant color derived from a string (for avatars). */
export function colorFromString(input: string) {
  const palette = [
    "#6d5cff",
    "#ff7a59",
    "#16c79a",
    "#ffb020",
    "#ff5c8a",
    "#22b8cf",
    "#845ef7",
    "#51cf66",
  ];
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = input.charCodeAt(i) + ((hash << 5) - hash);
  }
  return palette[Math.abs(hash) % palette.length];
}

/** kebab/dot slug from arbitrary text. */
export function slugify(input: string, separator = "-") {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${separator}{2,}`, "g"), separator)
    .replace(new RegExp(`^${separator}|${separator}$`, "g"), "");
}

/** Build a username handle from a full name, e.g. "John Doe" -> "john.doe". */
export function usernameFromName(name: string) {
  const base = slugify(name, ".");
  return base || "user";
}

/** Cryptographically-strong, human-typable password. */
export function generatePassword(length = 14) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*";
  const all = upper + lower + digits + symbols;

  const pick = (set: string) => set[Math.floor(Math.random() * set.length)];

  // Guarantee one of each class, then fill the rest.
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  for (let i = chars.length; i < length; i++) chars.push(pick(all));

  // Fisher–Yates shuffle.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Human-readable file size, e.g. 1.4 MB. */
export function formatBytes(bytes: number | null | undefined) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Generate bookable time slots between two hours. */
export function generateTimeSlots(
  startHour: number,
  endHour: number,
  durationMin = 60,
) {
  const slots: { start: string; end: string }[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  const toStr = (mins: number) =>
    `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
  let mins = startHour * 60;
  const end = endHour * 60;
  while (mins + durationMin <= end) {
    slots.push({ start: toStr(mins), end: toStr(mins + durationMin) });
    mins += durationMin;
  }
  return slots;
}

/** "09:00" -> "9:00 AM" */
export function formatTime12(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${period}`;
}

/** Extract @mentions (usernames) from a block of text. */
export function extractMentions(text: string): string[] {
  const matches = text.match(/@([a-z0-9._-]+)/gi) ?? [];
  return Array.from(
    new Set(matches.map((m) => m.slice(1).toLowerCase())),
  );
}
