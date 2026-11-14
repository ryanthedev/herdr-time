// Pure time logic for the time mod: formatting, parsing lengths and clock
// times, and when a reminder rings next. No herdr imports, so `node --test`
// can load it (test/schedule.test.mjs).

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const DAY_MS = 86400000;
export const pad = (n, w = 2) => String(n).padStart(w, "0");

const dayOfYear = (d) => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(d.getFullYear(), 0, 1)) / DAY_MS) + 1;
// ISO 8601 week: the week holding this date's Thursday, counted from the year's first Thursday.
const isoWeek = (d) => {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round(((t - jan4) / DAY_MS - 3 + ((jan4.getDay() + 6) % 7)) / 7);
};
const offset = (d) => {
  const m = -d.getTimezoneOffset(), a = Math.abs(m);
  return `${m < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
};

// Formatted by hand: the runtime is ES2022 with no promise of Intl/toLocale*.
// Each token returns [padded, unpadded]; `%-x` picks the unpadded one.
const TOKENS = {
  a: (d) => DAYS[d.getDay()].slice(0, 3),          // Wed
  A: (d) => DAYS[d.getDay()],                      // Wednesday
  b: (d) => MONTHS[d.getMonth()].slice(0, 3),      // Nov
  B: (d) => MONTHS[d.getMonth()],                  // November
  d: (d) => [pad(d.getDate()), d.getDate()],       // 11 (day of month)
  e: (d) => String(d.getDate()).padStart(2, " "),  // day of month, space-padded
  m: (d) => [pad(d.getMonth() + 1), d.getMonth() + 1], // 11 (month)
  y: (d) => pad(d.getFullYear() % 100),            // 26
  Y: (d) => d.getFullYear(),                       // 2026
  H: (d) => [pad(d.getHours()), d.getHours()],     // 00-23
  I: (d) => [pad(d.getHours() % 12 || 12), d.getHours() % 12 || 12], // 01-12
  p: (d) => (d.getHours() < 12 ? "AM" : "PM"),
  M: (d) => pad(d.getMinutes()),
  S: (d) => pad(d.getSeconds()),
  s: (d) => Math.floor(d.getTime() / 1000),        // Unix seconds
  j: (d) => [pad(dayOfYear(d), 3), dayOfYear(d)],  // day of year
  V: (d) => [pad(isoWeek(d)), isoWeek(d)],         // ISO week
  u: (d) => d.getDay() || 7,                       // 1 (Mon) - 7 (Sun)
  w: (d) => d.getDay(),                            // 0 (Sun) - 6 (Sat)
  z: (d) => offset(d),                             // +0100
  "%": () => "%",
};

export function strftime(fmt, d) {
  return fmt.replace(/%(-?)([a-zA-Z%])/g, (all, bare, k) => {
    const f = TOKENS[k];
    if (!f) return all;
    const v = f(d);
    return String(Array.isArray(v) ? v[bare ? 1 : 0] : v);
  });
}

// Splits the rendered text into pieces: { sep } for `|`, { text, bright }.
export function pieces(text) {
  const out = [];
  for (const part of text.split("|")) {
    if (out.length) out.push({ sep: true });
    for (const m of part.trim().matchAll(/\[([^\]]*)\]|[^[]+/g)) {
      const t = (m[1] ?? m[0]).trim();
      if (t) out.push({ text: t, bright: m[1] !== undefined });
    }
  }
  return out;
}

// 4:05, 1:02:03; countdowns round up so 0:00 only shows when it is done.
export function clockOf(ms, up = true) {
  const s = up ? Math.floor(ms / 1000) : Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// 25m, 90s, 1h30m.
export function lengthOf(ms) {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h && `${h}h`, m && `${m}m`, sec && `${sec}s`].filter(Boolean).join("") || "0s";
}

// "25m", "90s", "1h30m", "1.5h"; a bare number is minutes.
export function parseDuration(text) {
  const s = String(text ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60000) || null;
  const re = /(\d+(?:\.\d+)?)([hms])/g;
  let total = 0, used = 0, m;
  while ((m = re.exec(s))) { total += Number(m[1]) * { h: 3600000, m: 60000, s: 1000 }[m[2]]; used += m[0].length; }
  return used === s.length && total > 0 ? Math.round(total) : null;
}

// A time of day: "15:00", "9:30", "0930", "9", "3pm", "3:30 pm", "12am".
// Returns { h, m } (24-hour) or null.
export function parseClock(text) {
  const s = String(text ?? "").trim().toLowerCase().replace(/\s+/g, "").replace(/\./g, "");
  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "p" ? 12 : 0);
  } else if (h > 23) return null;
  return { h, m: min };
}
export const clockText = ({ h, m }) => `${pad(h)}:${pad(m)}`;

// The first moment strictly after `after` that is h:m local time on one of
// `days` (0 = Sunday). Built from local date parts, so a DST change moves the
// wall clock, not the reminder. Returns ms.
export function nextAt({ h, m }, days, after) {
  const allowed = days?.length ? days : EVERY_DAY;
  const d = new Date(after);
  for (let i = 0; i <= 8; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0);
    if (c.getTime() > after && allowed.includes(c.getDay())) return c.getTime();
  }
  return null;
}

// When a repeating reminder rings next, strictly after `after`:
// { every: ms, from: ms } rings at from + k*every (never drifts, and a long
// sleep skips the missed slots instead of ringing once per slot; a slot less
// than half an interval away is skipped too, so dismissing a 25m reminder at
// 24m59s waits a full 25m instead of ringing again a second later);
// { at: {h, m}, days } rings at that time of day on those days.
export function nextDue(repeat, after) {
  if (!repeat) return null;
  if (repeat.every > 0) {
    const from = Number(repeat.from) || after;
    if (from > after) return from;
    let slot = from + (Math.floor((after - from) / repeat.every) + 1) * repeat.every;
    if (slot - after < repeat.every / 2) slot += repeat.every;
    return slot;
  }
  if (repeat.at) return nextAt(repeat.at, repeat.days, after);
  return null;
}

const sameDays = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
// "every 30m", "daily", "weekdays", "Mon Wed", or "" for a one-off.
export function repeatText(repeat) {
  if (!repeat) return "";
  if (repeat.every > 0) return `every ${lengthOf(repeat.every)}`;
  const days = repeat.days?.length ? repeat.days : EVERY_DAY;
  if (sameDays(days, EVERY_DAY)) return "daily";
  if (sameDays(days, WEEKDAYS)) return "weekdays";
  if (sameDays(days, [0, 6])) return "weekends";
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAYS[d].slice(0, 3)).join(" ");
}

// When something is due or rang, said briefly from now: "15:00" today,
// "tomorrow 09:00" / "yesterday 09:00", "Mon 09:00" within a week either way,
// else "14 Nov 09:00".
export function whenText(due, now) {
  const d = new Date(due), n = new Date(now);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / DAY_MS);
  if (days === 0) return t;
  if (days === 1) return `tomorrow ${t}`;
  if (days === -1) return `yesterday ${t}`;
  if (Math.abs(days) < 7) return `${DAYS[d.getDay()].slice(0, 3)} ${t}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${t}`;
}

// "in 2h 5m", "in 45s".
export function untilText(due, now) {
  const s = Math.max(0, Math.ceil((due - now) / 1000));
  if (s < 60) return `in ${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return `in ${h}h${r ? ` ${r}m` : ""}`;
  const dd = Math.floor(h / 24), rh = h % 24;
  return `in ${dd}d${rh ? ` ${rh}h` : ""}`;
}

// What happens to a reminder when it is dismissed: a repeating one moves to
// its next time (still the same reminder), a one-off goes away (null).
export function afterDismiss(x, now) {
  if (x.kind === "at" && x.repeat) {
    const due = nextDue(x.repeat, now);
    if (due) return { ...x, rang: false, doneAt: null, due };
  }
  return null;
}

// A repeating reminder left ringing: the latest slot after the one that rang
// that has already passed (null if the next slot is still ahead, or this is not
// a ringing repeat). Several missed slots count once.
export function reringSlot(x, now) {
  if (x.kind !== "at" || !x.repeat || !x.rang) return null;
  let slot = nextDue(x.repeat, x.due);
  if (!slot || slot > now) return null;
  for (let next = nextDue(x.repeat, slot); next && next <= now; next = nextDue(x.repeat, slot)) slot = next;
  return slot;
}

// The latest slot of a repeat at or after `slot` that has already passed.
const latestPassed = (repeat, slot, now) => {
  for (let next = nextDue(repeat, slot); next && next <= now; next = nextDue(repeat, slot)) slot = next;
  return slot;
};

// One tick for reminders (kind "at"): the ones whose time came ring, and a
// repeating one left ringing rings again when its next slot passes. A repeat
// that comes due late (Herdr closed, laptop asleep) rings once, stamped with
// the latest slot that passed, so the next tick doesn't ring it again.
// Returns { list, fired } with the changed items in `fired`.
export function ringReminders(list, now) {
  const fired = [];
  const next = list.map((x) => {
    if (x.kind !== "at") return x;
    let slot = null;
    if (x.rang) slot = reringSlot(x, now);
    else if (x.due <= now) slot = x.repeat ? latestPassed(x.repeat, x.due, now) : x.due;
    if (slot === null) return x;
    const y = { ...x, rang: true, due: slot, doneAt: slot };
    fired.push(y);
    return y;
  });
  return { list: fired.length ? next : list, fired };
}

const findLook = (n) => (n?.content?.pane?.focus ? n : (n?.children ?? []).map(findLook).find(Boolean));

// The pane focus border while something rings. Edits a layout tree in place:
// on = true turns the focus colour `red` and returns what to remember (the
// colour it replaced); on = false puts `saved` back, but only if the border is
// still our red (a colour someone changed meanwhile is theirs). Returns
// { changed, saved }: `saved` is what to keep in storage (null: nothing).
export function focusBorder(tree, on, saved, red) {
  const focus = findLook(tree)?.content.pane.focus;
  if (!focus) return { changed: false, saved: on ? saved : null };
  if (on) {
    if (focus.color === red) return { changed: false, saved };
    const keep = saved ?? { color: focus.color ?? null };
    focus.color = red;
    return { changed: true, saved: keep };
  }
  if (focus.color !== red || !saved) return { changed: false, saved: null };
  if (saved.color === null) delete focus.color; else focus.color = saved.color;
  return { changed: true, saved: null };
}
