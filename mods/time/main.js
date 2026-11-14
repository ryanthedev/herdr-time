import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, layout, props, settings, agents, shared, setShared, nextCommand, notify, exec, run, window, openOverlay, closeOverlay } from "herdr";
import {
  strftime, pieces, clockOf, lengthOf, parseDuration, parseClock, clockText, nextAt, nextDue,
  repeatText, whenText, untilText, afterDismiss, WEEKDAYS,
} from "./schedule.js";

// Time: a clock, timers and reminders for the status bar.
//
// One mod, four views, picked by props().mode:
// - "bar" (default): what is running or ringing, the next reminder, a bell
//   with the count (opens the list), +, then the clock LAST so it stays put
//   at the right edge of its block whatever comes and goes beside it.
// - "new": the New reminder dialog: In (a countdown), At (a time of day) or
//   Stopwatch; once or repeating (every <length>, daily, weekdays).
// - "list": every reminder and timer, soonest first, each removable. The bar
//   only shows the next reminder, so standing ones don't widen it.
// - "flash": the banner a finished timer or reminder opens. It flashes until
//   every one is dismissed or snoozed, then closes itself.
//
// Bar props (all optional, in the layout block's content.props):
// - `format`: a strftime-style template. `%x` tokens: see schedule.js
//   (`%-d` drops the leading zero, `%%` is a %). `|` draws a dim separator,
//   `[...]` draws its text bright and larger; everything else is muted.
// - `tooltip`: a second template, shown on hover.
// - `presets`: the countdown lengths the dialog offers, in minutes.
// - `font`: the font family. Defaults to the terminals' (settings()
//   `font_family`), which is monospaced, so digits keep their width and the
//   bar doesn't shift every second. `""` uses the app's UI font.
// - `block` (default "time"): this block's layout id, so the mod can widen or
//   narrow it as things come and go.
//
// Everything lives in shared "time.timers", so it survives reloads and
// restarts. A reminder that came due while Herdr was closed rings once on
// start; a repeating one then moves to its next future time (missed slots
// are skipped, not rung one by one).
//
// Who set it: the person sets things in the dialog. Everything else arrives
// as a command (`herdr-app do time.<command>`, or "<key>": "time:<command>"
// in keys.json), which can't tell who sent it, so a command that starts
// something must name the agent's terminal and say what it is for:
//   herdr-app do "time.timer-25m @$HC_TERMINAL_ID Check the deploy"
//   herdr-app do "time.at-15:00 @$HC_TERMINAL_ID Standup"
//   herdr-app do "time.every-30m @$HC_TERMINAL_ID Stretch"
//   herdr-app do "time.daily-09:00 @$HC_TERMINAL_ID Plan the day"
//   herdr-app do "time.weekdays-17:30 @$HC_TERMINAL_ID Write the log"
//   herdr-app do "time.stopwatch @$HC_TERMINAL_ID Load test"
// The terminal must be a live agent (agents()); its name, space and tab are
// kept with the item. A command without both is refused with a notification.
// Other commands: new, list, toggle (the newest timer), pause-all,
// resume-all, dismiss (every ringing one), clear.
//
// Cost: a 1-second timer that redraws only when the text changes. The icon
// animations run natively (spin, loop, transition), not in render.

const MOD = "time";
const TICK_MS = 1000;
const DEFAULT_FORMAT = "%a %-d %b | [%H:%M:%S]";
const DEFAULT_TOOLTIP = "%A %-d %B %Y · week %V · day %j · UTC%z";
const DEFAULT_PRESETS = [5, 15, 25, 45, 60];
const SNOOZE_MS = 5 * 60000;
const TIMERS = "time.timers";
const SOUND = "/System/Library/Sounds/Glass.aiff";
const icon = (name) => svg(`mods/${MOD}/icons/${name}.svg`);

// "#rrggbb" + alpha; other color forms pass through.
const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c);
// Same ground as the shipped workspace-status bar: the theme background at the layout's terminal_opacity.
const glass = (c) => {
  const op = Math.max(0, Math.min(1, Number(layout()?.terminal_opacity ?? 1)));
  return alpha(c, 1 - (1 - op) ** 2);
};

const opts = () => {
  const p = props() ?? {};
  const presets = Array.isArray(p.presets) ? p.presets.filter((n) => Number(n) > 0).map(Number) : DEFAULT_PRESETS;
  return {
    format: typeof p.format === "string" && p.format ? p.format : DEFAULT_FORMAT,
    tooltip: typeof p.tooltip === "string" ? p.tooltip : DEFAULT_TOOLTIP,
    presets: presets.length ? presets : DEFAULT_PRESETS,
    block: typeof p.block === "string" && p.block ? p.block : "time",
    font: typeof p.font === "string" ? p.font : String(settings()?.font_family ?? ""),
  };
};

