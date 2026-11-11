import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, layout, props, settings, agents, shared, setShared, nextCommand, notify, exec, run, window, openOverlay, closeOverlay } from "herdr";

// Time: a clock and timers for the left end of the status bar.
//
// One mod, three views, picked by props().mode:
// - "bar" (default): the clock, then each timer, then +. The layout puts this
//   block beside the status bar mod in one 28px row, so it paints the same
//   ground and top border to read as one bar.
// - "new": the dialog + opens. An optional message, a length (25m, 90s,
//   1h30m) or a preset, or a stopwatch.
// - "flash": the banner a finished countdown opens. It flashes until every
//   finished timer is dismissed or snoozed, then closes itself.
//
// Bar props (all optional, in the layout block's content.props):
// - `format`: a strftime-style template. `%x` tokens: see TOKENS (`%-d` drops
//   the leading zero, `%%` is a %). `|` draws a dim separator, `[...]` draws
//   its text bright; everything else is muted.
// - `tooltip`: a second template, shown on hover.
// - `presets`: the countdown lengths the dialog offers, in minutes.
// - `font`: the font family. Defaults to the terminals' (settings()
//   `font_family`), which is monospaced, so digits keep their width and the
//   bar doesn't shift every second. `""` uses the app's UI font.
// - `block` (default "time"): this block's layout id, so the mod can widen or
//   narrow it as timers come and go.
//
// Timers live in shared "time.timers", so they survive reloads and restarts.
// There is no limit on how many; the bar grows to fit them.
// Click a timer to pause or resume it, its x removes it.
//
// Who set it: the person sets timers in the dialog. Everything else arrives
// as a command (`herdr-app do time.<command>`, or "<key>": "time:<command>"
// in keys.json), which can't tell who sent it, so a command that starts a
// timer must name the agent's terminal and say what the timer is for:
//   herdr-app do "time.timer-25m @$HC_TERMINAL_ID Check the deploy"
//   herdr-app do "time.stopwatch @$HC_TERMINAL_ID Load test"
// The terminal must be a live agent (agents()); its name, space and tab are
// kept with the timer and shown in the bar's tooltip, the banner and the
// notification. A command without both is refused with a notification.
// Other commands: new, toggle (the newest), pause-all, resume-all, dismiss
// (finished ones), clear.
//
// Cost: a 1-second timer that redraws only when the text changes. The icon
// animations run natively (spin, loop, transition), not in render.

const MOD = "time";
const TICK_MS = 1000;
const DEFAULT_FORMAT = "%a %-d %b %Y-%m-%d | [%H:%M:%S]";
const DEFAULT_TOOLTIP = "%A %-d %B %Y · week %V · day %j · UTC%z";
const DEFAULT_PRESETS = [1, 5, 15, 25, 60];
const SNOOZE_MS = 5 * 60000;
const TIMERS = "time.timers";
const SOUND = "/System/Library/Sounds/Glass.aiff";
const icon = (name) => svg(`mods/${MOD}/icons/${name}.svg`);

