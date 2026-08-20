// Duration parsing/formatting and small shared helpers.

const UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  mo: 2592000, // 30 days
  y: 31536000,
};

const PERMANENT_WORDS = new Set(["perm", "permanent", "forever", "0", "none"]);

/**
 * Parse a human duration like "30m", "2h", "7d", "1d12h", "1w", "permanent".
 * Returns seconds as a number, or null for permanent.
 * Throws on input it can't understand.
 */
export function parseDuration(input) {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim().toLowerCase();
  if (raw === "" || PERMANENT_WORDS.has(raw)) return null;

  // Bare number = seconds.
  if (/^\d+$/.test(raw)) return Number(raw);

  const re = /(\d+)\s*(mo|s|m|h|d|w|y)/g;
  let total = 0;
  let matchedLength = 0;
  let match;
  while ((match = re.exec(raw)) !== null) {
    total += Number(match[1]) * UNIT_SECONDS[match[2]];
    matchedLength += match[0].length;
  }
  // Reject if there was junk we didn't understand (e.g. "5x", "abc").
  if (total === 0 || matchedLength !== raw.replace(/\s+/g, "").length) {
    throw new Error(
      `Couldn't understand duration "${input}". Use things like 30m, 2h, 7d, 1w, 1d12h, or "permanent".`
    );
  }
  return total;
}

/** "7d" → "7 days", 5400 → "1 hour 30 minutes", null → "Permanent" */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "Permanent";
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const parts = [];
  let remaining = Math.floor(seconds);
  for (const [name, size] of units) {
    if (remaining >= size) {
      const count = Math.floor(remaining / size);
      remaining -= count * size;
      parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
      if (parts.length === 2) break; // two units is plenty for humans
    }
  }
  return parts.length ? parts.join(" ") : "0 seconds";
}

export function nowIso() {
  return new Date().toISOString();
}

export function isoPlusSeconds(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Truncate a string for APIs with character limits. */
export function clamp(text, max) {
  if (!text) return text;
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

export const ACTION_LABELS = {
  ban: "Ban",
  unban: "Unban",
  kick: "Kick",
  warn: "Warning",
  note: "Note",
  dungeon: "Dungeon",
  release: "Release",
};