// --- State --------------------------------------------------------------------
// One list of items:
// - timers: { id, kind: "up" | "down", ms (countdown length), acc (ms run
//   before the current start), at (start time, null while paused), ... }
// - reminders: { id, kind: "at", due (ms), repeat: null | { every, from } |
//   { at: {h, m}, days } }
// and on every item: rang (ringing), doneAt (when it rang), msg, by (null when
// the person set it in the dialog, else the agent that asked:
// { terminal, name, icon, tint, space, tab, title }).

const items = () => (Array.isArray(shared(TIMERS)) ? shared(TIMERS) : []);
const save = (list) => setShared(TIMERS, list);
const elapsed = (x, now) => x.acc + (x.at ? now - x.at : 0);
const remaining = (x, now) => Math.max(0, x.ms - elapsed(x, now));
const isTimer = (x) => x.kind === "up" || x.kind === "down";
const timerText = (x, now) => (x.kind === "up" ? clockOf(elapsed(x, now)) : clockOf(remaining(x, now), false));
const kindText = (x) => (x.kind === "up" ? "stopwatch" : x.kind === "down" ? `${lengthOf(x.ms)} timer` : x.repeat ? repeatText(x.repeat) : "reminder");
const nameOf = (x) => x.msg || (x.kind === "up" ? "Stopwatch" : x.kind === "down" ? `${lengthOf(x.ms)} timer` : "Reminder");
const short = (s, n = 18) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// When it next needs you, for sorting: ringing first, then soonest.
const dueOf = (x, now) => (x.rang ? 0 : x.kind === "at" ? x.due : x.kind === "down" ? (x.at ? now + remaining(x, now) : Infinity) : Infinity);

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const addItem = (x) => save([...items(), { id: newId(), rang: false, doneAt: null, by: null, ...x, msg: String(x.msg ?? "").trim() }]);
const addTimer = (kind, ms = 0, msg = "", by = null) => addItem({ kind, ms, acc: 0, at: Date.now(), msg, by });
// A reminder at a time of day (once or repeating), or every <length>.
function addReminder({ clock, days = null, every = 0, repeat = false, msg = "", by = null }) {
  const now = Date.now();
  if (every) return addItem({ kind: "at", due: now + every, repeat: repeat ? { every, from: now + every } : null, msg, by });
  const r = repeat ? { at: clock, days } : null;
  addItem({ kind: "at", due: r ? nextDue(r, now) : nextAt(clock, null, now), repeat: r, msg, by });
}

// The live agent in a terminal: "t12p" matches "t12p" or "<machine>/t12p".
function agentAt(terminal) {
  if (!terminal) return null;
  return agents().find((a) => a.address === terminal || a.address.endsWith(`/${terminal}`)) ?? null;
}
const byOf = (a) => ({
  terminal: a.address, name: a.program?.name || a.app || "agent", icon: a.program?.icon ?? null, tint: a.program?.tint ?? true,
  space: a.space_name, tab: a.tab_name || `tab ${a.tab_index}`, title: a.title || "",
});
// "Claude Code in herdr-time › 1", or "you".
const whoOf = (x) => (x.by ? `${x.by.name} in ${x.by.space} › ${x.by.tab}` : "you");

// Dismiss: a repeating reminder moves to its next time, the rest go away.
const dismiss = (id) => {
  const now = Date.now();
  save(items().flatMap((x) => (x.id !== id ? [x] : [afterDismiss(x, now)].filter(Boolean))));
};
const dismissAll = () => {
  const now = Date.now();
  save(items().flatMap((x) => (!x.rang ? [x] : [afterDismiss(x, now)].filter(Boolean))));
};
const removeItem = (id) => save(items().filter((x) => x.id !== id));
// Snooze: ring again in 5 minutes. A repeating reminder keeps its series.
const snooze = (id) => {
  const x = items().find((y) => y.id === id);
  if (!x) return;
  dismiss(id);
  addTimer("down", SNOOZE_MS, nameOf(x), x.by ?? null);
};
function toggleTimer(id) {
  const now = Date.now();
  const x = items().find((y) => y.id === id);
  if (!x) return;
  if (x.rang) return dismiss(id);
  if (!isTimer(x)) return;
  save(items().map((y) => (y.id !== id ? y : y.at ? { ...y, acc: elapsed(y, now), at: null } : { ...y, at: now })));
}
const setAll = (running) => {
  const now = Date.now();
  save(items().map((x) => (!isTimer(x) || x.rang ? x : running ? (x.at ? x : { ...x, at: now }) : (x.at ? { ...x, acc: elapsed(x, now), at: null } : x))));
};