// Same ground as the shipped workspace-status bar: the theme background at the layout's terminal_opacity.
const glass = (c) => {
  const op = Math.max(0, Math.min(1, Number(layout()?.terminal_opacity ?? 1))), a = 1 - (1 - op) ** 2;
  return /^#[0-9a-f]{6}$/i.test(c ?? "") ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n, w = 2) => String(n).padStart(w, "0");


const dayOfYear = (d) => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(d.getFullYear(), 0, 1)) / 86400000) + 1;
// ISO 8601 week: the week holding this date's Thursday, counted from the year's first Thursday.
const isoWeek = (d) => {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
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

// --- Timers -----------------------------------------------------------------
// { id, kind: "up" | "down", ms (countdown length), acc (ms run before the
//   current start), at (start time, null while paused), rang (finished),
//   doneAt, msg (shown in the bar and the banner),
//   by (null when the person set it in the dialog, else the agent that asked:
//   { terminal, name, icon, tint, space, tab, title }) }

const timers = () => (Array.isArray(shared(TIMERS)) ? shared(TIMERS) : []);
const saveTimers = (list) => setShared(TIMERS, list);
const elapsed = (x, now) => x.acc + (x.at ? now - x.at : 0);
const remaining = (x, now) => Math.max(0, x.ms - elapsed(x, now));

// 4:05, 1:02:03; countdowns round up so 0:00 only shows when it is done.
export function clockOf(ms, up = true) {
  const s = up ? Math.floor(ms / 1000) : Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
const timerText = (x, now) => (x.kind === "up" ? clockOf(elapsed(x, now)) : clockOf(remaining(x, now), false));
// 25m, 90s, 1h30m.
export function lengthOf(ms) {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h && `${h}h`, m && `${m}m`, sec && `${sec}s`].filter(Boolean).join("") || "0s";
}
const nameOf = (x) => x.msg || (x.kind === "up" ? "Stopwatch" : `${lengthOf(x.ms)} timer`);
const short = (s, n = 18) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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

function addTimer(kind, ms = 0, msg = "", by = null) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  saveTimers([...timers(), { id, kind, ms, acc: 0, at: Date.now(), rang: false, doneAt: null, msg: String(msg ?? "").trim(), by }]);
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
function toggleTimer(id) {
  const now = Date.now();
  saveTimers(timers().flatMap((x) => {
    if (x.id !== id) return [x];
    if (x.rang) return [];                                   // finished: dismiss
    return [x.at ? { ...x, acc: elapsed(x, now), at: null } : { ...x, at: now }];
  }));
}
const removeTimer = (id) => saveTimers(timers().filter((x) => x.id !== id));
const dismissDone = () => saveTimers(timers().filter((x) => !x.rang));
const snooze = (id) => {
  const x = timers().find((y) => y.id === id);
  removeTimer(id);
  if (x) addTimer("down", SNOOZE_MS, x.msg, x.by ?? null);
};
const setAll = (running) => {
  const now = Date.now();
  saveTimers(timers().map((x) => (x.rang ? x : running ? (x.at ? x : { ...x, at: now }) : (x.at ? { ...x, acc: elapsed(x, now), at: null } : x))));
};

// The banner. Opening the same key again replaces the open one in place, so
// this is safe to call whenever a timer finishes.
function openFlash() {
  const n = timers().filter((x) => x.rang).length;
  if (!n) return;
  openOverlay({ mod: MOD, kind: "window", key: "time-flash", frame: "none", width: 560, height: 64 + Math.min(n, 4) * 74, props: { mode: "flash" } });
}
const openNew = () => openOverlay({ mod: MOD, kind: "dialog", width: 400, height: 330, props: { mode: "new" } });

// Rough width of the bar's content at its 11.8px size; the layout block is
// resized to fit, so it never clips and never leaves a hole. "●" stands for an icon.
const CH_UI = 6.3, CH_MONO = 7.2, ICON = 15, GAP = 8;
const textWidth = (t, ch) => [...t].reduce((a, c) => a + (c === "●" ? ICON : ch), 0);
const widthOf = (texts, ch) => Math.ceil(14 + 8 + texts.reduce((a, t) => a + textWidth(t, ch), 0) + Math.max(0, texts.length - 1) * GAP);

// An agent's mark: its program's icon from Herdr's icons, else a bot.
const agentMark = (by, size, color) => {
  const el = by?.icon ? (by.tint ? svg(by.icon) : image(by.icon)) : icon("bot");
  return div().flex_none().text_color(color).child(el.size(size));
};

// A small button for the dialog and the banner. Stops the press so a click
// doesn't start dragging the banner window.
const button = (t, id, text, primary, action) => h_flex().id(id).h(30).px(12).items_center().rounded(8).flex_none()
  .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
  .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
  .hover((s) => s.opacity(0.88))
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
  .on_click((_e, cx) => { action(); cx.notify(); }).child(text);

export default class Time extends View {
  init(_props, cx) {
    this.mode = props()?.mode ?? "bar";
    if (this.mode === "new") return this.initNew(cx);
    if (this.mode === "flash") return this.initFlash(cx);
    this.shown = ""; this.width = 0;
    this.tick(cx);
    if (timers().some((x) => x.rang)) openFlash();          // finished while Herdr was closed
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
    return this.renderBar();
  }

  // --- Bar ------------------------------------------------------------------

  command(c) {
    const start = /^(timer-(\S+)|stopwatch)(?:\s+([\s\S]*))?$/.exec(c.trim());
    if (start) return this.commandTimer(start[2] ? "down" : "up", start[2], start[3] ?? "");
    if (c === "toggle") { const last = timers().filter((x) => !x.rang).at(-1); if (last) toggleTimer(last.id); }
    else if (c === "pause-all") setAll(false);
    else if (c === "resume-all") setAll(true);
    else if (c === "dismiss") dismissDone();
    else if (c === "clear") saveTimers([]);
    else if (c === "new" || c === "pick") openNew();
  }

  // A timer asked for by command: needs "@<agent terminal> <message>".
  commandTimer(kind, length, rest) {
    const refuse = (why) => notify({ title: "Timer refused", body: why, level: "warning" });
    const ms = kind === "down" ? parseDuration(length) : 0;
    if (kind === "down" && !ms) return refuse(`"${length}" is not a length. Try 25m, 90s or 1h30m.`);
    const m = /^@(\S+)\s*([\s\S]*)$/.exec(rest.trim());
    if (!m) return refuse("Say which agent is asking: @$HC_TERMINAL_ID, then the message.");
    const agent = agentAt(m[1]);
    if (!agent) return refuse(`@${m[1]} is not a live agent's terminal.`);
    const msg = m[2].trim();
    if (!msg) return refuse(`${agent.program?.name || "An agent"} in ${agent.space_name} asked for a timer with no message. Timers need one.`);
    addTimer(kind, ms, msg, byOf(agent));
  }

  tick(cx) {
    const now = Date.now();
    // Countdowns that just ran out: mark, announce, flash, ring.
    const list = timers();
    const due = list.filter((x) => x.kind === "down" && !x.rang && remaining(x, now) === 0);
    if (due.length) {
      saveTimers(list.map((x) => (due.includes(x) ? { ...x, rang: true, doneAt: now, acc: x.ms, at: null } : x)));
      for (const x of due) notify({ title: `Time's up: ${nameOf(x)}`, body: x.by ? `Set by ${whoOf(x)}` : "Your timer", level: "success",
        action: x.by ? { name: "pane.focus", args: { terminal: x.by.terminal } } : null });
      openFlash();
      if (window()?.platform === "macos") cx.spawn(async () => { try { await exec("afplay", [SOUND], { timeout: 5000 }); } catch { /* no sound */ } });
    }
    const shown = [strftime(opts().format, new Date(now)), ...timers().map((x) => `${x.id}${x.at ? "" : "p"}${x.rang ? "r" : ""}${timerText(x, now)}${x.msg}`)].join("|");
    if (shown !== this.shown) { this.shown = shown; cx.notify(); }
    this.fit();
  }

  // Everything the bar shows, as text, for widthOf().
  texts() {
    const now = Date.now();
    const clock = pieces(strftime(opts().format, new Date(now))).map((p) => (p.sep ? "|" : p.text));
    const ts = timers().flatMap((x) => [`●${timerText(x, now)}${x.msg ? ` ${short(x.msg)}` : ""}${x.by ? " ●" : ""}`, "●"]);
    return [...clock, "|", ...ts, "●"];
  }

  fit() {
    const px = widthOf(this.texts(), opts().font ? CH_MONO : CH_UI);
    if (Math.abs(px - this.width) >= 4) {
      this.width = px;
      run("layout.resize", { id: opts().block, px });
    }
  }

  // The icon for a timer, animated natively:
  // running stopwatch: its hand sweeps; running countdown: the hourglass
  // breathes; paused: a slow pulse; finished: the alarm shakes.
  timerIcon(x, c) {
    const box = () => div().relative().size(14).flex_none().text_color(c);
    if (x.rang) return box().child(icon("alarm").size(14)).loop("left", { from: -1.5, to: 1.5, period: 140, easing: "linear" });
    if (!x.at) return box().child(icon("pause").size(14)).loop("opacity", { from: 0.35, to: 0.9, period: 1800 });
    if (x.kind === "up") return box().child(icon("stopwatch").size(14))
      // The dial's center is 2/24 below the svg's, so the hand's svg sits 14*2/24 lower.
      .child(icon("hand").size(14).absolute().top(14 * 2 / 24).left(0).spin(3000));
    return box().child(icon("hourglass").size(14)).loop("opacity", { from: 0.55, to: 1, period: 2000 });
  }

  renderBar() {
    const t = theme();
    const { tooltip, font } = opts();
    const now = Date.now();
    const ch = font ? CH_MONO : CH_UI;
    const sep = () => div().text_color(t.border).child("|");

    const timerEls = timers().flatMap((x) => {
      const done = x.rang, paused = !x.at && !done;
      const c = done ? t.blocked : paused ? t.dim : t.accent;
      const what = nameOf(x);
      const text = timerText(x, now);
      const chip = h_flex().id(`tm-${x.id}`).relative().gap(5).items_center().flex_none().cursor_pointer()
        .tooltip(`${what} · ${x.kind === "up" ? "stopwatch" : `${lengthOf(x.ms)} timer`} · set by ${whoOf(x)} · ${done ? "done · click to dismiss" : `click to ${paused ? "resume" : "pause"}`}`)
        .on_click((_e, cx) => { toggleTimer(x.id); this.fit(); cx.notify(); })
        .child(this.timerIcon(x, c))
        .child(div().text_color(c).child(text))
        .when(Boolean(x.msg), (el) => el.child(div().text_color(done ? t.blocked : t.muted).child(short(x.msg))))
        // Set by an agent: its program's icon (or a bot) so it reads at a glance.
        .when(Boolean(x.by), (el) => el.child(agentMark(x.by, 12, t.dim)));
      // A running countdown drains a thin bar under its time, smoothly.
      if (x.kind === "down" && !done) {
        const w = textWidth(text, ch) * (remaining(x, now) / x.ms);
        chip.child(div().absolute().left(19).bottom(-4).h(2).rounded(1).bg(c).opacity(paused ? 0.35 : 0.7)
          .w(Math.max(0, w)).transition("width", { duration: TICK_MS, easing: "linear" }));
      }
      return [
        done ? chip.loop("opacity", { from: 0.45, to: 1, period: 700 }) : chip,
        div().id(`tx-${x.id}`).flex_none().cursor_pointer().text_color(t.dim).tooltip("remove")
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { removeTimer(x.id); this.fit(); cx.notify(); })
          .child(icon("x").size(11)),
      ];
    });

    return h_flex().size_full().pl(14).pr(6).gap(GAP).items_center().whitespace_nowrap().overflow_hidden()
      .bg(glass(t.background)).border_t(1).border_color(t.border).text_size(11.8)
      .when(Boolean(font), (el) => el.font_family(font))
      .child(h_flex().id("time").gap(GAP).items_center().flex_none()
        .when(Boolean(tooltip), (el) => el.tooltip(strftime(tooltip, new Date(now))))
        .children(pieces(strftime(opts().format, new Date(now))).map((p) => p.sep
          ? sep()
          : div().text_color(p.bright ? t.foreground : t.muted).child(p.text))))
      .child(sep())
      .children(timerEls)
      .child(div().id("tm-new").flex_none().cursor_pointer().text_color(t.dim).tooltip("new timer")
        .hover((s) => s.text_color(t.accent))
        .on_click(() => openNew())
        .child(icon("plus").size(13)));
  }

  // --- New timer dialog ------------------------------------------------------

  initNew(cx) {
    this.err = "";
    this.msg = InputState.new({ placeholder: "Tea is ready (optional)" });
    this.len = InputState.new({ placeholder: "25m, 90s, 1h30m" });
    this.msg.on("submit", (_e, cx) => { this.len.focus(); cx.notify(); });
    this.len.on("submit", (_e, cx) => { this.start(); cx.notify(); });
    this.len.on("change", (_e, cx) => { this.err = ""; cx.notify(); });
    this.msg.focus();
    cx.timer.after(300, () => this.msg.focus());
    this.handle = cx.focus_handle();
  }

  close() { closeOverlay(props().overlay); }

  start(ms) {
    const len = ms ?? parseDuration(this.len.value());
    if (!len) { this.err = "Try 25m, 90s, 1h30m or a number of minutes."; return; }
    addTimer("down", len, this.msg.value());
    this.close();
  }

  renderNew() {
    const t = theme();
    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const field = (state) => Input.new(state).h(34).px(10).rounded(9).border_1().border_color(t.input).bg(t.background).text_size(12.8).text_color(t.foreground);
    return v_flex().id("time-new").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .size_full().p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(8)
        .child(div().text_color(t.accent).child(icon("hourglass").size(16)))
        .child(div().flex_1().text_size(15).font_semibold().child("New timer"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(label("Message"))
      .child(field(this.msg))
      .child(label("Length"))
      .child(field(this.len))
      .child(this.err ? div().pt(6).text_size(11.5).text_color(t.blocked).child(this.err) : div().pt(6).text_size(11.5).text_color(t.dim).child("Enter starts it."))
      .child(h_flex().pt(12).gap(6).flex_wrap()
        .children(opts().presets.map((m) => button(t, `tn-${m}`, lengthOf(m * 60000), false, () => this.start(m * 60000)))))
      .child(div().flex_1())
      .child(h_flex().pt(14).gap(8).justify_end()
        .child(button(t, "tn-up", "Stopwatch", false, () => { addTimer("up", 0, this.msg.value()); this.close(); }))
        .child(button(t, "tn-go", "Start", true, () => this.start())));
  }

  // --- Flash banner ----------------------------------------------------------

  initFlash(cx) {
    this.handle = cx.focus_handle();
    cx.timer.after(50, () => this.handle.focus());
    cx.timer.every(500, (cx) => {
      if (!timers().some((x) => x.rang)) this.close(); else cx.notify();
    });
  }

  renderFlash() {
    const t = theme();
    const done = timers().filter((x) => x.rang);
    const at = (ms) => (ms ? strftime("%H:%M", new Date(ms)) : "");
    const row = (x) => h_flex().id(`fl-${x.id}`).gap(14).px(18).h(74).items_center()
      .child(div().relative().size(26).flex_none().text_color(t.blocked)
        .child(icon("alarm").size(26))
        .loop("left", { from: -2, to: 2, period: 120, easing: "linear" }))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(16).font_semibold().text_color(t.foreground).truncate().child(nameOf(x)))
        .child(h_flex().gap(5).items_center().text_size(11.5).text_color(t.dim).overflow_hidden()
          .child(div().flex_none().child("set by"))
          .when(Boolean(x.by), (el) => el.child(agentMark(x.by, 12, t.muted))
            .child(div().flex_none().text_color(t.foreground).child(x.by?.name ?? ""))
            .child(div().truncate().child(`in ${x.by?.space} › ${x.by?.tab}`)))
          .when(!x.by, (el) => el.child(div().text_color(t.foreground).child("you"))))
        .child(div().text_size(11.5).text_color(t.dim).child(
          `${x.kind === "up" ? "stopwatch" : `${lengthOf(x.ms)} timer`} · done at ${at(x.doneAt)}`)))
      .when(Boolean(x.by), (el) => el.child(button(t, `fg-${x.id}`, "Go", false, () => run("pane.focus", { terminal: x.by.terminal }))))
      .child(button(t, `fs-${x.id}`, `+${lengthOf(SNOOZE_MS)}`, false, () => snooze(x.id)))
      .child(button(t, `fd-${x.id}`, "Dismiss", true, () => removeTimer(x.id)));

    return v_flex().id("time-flash").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { dismissDone(); this.close(); cx.stop_propagation(); } })
      .relative().size_full().rounded(14).overflow_hidden().bg(t.popover).border_2().border_color(t.blocked)
      .text_color(t.foreground)
      // The flash: a layer of the alarm color pulsing over the card.
      .child(div().absolute().top(0).left(0).size_full().bg(t.blocked).loop("opacity", { from: 0.03, to: 0.2, period: 900 }))
      .child(h_flex().px(18).pt(14).pb(4).items_center()
        .child(div().flex_1().text_size(12).font_semibold().text_color(t.blocked).child(done.length > 1 ? `${done.length} timers are up` : "Time's up"))
        .child(div().text_size(11).text_color(t.dim).child("Esc dismisses all")))
      .children(done.slice(0, 4).map(row))
      .when(done.length > 4, (el) => el.child(div().px(18).text_size(11.5).text_color(t.dim).child(`and ${done.length - 4} more`)));
  }
}
