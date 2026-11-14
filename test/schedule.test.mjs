// node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClock, nextAt, nextDue, repeatText, whenText, untilText, afterDismiss, reringSlot, ringReminders, focusBorder, setHidden, lookMap, layoutLook, parseDuration, WEEKDAYS } from "../mods/time/schedule.js";

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

test("a repeat that came due while asleep rings once, not twice", () => {
  const due = at(2026, 11, 13, 9, 0);
  const x = { id: "r", kind: "at", rang: false, due, doneAt: null, repeat: { every: 30 * 60000, from: due } };
  const now = at(2026, 11, 13, 14, 10);
  const one = ringReminders([x], now);
  assert.equal(one.fired.length, 1);
  assert.equal(one.list[0].due, at(2026, 11, 13, 14, 0));
  assert.equal(one.list[0].doneAt, at(2026, 11, 13, 14, 0));
  // The next tick, a second later, has nothing to ring.
  const two = ringReminders(one.list, now + 1000);
  assert.equal(two.fired.length, 0);
  assert.equal(two.list, one.list);
  // Until the next slot passes while it still rings.
  assert.equal(ringReminders(one.list, at(2026, 11, 13, 14, 30)).fired.length, 1);
  // Daily, closed over two days: once, on the latest slot.
  const d = { id: "d", kind: "at", rang: false, due, repeat: { at: { h: 9, m: 0 } } };
  const r = ringReminders([d], at(2026, 11, 15, 10, 0));
  assert.equal(r.fired.length, 1);
  assert.equal(r.list[0].due, at(2026, 11, 15, 9, 0));
  assert.equal(ringReminders(r.list, at(2026, 11, 15, 10, 0, 1)).fired.length, 0);
  // A one-off keeps its own time; other kinds are left alone.
  const o = ringReminders([{ id: "o", kind: "at", rang: false, due, repeat: null }, { id: "t", kind: "down" }], now);
  assert.equal(o.fired.length, 1);
  assert.equal(o.list[0].doneAt, due);
});

test("focusBorder turns the focus border red and puts it back", () => {
  const mk = (focus) => ({ id: "root", children: [{ id: "a" }, { id: "main", content: { pane: { border: { color: "x" }, focus } } }] });
  const t = mk({ width: 2, color: "#B0EFB5" });
  const on = focusBorder(t, true, null, "#f00");
  assert.deepEqual(on, { changed: true, saved: { color: "#B0EFB5" } });
  assert.equal(t.children[1].content.pane.focus.color, "#f00");
  // Ringing again changes nothing and keeps what was saved.
  assert.deepEqual(focusBorder(t, true, on.saved, "#f00"), { changed: false, saved: on.saved });
  const off = focusBorder(t, false, on.saved, "#f00");
  assert.deepEqual(off, { changed: true, saved: null });
  assert.deepEqual(t, mk({ width: 2, color: "#B0EFB5" }));
  // A border that had no colour gets it removed again.
  const bare = mk({ width: 2 });
  const s2 = focusBorder(bare, true, null, "#f00").saved;
  focusBorder(bare, false, s2, "#f00");
  assert.deepEqual(bare, mk({ width: 2 }));
  // A colour someone set meanwhile is left alone; nothing to restore with no saved colour.
  const moved = mk({ width: 2, color: "#00f" });
  assert.deepEqual(focusBorder(moved, false, { color: "#B0EFB5" }, "#f00"), { changed: false, saved: null });
  assert.equal(moved.children[1].content.pane.focus.color, "#00f");
  assert.deepEqual(focusBorder({ id: "r" }, true, null, "#f00"), { changed: false, saved: null });
});

test("setHidden shows and hides one block by id", () => {
  const t = { id: "r", children: [{ id: "a", children: [{ id: "ring", hidden: true }] }, { id: "b" }] };
  assert.equal(setHidden(t, "ring", false), true);
  assert.equal(t.children[0].children[0].hidden, undefined);
  assert.equal(setHidden(t, "ring", false), false);
  assert.equal(setHidden(t, "ring", true), true);
  assert.equal(t.children[0].children[0].hidden, true);
  assert.equal(setHidden(t, "nope", true), false);
});

const tree = (color) => ({ id: "root", children: [{ id: "main", content: { pane: { focus: color ? { width: 2, color } : { width: 2 } } } }] });
const focusOf = (t) => t.children[0].content.pane.focus.color;

test("layoutLook keeps one colour per layout and restores each when shown", () => {
  const a = tree("#aaa"), b = tree("#bbb");
  let r = layoutLook(null, "loops", a, true, "#f00");
  assert.deepEqual(r.looks, { loops: { color: "#aaa" } });
  assert.equal(focusOf(a), "#f00");
  // switch to the other layout while ringing: it goes red, loops' entry stays
  r = layoutLook(r.looks, "matrix", b, true, "#f00");
  assert.deepEqual(r.looks, { loops: { color: "#aaa" }, matrix: { color: "#bbb" } });
  // nothing rings: matrix is shown, so only matrix is restored
  r = layoutLook(r.looks, "matrix", b, false, "#f00");
  assert.equal(focusOf(b), "#bbb");
  assert.deepEqual(r.looks, { loops: { color: "#aaa" } });
  // later loops is shown again: it still gets its colour back
  r = layoutLook(r.looks, "loops", a, false, "#f00");
  assert.equal(focusOf(a), "#aaa");
  assert.equal(r.looks, null);
});

test("layoutLook on never wipes a saved colour (a second bar sees red already)", () => {
  const a = tree("#f00");
  const r = layoutLook({ loops: { color: "#aaa" } }, "loops", a, true, "#f00");
  assert.equal(r.changed, false);
  assert.deepEqual(r.looks, { loops: { color: "#aaa" } });
  assert.equal(layoutLook(null, "loops", a, true, "#f00").looks, null);
});

test("layoutLook remembers an unset colour and removes it again", () => {
  const a = tree(null);
  const r = layoutLook(null, "m", a, true, "#f00");
  assert.deepEqual(r.looks, { m: { color: null } });
  layoutLook(r.looks, "m", a, false, "#f00");
  assert.equal("color" in a.children[0].content.pane.focus, false);
});

test("lookMap reads the older single-layout storage", () => {
  assert.deepEqual(lookMap({ layout: "loops", color: "#aaa" }), { loops: { color: "#aaa" } });
  assert.deepEqual(lookMap(null), {});
});