// The banner. Opening the same key again replaces the open one in place, so
// this is safe to call whenever something rings.
function openFlash() {
  const n = items().filter((x) => x.rang).length;
  if (!n) return;
  openOverlay({ mod: MOD, kind: "window", key: "time-banner", frame: "none", width: 600, height: 66 + Math.min(n, 4) * 78, props: { mode: "flash" } });
}
const openNew = () => openOverlay({ mod: MOD, kind: "dialog", width: 460, height: 430, props: { mode: "new" } });
const openList = () => openOverlay({ mod: MOD, kind: "dialog", width: 500, height: Math.min(560, 132 + Math.max(1, items().length) * 58), props: { mode: "list" } });

// --- Bar width ------------------------------------------------------------------
// The bar can't measure its content, so it estimates it and resizes its
// layout block to fit. Every piece below is built together with its width
// (CH: one character at the bar's 11.8px; the clock's bright part is 13px).
const CH_UI = 6.3, CH_MONO = 7.2, GAP = 8, PAD_L = 10, PAD_R = 14, SLACK = 6;
const BIG = 13 / 11.8;

// An agent's mark: its program's icon from Herdr's icons, else a bot.
const agentMark = (by, size, color) => {
  const el = by?.icon ? (by.tint ? svg(by.icon) : image(by.icon)) : icon("bot");
  return div().flex_none().text_color(color).child(el.size(size));
};

// A small button for the dialogs and the banner. Stops the press so a click
// doesn't start dragging the banner window.
const button = (t, id, text, primary, action) => h_flex().id(id).h(30).px(12).items_center().rounded(8).flex_none()
  .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
  .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
  .hover((s) => s.opacity(0.88))
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
  .on_click((_e, cx) => { action(); cx.notify(); }).child(text);

// A row of choices, one picked: [{ id, label }].
const segmented = (t, id, choices, value, pick) => h_flex().id(id).p(3).gap(3).rounded(9).bg(t.background).border_1().border_color(t.input)
  .children(choices.map((c) => h_flex().id(`${id}-${c.id}`).flex_1().h(28).items_center().justify_center().rounded(7).cursor_pointer()
    .text_size(12.5).font_medium()
    .bg(c.id === value ? t.raised : alpha(t.background, 0))
    .text_color(c.id === value ? t.foreground : t.muted)
    .when(c.id === value, (el) => el.border_1().border_color(t.input))
    .hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => { pick(c.id); cx.notify(); })
    .child(c.label)));

const iconFor = (x) => (x.rang ? "alarm" : x.kind === "up" ? "stopwatch" : x.kind === "down" ? "hourglass" : "calendar-clock");

