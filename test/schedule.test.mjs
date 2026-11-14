// node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClock, nextAt, nextDue, repeatText, whenText, untilText, afterDismiss, reringSlot, parseDuration, WEEKDAYS } from "../mods/time/schedule.js";

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

test("parseClock reads 24h and am/pm times", () => {
  assert.deepEqual(parseClock("15:00"), { h: 15, m: 0 });
  assert.deepEqual(parseClock("9:05"), { h: 9, m: 5 });
  assert.deepEqual(parseClock("0930"), { h: 9, m: 30 });
  assert.deepEqual(parseClock("9"), { h: 9, m: 0 });
  assert.deepEqual(parseClock("3pm"), { h: 15, m: 0 });
  assert.deepEqual(parseClock("3:30 PM"), { h: 15, m: 30 });
  assert.deepEqual(parseClock("12am"), { h: 0, m: 0 });
  assert.deepEqual(parseClock("12pm"), { h: 12, m: 0 });
  for (const bad of ["", "24:00", "9:60", "13pm", "0am", "noon", "25m"]) assert.equal(parseClock(bad), null, bad);
});

test("nextAt: later today, else tomorrow, never now", () => {
  const now = at(2026, 11, 13, 14, 0);
  assert.equal(nextAt({ h: 15, m: 0 }, null, now), at(2026, 11, 13, 15, 0));
  assert.equal(nextAt({ h: 9, m: 0 }, null, now), at(2026, 11, 14, 9, 0));
  assert.equal(nextAt({ h: 14, m: 0 }, null, now), at(2026, 11, 14, 14, 0)); // exactly now: the next one
});

test("nextAt on weekdays skips the weekend", () => {
  const fri = at(2026, 11, 13, 10, 0); // Friday 13 Nov 2026
  assert.equal(new Date(fri).getDay(), 5);
  assert.equal(nextAt({ h: 9, m: 0 }, WEEKDAYS, fri), at(2026, 11, 16, 9, 0)); // Monday
  assert.equal(nextAt({ h: 11, m: 0 }, WEEKDAYS, fri), at(2026, 11, 13, 11, 0));
});

test("nextAt keeps the wall-clock time across a DST change", () => {
  // Whatever the local zone, consecutive days at 09:00 are 09:00 local.
  let t = at(2026, 3, 1, 12, 0);
  for (let i = 0; i < 70; i++) {
    t = nextAt({ h: 9, m: 0 }, null, t);
    const d = new Date(t);
    assert.equal(d.getHours(), 9); assert.equal(d.getMinutes(), 0);
  }
});

test("nextDue for an interval never drifts and skips missed slots", () => {
  const from = at(2026, 11, 13, 9, 0);
  const r = { every: 30 * 60000, from };
  assert.equal(nextDue(r, at(2026, 11, 13, 8, 0)), from);
  assert.equal(nextDue(r, from), at(2026, 11, 13, 9, 30));
  assert.equal(nextDue(r, at(2026, 11, 13, 9, 31)), at(2026, 11, 13, 10, 0));
  // Asleep for 5 hours: the next future slot, once.
  assert.equal(nextDue(r, at(2026, 11, 13, 14, 10)), at(2026, 11, 13, 14, 30));
});

test("afterDismiss reschedules a repeat and drops a one-off", () => {
  const now = at(2026, 11, 13, 9, 1);
  const daily = { id: "a", kind: "at", due: at(2026, 11, 13, 9, 0), rang: true, doneAt: 1, repeat: { at: { h: 9, m: 0 } } };
  assert.deepEqual(afterDismiss(daily, now), { ...daily, rang: false, doneAt: null, due: at(2026, 11, 14, 9, 0) });
  assert.equal(afterDismiss({ ...daily, repeat: null }, now), null);
  assert.equal(afterDismiss({ id: "b", kind: "down", ms: 1000 }, now), null);
});

test("repeatText, whenText, untilText", () => {
  assert.equal(repeatText(null), "");
  assert.equal(repeatText({ every: 1800000 }), "every 30m");
  assert.equal(repeatText({ at: { h: 9, m: 0 } }), "daily");
  assert.equal(repeatText({ at: { h: 9, m: 0 }, days: WEEKDAYS }), "weekdays");
  assert.equal(repeatText({ at: { h: 9, m: 0 }, days: [3, 1] }), "Mon Wed");
  const now = at(2026, 11, 13, 14, 0);
  assert.equal(whenText(at(2026, 11, 13, 15, 0), now), "15:00");
  assert.equal(whenText(at(2026, 11, 14, 9, 0), now), "tomorrow 09:00");
  assert.equal(whenText(at(2026, 11, 16, 9, 0), now), "Mon 09:00");
  assert.equal(whenText(at(2026, 11, 30, 9, 0), now), "30 Nov 09:00");
  assert.equal(untilText(now + 45000, now), "in 45s");
  assert.equal(untilText(now + 125 * 60000, now), "in 2h 5m");
  assert.equal(untilText(now + 26 * 3600000, now), "in 1d 2h");
});

test("parseDuration still reads lengths", () => {
  assert.equal(parseDuration("25m"), 1500000);
  assert.equal(parseDuration("1h30m"), 5400000);
  assert.equal(parseDuration("15:00"), null);
});

test("a repeat dismissed just before its next slot waits a full interval", () => {
  const from = at(2026, 11, 13, 9, 0), every = 25 * 60000;
  const r = { every, from };
  // Slots 9:00, 9:25, 9:50. Done at 9:24:59 would ring at 9:25:00; skip it.
  assert.equal(nextDue(r, at(2026, 11, 13, 9, 24) + 59000), at(2026, 11, 13, 9, 50));
  // Exactly half an interval away still counts.
  assert.equal(nextDue(r, at(2026, 11, 13, 9, 25) - every / 2), at(2026, 11, 13, 9, 25));
  assert.equal(nextDue(r, at(2026, 11, 13, 9, 12)), at(2026, 11, 13, 9, 25));
});

test("reringSlot: a ringing repeat rings again when its next slot passes", () => {
  const due = at(2026, 11, 13, 9, 0);
  const x = { kind: "at", rang: true, due, doneAt: due, repeat: { every: 30 * 60000, from: due } };
  assert.equal(reringSlot(x, at(2026, 11, 13, 9, 29)), null);
  assert.equal(reringSlot(x, at(2026, 11, 13, 9, 30)), at(2026, 11, 13, 9, 30));
  // Missed several: the latest passed slot, once.
  assert.equal(reringSlot(x, at(2026, 11, 13, 11, 10)), at(2026, 11, 13, 11, 0));
  assert.equal(reringSlot({ ...x, rang: false }, at(2026, 11, 13, 12, 0)), null);
  assert.equal(reringSlot({ ...x, repeat: null }, at(2026, 11, 13, 12, 0)), null);
  const daily = { kind: "at", rang: true, due, doneAt: due, repeat: { at: { h: 9, m: 0 } } };
  assert.equal(reringSlot(daily, at(2026, 11, 14, 8, 59)), null);
  assert.equal(reringSlot(daily, at(2026, 11, 14, 9, 0)), at(2026, 11, 14, 9, 0));
});

test("whenText names past days", () => {
  const now = at(2026, 11, 13, 14, 0);
  assert.equal(whenText(at(2026, 11, 13, 9, 0), now), "09:00");
  assert.equal(whenText(at(2026, 11, 12, 23, 30), now), "yesterday 23:30");
  assert.equal(whenText(at(2026, 11, 11, 9, 0), now), "Wed 09:00");
  assert.equal(whenText(at(2026, 11, 1, 9, 0), now), "1 Nov 09:00");
});