export default class Time extends View {
  init(_props, cx) {
    this.mode = props()?.mode ?? "bar";
    if (this.mode === "new") return this.initNew(cx);
    if (this.mode === "flash") return this.initFlash(cx);
    if (this.mode === "list") return this.initList(cx);
    this.shown = ""; this.width = 0;
    this.tick(cx);
    if (items().some((x) => x.rang)) openFlash();            // rang while Herdr was closed
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        this.command(await nextCommand());
        this.tick(cx); cx.notify();
      }
    });
  }

  render() {
    if (this.mode === "new") return this.renderNew();
    if (this.mode === "flash") return this.renderFlash();
    if (this.mode === "list") return this.renderList();
    return this.renderBar();
  }

  close() { closeOverlay(props().overlay); }

  // --- Commands ---------------------------------------------------------------

  command(c) {
    const start = /^(timer-\S+|stopwatch|at-\S+|every-\S+|daily-\S+|weekdays-\S+)(?:\s+([\s\S]*))?$/.exec(c.trim());
    if (start) return this.commandStart(start[1], start[2] ?? "");
    if (c === "toggle") { const last = items().filter((x) => isTimer(x) && !x.rang).at(-1); if (last) toggleTimer(last.id); }
    else if (c === "pause-all") setAll(false);
    else if (c === "resume-all") setAll(true);
    else if (c === "dismiss") dismissAll();
    else if (c === "clear") save([]);
    else if (c === "new" || c === "pick") openNew();
    else if (c === "list") openList();
  }

  // Started by command: needs "@<agent terminal> <message>".
  commandStart(head, rest) {
    const refuse = (why) => notify({ title: "Reminder refused", body: why, level: "warning" });
    const [verb, arg = ""] = head === "stopwatch" ? ["stopwatch"] : [head.slice(0, head.indexOf("-")), head.slice(head.indexOf("-") + 1)];
    const ms = verb === "timer" || verb === "every" ? parseDuration(arg) : 0;
    const clock = verb === "at" || verb === "daily" || verb === "weekdays" ? parseClock(arg) : null;
    if ((verb === "timer" || verb === "every") && !ms) return refuse(`"${arg}" is not a length. Try 25m, 90s or 1h30m.`);
    if (verb === "every" && ms < 60000) return refuse("A repeating reminder needs at least 1m between rings.");
    if ((verb === "at" || verb === "daily" || verb === "weekdays") && !clock) return refuse(`"${arg}" is not a time of day. Try 15:00, 9:30 or 3pm.`);
    const m = /^@(\S+)\s*([\s\S]*)$/.exec(rest.trim());
    if (!m) return refuse("Say which agent is asking: @$HC_TERMINAL_ID, then the message.");
    const agent = agentAt(m[1]);
    if (!agent) return refuse(`@${m[1]} is not a live agent's terminal.`);
    const msg = m[2].trim();
    if (!msg) return refuse(`${agent.program?.name || "An agent"} in ${agent.space_name} asked for a reminder with no message. They need one.`);
    const by = byOf(agent);
    if (verb === "stopwatch") addTimer("up", 0, msg, by);
    else if (verb === "timer") addTimer("down", ms, msg, by);
    else if (verb === "every") addReminder({ every: ms, repeat: true, msg, by });
    else if (verb === "at") addReminder({ clock, msg, by });
    else addReminder({ clock, repeat: true, days: verb === "weekdays" ? WEEKDAYS : null, msg, by });
  }

  // --- Bar --------------------------------------------------------------------

  tick(cx) {
    const now = Date.now();
    // Countdowns that ran out and reminders that came due: mark, announce, flash, ring.
    const list = items();
    const due = list.filter((x) => !x.rang && ((x.kind === "down" && x.at && remaining(x, now) === 0) || (x.kind === "at" && x.due <= now)));
    if (due.length) {
      save(list.map((x) => (!due.includes(x) ? x
        : x.kind === "down" ? { ...x, rang: true, doneAt: now, acc: x.ms, at: null }
        : { ...x, rang: true, doneAt: x.due })));
      for (const x of due) notify({ title: `${x.kind === "at" ? "Reminder" : "Time's up"}: ${nameOf(x)}`, body: x.by ? `Set by ${whoOf(x)}` : x.repeat ? `Repeats ${repeatText(x.repeat)}` : "Your reminder", level: "success",
        action: x.by ? { name: "pane.focus", args: { terminal: x.by.terminal } } : null });
      openFlash();
      if (window()?.platform === "macos") cx.spawn(async () => { try { await exec("afplay", [SOUND], { timeout: 5000 }); } catch { /* no sound */ } });
    }
    const shown = [strftime(opts().format, new Date(now)), ...items().map((x) => `${x.id}${x.at ? "" : "p"}${x.rang ? "r" : ""}${isTimer(x) ? timerText(x, now) : x.due}${x.msg}`)].join("|");
    if (shown !== this.shown) { this.shown = shown; cx.notify(); }
    this.fit();
  }

  // What the bar shows besides the clock: every timer, everything ringing,
  // and the next reminder. The rest are counted on the bell.
  visible(now) {
    const list = [...items()].sort((a, b) => dueOf(a, now) - dueOf(b, now));
    const next = list.find((x) => x.kind === "at" && !x.rang);
    return list.filter((x) => isTimer(x) || x.rang || x === next);
  }

  // The bar's pieces in order, each { w, el }: chips, bell, +, |, clock.
  parts(now, t) {
    const { font } = opts();
    const ch = font ? CH_MONO : CH_UI;
    const all = items();
    const out = [];
    for (const x of this.visible(now)) out.push(this.chip(x, now, t, ch));
    const reminders = all.filter((x) => x.kind === "at").length;
    if (all.length) {
      const n = String(reminders || all.length);
      out.push({
        w: 12 + 13 + 4 + n.length * ch,
        el: () => h_flex().id("tm-list").flex_none().gap(4).px(6).h(20).items_center().rounded(10).cursor_pointer().text_color(t.muted)
          .tooltip(`${all.length} reminder${all.length === 1 ? "" : "s"} and timer${all.length === 1 ? "" : "s"} · click to see them all`)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => openList())
          .child(icon("bell").size(13)).child(div().child(n)),
      });
    }
    out.push({
      w: 12 + 13,
      el: () => h_flex().id("tm-new").flex_none().px(6).h(20).items_center().rounded(10).cursor_pointer().text_color(t.dim).tooltip("new reminder or timer")
        .hover((s) => s.bg(t.hover).text_color(t.accent))
        .on_click(() => openNew())
        .child(icon("plus").size(13)),
    });
    out.push({ w: ch, el: () => div().flex_none().text_color(t.border).child("|") });
    const ps = pieces(strftime(opts().format, new Date(now)));
    const cw = ps.reduce((a, p) => a + (p.sep ? ch : [...p.text].length * ch * (p.bright ? BIG : 1)), 0) + Math.max(0, ps.length - 1) * GAP;
    const { tooltip } = opts();
    out.push({
      w: cw,
      el: () => h_flex().id("time").gap(GAP).items_center().flex_none()
        .when(Boolean(tooltip), (el) => el.tooltip(strftime(tooltip, new Date(now))))
        .children(ps.map((p) => p.sep
          ? div().text_color(t.border).child("|")
          : p.bright
            ? div().text_size(13).font_semibold().text_color(t.foreground).child(p.text)
            : div().text_color(t.muted).child(p.text))),
    });
    return out;
  }

  // One item as a pill: icon, time, message, repeat mark, agent, ×.
  chip(x, now, t, ch) {
    const done = x.rang, paused = isTimer(x) && !x.at && !done;
    const c = done ? t.blocked : paused ? t.dim : x.kind === "at" ? t.foreground : t.accent;
    const text = done && x.kind === "at" ? whenText(x.doneAt, now) : isTimer(x) ? timerText(x, now) : whenText(x.due, now);
    const msg = x.msg ? short(x.msg) : "";
    const w = 16 + 13 + 5 + [...text].length * ch + (msg ? 5 + [...msg].length * ch : 0) + (x.repeat ? 5 + 11 : 0) + (x.by ? 5 + 12 : 0) + 5 + 10;
    const tip = `${nameOf(x)} · ${kindText(x)} · set by ${whoOf(x)} · ${done ? "click to dismiss"
      : isTimer(x) ? `click to ${paused ? "resume" : "pause"}` : `${whenText(x.due, now)}, ${untilText(x.due, now)}`}`;
    const el = () => {
      const chip = h_flex().id(`tm-${x.id}`).relative().flex_none().gap(5).px(8).h(20).items_center().rounded(10)
        .bg(alpha(c, done ? 0.18 : 0.1)).cursor_pointer().tooltip(tip)
        .hover((s) => s.bg(alpha(c, 0.2)))
        .on_click((_e, cx) => { if (isTimer(x) || x.rang) toggleTimer(x.id); else openList(); this.fit(); cx.notify(); })
        .child(this.itemIcon(x, c))
        .child(div().text_color(c).when(x.kind === "at" && !done, (el) => el.font_semibold()).child(text))
        .when(Boolean(msg), (el) => el.child(div().text_color(done ? t.blocked : t.muted).child(msg)))
        .when(Boolean(x.repeat), (el) => el.child(div().flex_none().text_color(t.dim).child(icon("repeat").size(11))))
        .when(Boolean(x.by), (el) => el.child(agentMark(x.by, 12, t.dim)))
        .child(div().id(`tx-${x.id}`).flex_none().cursor_pointer().text_color(t.dim).tooltip(x.repeat ? "delete this repeating reminder" : "remove")
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); removeItem(x.id); this.fit(); cx.notify(); })
          .child(icon("x").size(10)));
      // A running countdown drains a thin line along the pill's bottom.
      if (x.kind === "down" && !done) {
        const frac = remaining(x, now) / x.ms;
        chip.child(div().absolute().left(8).bottom(1).h(2).rounded(1).bg(c).opacity(paused ? 0.35 : 0.7)
          .w(Math.max(0, (w - 16) * frac)).transition("width", { duration: TICK_MS, easing: "linear" }));
      }
      return done ? chip.loop("opacity", { from: 0.5, to: 1, period: 700 }) : chip;
    };
    return { w, el };
  }

  fit() {
    const ps = this.parts(Date.now(), theme());
    const px = Math.ceil(PAD_L + PAD_R + SLACK + ps.reduce((a, p) => a + p.w, 0) + Math.max(0, ps.length - 1) * GAP);
    if (Math.abs(px - this.width) >= 4) this.resize(px);
  }
  resize(px) {
    this.width = px;
    run("layout.resize", { id: opts().block, px });
  }

  // The icon for an item, animated natively:
  // running stopwatch: its hand sweeps; running countdown: the hourglass
  // breathes; paused: a slow pulse; ringing: the alarm shakes.
  itemIcon(x, c) {
    const box = () => div().relative().size(13).flex_none().text_color(c);
    if (x.rang) return box().child(icon("alarm").size(13)).loop("left", { from: -1.5, to: 1.5, period: 140, easing: "linear" });
    if (x.kind === "at") return box().child(icon("calendar-clock").size(13));
    if (!x.at) return box().child(icon("pause").size(13)).loop("opacity", { from: 0.35, to: 0.9, period: 1800 });
    if (x.kind === "up") return box().child(icon("stopwatch").size(13))
      // The dial's center is 2/24 below the svg's, so the hand's svg sits 13*2/24 lower.
      .child(icon("hand").size(13).absolute().top(13 * 2 / 24).left(0).spin(3000));
    return box().child(icon("hourglass").size(13)).loop("opacity", { from: 0.55, to: 1, period: 2000 });
  }

  renderBar() {
    const t = theme();
    const { font } = opts();
    return h_flex().id("time-bar").size_full().pl(PAD_L).pr(PAD_R).gap(GAP).items_center().justify_end().whitespace_nowrap().overflow_hidden()
      .bg(glass(t.background)).border_t(1).border_color(t.border).text_size(11.8)
      .when(Boolean(font), (el) => el.font_family(font))
      // The layout can reset the block's size (a layout.set reapplies the
      // file's px); put ours back whenever the real size drifts from it.
      .on_size_change((size, _cx) => { if (this.width && Math.abs(size.width - this.width) >= 4) this.resize(this.width); })
      .children(this.parts(Date.now(), t).map((p) => p.el()));
  }

  // --- New dialog -------------------------------------------------------------

  initNew(cx) {
    this.err = "";
    this.kind = "in";     // "in" | "at" | "up"
    this.rep = "once";    // "once" | "repeat" (in) | "daily" | "weekdays" (at)
    this.msg = InputState.new({ placeholder: "What to remind you of" });
    // One field per kind (an InputState's placeholder can't change once made).
    this.whenIn = InputState.new({ placeholder: "25m, 90s, 1h30m" });
    this.whenAt = InputState.new({ placeholder: "15:00, 9:30, 3pm" });
    this.msg.on("submit", (_e, cx) => { if (this.kind === "up") this.start(); else this.field().focus(); cx.notify(); });
    for (const f of [this.whenIn, this.whenAt]) {
      f.on("submit", (_e, cx) => { this.start(); cx.notify(); });
      f.on("change", (_e, cx) => { this.err = ""; cx.notify(); });
    }
    this.msg.focus();
    cx.timer.after(300, () => this.msg.focus());
    this.handle = cx.focus_handle();
  }

  setKind(k) {
    if (k === this.kind) return;
    this.kind = k; this.rep = "once"; this.err = "";
  }
  // The time field for the current kind.
  field() { return this.kind === "at" ? this.whenAt : this.whenIn; }

  // What Start would do, in words, or an error.
  preview(now = Date.now()) {
    const v = this.field().value();
    if (this.kind === "up") return { ok: true, text: "Counts up from 0:00 until you stop it." };
    if (this.kind === "in") {
      const ms = parseDuration(v);
      if (!v.trim()) return { ok: false, text: "Type a length, or pick one below." };
      if (!ms) return { ok: false, err: true, text: "Try 25m, 90s, 1h30m or a number of minutes." };
      if (this.rep === "repeat" && ms < 60000) return { ok: false, err: true, text: "Repeats need at least 1m between rings." };
      return { ok: true, ms, text: `Rings at ${whenText(now + ms, now)}${this.rep === "repeat" ? `, then every ${lengthOf(ms)}` : ""}.` };
    }
    const clock = parseClock(v);
    if (!v.trim()) return { ok: false, text: "Type a time of day." };
    if (!clock) return { ok: false, err: true, text: "Try 15:00, 9:30 or 3pm." };
    const days = this.rep === "weekdays" ? WEEKDAYS : null;
    const due = this.rep === "once" ? nextAt(clock, null, now) : nextAt(clock, days, now);
    return { ok: true, clock, text: `Rings ${whenText(due, now)} (${untilText(due, now)})${this.rep === "once" ? "" : `, then ${this.rep === "daily" ? "every day" : "every weekday"} at ${clockText(clock)}`}.` };
  }

  start(ms) {
    const msg = this.msg.value();
    if (this.kind === "up") { addTimer("up", 0, msg); return this.close(); }
    if (ms) { this.kind === "in" && this.rep === "repeat" ? addReminder({ every: ms, repeat: true, msg }) : addTimer("down", ms, msg); return this.close(); }
    const p = this.preview();
    if (!p.ok) { this.err = p.err ? p.text : this.kind === "at" ? "Type a time of day first." : "Type a length first."; return; }
    if (this.kind === "in") {
      if (this.rep === "repeat") addReminder({ every: p.ms, repeat: true, msg });
      else addTimer("down", p.ms, msg);
    } else addReminder({ clock: p.clock, repeat: this.rep !== "once", days: this.rep === "weekdays" ? WEEKDAYS : null, msg });
    this.close();
  }

  renderNew() {
    const t = theme();
    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const field = (state) => Input.new(state).h(34).px(10).rounded(9).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground);
    const p = this.preview();
    const hint = this.err || p.text;
    return v_flex().id("time-new").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .size_full().p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(8)
        .child(div().text_color(t.accent).child(icon("bell").size(16)))
        .child(div().flex_1().text_size(15).font_semibold().child("New reminder"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(14).child(segmented(t, "tn-kind", [
        { id: "in", label: "In…" }, { id: "at", label: "At a time" }, { id: "up", label: "Stopwatch" },
      ], this.kind, (k) => this.setKind(k))))
      .child(label("Message"))
      .child(field(this.msg))
      .when(this.kind !== "up", (el) => el
        .child(label(this.kind === "at" ? "Time of day" : "Length"))
        .child(field(this.field()))
        .child(label("Repeat"))
        .child(segmented(t, "tn-rep", this.kind === "at"
          ? [{ id: "once", label: "Once" }, { id: "daily", label: "Every day" }, { id: "weekdays", label: "Weekdays" }]
          : [{ id: "once", label: "Once" }, { id: "repeat", label: "Keep repeating" }], this.rep, (r) => { this.rep = r; this.err = ""; })))
      .child(div().pt(10).text_size(11.5).text_color(this.err || p.err ? t.blocked : p.ok ? t.muted : t.dim).child(hint))
      .when(this.kind === "in", (el) => el.child(h_flex().pt(10).gap(6).flex_wrap()
        .children(opts().presets.map((m) => button(t, `tn-${m}`, lengthOf(m * 60000), false, () => this.start(m * 60000))))))
      .child(div().flex_1())
      .child(h_flex().pt(14).gap(8).justify_end()
        .child(button(t, "tn-cancel", "Cancel", false, () => this.close()))
        .child(button(t, "tn-go", "Start", true, () => this.start())));
  }

  // --- List -------------------------------------------------------------------

  initList(cx) {
    this.handle = cx.focus_handle();
    cx.timer.after(50, () => this.handle.focus());
    cx.timer.every(TICK_MS, (cx) => cx.notify());
  }

  renderList() {
    const t = theme();
    const now = Date.now();
    const list = [...items()].sort((a, b) => dueOf(a, now) - dueOf(b, now));
    const sub = (x) => [
      x.rang ? `rang ${whenText(x.doneAt ?? now, now)}`
        : x.kind === "at" ? `${whenText(x.due, now)} · ${untilText(x.due, now)}`
        : x.kind === "down" ? `${timerText(x, now)} left${x.at ? "" : " · paused"}`
        : `${timerText(x, now)}${x.at ? "" : " · paused"}`,
      x.repeat ? repeatText(x.repeat) : x.kind === "at" ? "once" : kindText(x),
      x.by ? `set by ${whoOf(x)}` : null,
    ].filter(Boolean).join(" · ");
    const row = (x) => {
      const c = x.rang ? t.blocked : isTimer(x) && !x.at ? t.dim : x.kind === "at" ? t.foreground : t.accent;
      return h_flex().id(`ls-${x.id}`).gap(12).px(16).h(58).items_center().border_t(1).border_color(t.border)
        .hover((s) => s.bg(t.hover))
        .child(div().flex_none().size(30).rounded(15).bg(alpha(c, 0.12)).flex().items_center().justify_center().text_color(c)
          .child(icon(iconFor(x)).size(15)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).items_center()
            .child(div().text_size(13.5).font_semibold().truncate().child(nameOf(x)))
            .when(Boolean(x.repeat), (el) => el.child(div().flex_none().text_color(t.dim).child(icon("repeat").size(11)))))
          .child(div().text_size(11.5).text_color(x.rang ? t.blocked : t.dim).truncate().child(sub(x))))
        .when(x.rang, (el) => el.child(button(t, `ld-${x.id}`, x.repeat ? "Done" : "Dismiss", true, () => dismiss(x.id))))
        .when(isTimer(x) && !x.rang, (el) => el.child(button(t, `lp-${x.id}`, x.at ? "Pause" : "Resume", false, () => toggleTimer(x.id))))
        .child(div().id(`lx-${x.id}`).flex_none().p(6).rounded(6).cursor_pointer().text_color(t.dim).tooltip(x.repeat ? "delete this repeating reminder" : "remove")
          .hover((s) => s.bg(t.raised).text_color(t.blocked))
          .on_click((_e, cx) => { removeItem(x.id); cx.notify(); })
          .child(icon("x").size(13)));
    };
    return v_flex().id("time-list").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .size_full().bg(t.popover).text_color(t.foreground)
      .child(h_flex().px(18).pt(16).pb(12).items_center().gap(8)
        .child(div().text_color(t.accent).child(icon("bell").size(16)))
        .child(div().flex_1().text_size(15).font_semibold().child("Reminders"))
        .child(div().text_size(11).text_color(t.dim).child(`${list.length} · Esc`)))
      .child(v_flex().id("time-list-rows").flex_1().min_h(0).overflow_y_scrollbar()
        .when(!list.length, (el) => el.child(div().px(18).py(24).text_size(12.5).text_color(t.dim).child("Nothing set. New adds a reminder, a timer or a stopwatch.")))
        .children(list.map(row)))
      .child(h_flex().px(16).py(12).gap(8).justify_end().border_t(1).border_color(t.border)
        .child(button(t, "ls-new", "New reminder", true, () => { this.close(); openNew(); })));
  }

  // --- Flash banner -------------------------------------------------------------

  initFlash(cx) {
    this.handle = cx.focus_handle();
    cx.timer.after(50, () => this.handle.focus());
    cx.timer.every(500, (cx) => {
      if (!items().some((x) => x.rang)) this.close(); else cx.notify();
    });
  }

  renderFlash() {
    const t = theme();
    const now = Date.now();
    const done = items().filter((x) => x.rang);
    const at = (ms) => (ms ? strftime("%H:%M", new Date(ms)) : "");
    const line = (x) => x.kind === "at"
      ? `${x.repeat ? `${repeatText(x.repeat)} · next ${whenText(nextDue(x.repeat, now), now)}` : "reminder"} · rang at ${at(x.doneAt)}`
      : `${kindText(x)} · done at ${at(x.doneAt)}`;
    const row = (x) => h_flex().id(`fl-${x.id}`).gap(14).px(20).h(78).items_center().border_t(1).border_color(alpha(t.blocked, 0.25))
      .child(div().relative().size(36).flex_none().rounded(18).bg(alpha(t.blocked, 0.15)).flex().items_center().justify_center().text_color(t.blocked)
        .child(div().relative().child(icon("alarm").size(20)).loop("left", { from: -1.5, to: 1.5, period: 120, easing: "linear" })))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(16).font_semibold().text_color(t.foreground).truncate().child(nameOf(x)))
        .child(div().text_size(11.5).text_color(t.muted).truncate().child(line(x)))
        .child(h_flex().gap(5).items_center().text_size(11.5).text_color(t.dim).overflow_hidden()
          .child(div().flex_none().child("set by"))
          .when(Boolean(x.by), (el) => el.child(agentMark(x.by, 12, t.muted))
            .child(div().flex_none().text_color(t.foreground).child(x.by?.name ?? ""))
            .child(div().truncate().child(`in ${x.by?.space} › ${x.by?.tab}`)))
          .when(!x.by, (el) => el.child(div().text_color(t.foreground).child("you")))))
      .when(Boolean(x.by), (el) => el.child(button(t, `fg-${x.id}`, "Go", false, () => run("pane.focus", { terminal: x.by.terminal }))))
      .child(button(t, `fs-${x.id}`, `+${lengthOf(SNOOZE_MS)}`, false, () => snooze(x.id)))
      .child(button(t, `fd-${x.id}`, x.repeat ? "Done" : "Dismiss", true, () => dismiss(x.id)));

    return v_flex().id("time-flash").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { dismissAll(); this.close(); cx.stop_propagation(); } })
      .relative().size_full().rounded(14).overflow_hidden().bg(t.popover).border_2().border_color(t.blocked)
      .text_color(t.foreground)
      // The flash: a layer of the alarm color pulsing over the card.
      .child(div().absolute().top(0).left(0).size_full().bg(t.blocked).loop("opacity", { from: 0.03, to: 0.16, period: 900 }))
      .child(h_flex().px(20).pt(16).pb(10).items_center().gap(8)
        .child(div().text_color(t.blocked).child(icon("bell").size(15)))
        .child(div().flex_1().text_size(13).font_semibold().text_color(t.blocked).child(done.length > 1 ? `${done.length} reminders` : "Reminder"))
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child(strftime("%H:%M", new Date(now))))
        .child(div().pl(8).text_size(11).text_color(t.dim).child("Esc dismisses all")))
      .children(done.slice(0, 4).map(row))
      .when(done.length > 4, (el) => el.child(div().px(20).text_size(11.5).text_color(t.dim).child(`and ${done.length - 4} more`)));
  }
}
