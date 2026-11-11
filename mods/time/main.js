import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout, props, shared, setShared, nextCommand, notify, exec, run, window, settings } from "herdr";

// Time: a date/time line for the left end of the status bar, in any format.
//
// The format is a strftime-style template in the layout block's props:
//   { "mod": "time", "props": { "format": "%a %-d %b %Y-%m-%d | %s | [%H:%M:%S]" } }
// - `%x` tokens: see TOKENS below (`%-d` drops the leading zero, `%%` is a %).
// - `|` draws a dim separator.
// - `[...]` draws its text bright; everything else is muted.
// - `tooltip` (optional) is a second template shown on hover.
// - `presets` (optional) are the timer lengths the + picker offers, in minutes.
// - `font` (optional) is the font family. It defaults to the terminals' font
//   (settings() `font_family`), which is monospaced, so digits keep their width and the
//   bar doesn't shift every second. `""` uses the app's UI font instead.
// - `block` (optional, default "time") is this block's layout id, so the mod can
//   widen or narrow it as timers come and go.
//
// Timers (shared "time.timers", so they survive reloads and restarts): + opens
// a picker (stopwatch or a countdown preset). Click a timer to pause or resume
// it, × removes it. A finished countdown pulses, posts a notification and plays
// a sound; click it to dismiss. Key commands ("alt-t": "time:timer-25m" in
// keys.json, or `herdr-app do time.<command>`): stopwatch, timer-<n>s|m|h,
// toggle (pause/resume the newest), pause-all, resume-all, clear.
//
// The layout puts this block beside the status bar mod in one 28px row, so it paints
// the same ground and top border to read as one bar.
//
// Cost: a 1-second timer that redraws only when the text changes.

const TICK_MS = 1000;
const DEFAULT_FORMAT = "%a %-d %b %Y-%m-%d | %s | [%H:%M:%S]";
const DEFAULT_TOOLTIP = "%A %-d %B %Y · week %V · day %j · UTC%z";
const DEFAULT_PRESETS = [1, 5, 15, 25, 60];
const TIMERS = "time.timers";
const SOUND = "/System/Library/Sounds/Glass.aiff";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n, w = 2) => String(n).padStart(w, "0");

// Same ground as the shipped workspace-status bar: the theme background at the layout's terminal_opacity.
const glass = (c) => {
  const op = Math.max(0, Math.min(1, Number(layout()?.terminal_opacity ?? 1))), a = 1 - (1 - op) ** 2;
  return /^#[0-9a-f]{6}$/i.test(c ?? "") ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c;
};

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
//   current start), at (start time, null while paused), rang (finished) }

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
const lengthOf = (ms) => clockOf(ms).replace(/^0:/, "") + (ms < 60000 ? "s" : "");

// "timer-90s", "timer-25m", "timer-1h" -> ms.
export function parseLength(cmd) {
  const m = /^timer-(\d+(?:\.\d+)?)([smh])$/.exec(cmd);
  return m ? Math.round(Number(m[1]) * { s: 1000, m: 60000, h: 3600000 }[m[2]]) : null;
}

function addTimer(kind, ms = 0) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  saveTimers([...timers(), { id, kind, ms, acc: 0, at: Date.now(), rang: false }]);
}
function toggleTimer(id) {
  const now = Date.now();
  saveTimers(timers().flatMap((x) => {
    if (x.id !== id) return [x];
    if (x.rang) return [];                                   // finished: dismiss
    return [x.at ? { ...x, acc: elapsed(x, now), at: null } : { ...x, at: now }];
  }));
}
const removeTimer = (id) => saveTimers(timers().filter((x) => x.id !== id));
const setAll = (running) => {
  const now = Date.now();
  saveTimers(timers().map((x) => (x.rang ? x : running ? (x.at ? x : { ...x, at: now }) : (x.at ? { ...x, acc: elapsed(x, now), at: null } : x))));
};

// Rough width of the bar's text at its 11.8px size; the layout block is resized
// to fit, so it never clips and never leaves a hole.
// A monospaced font at this size is about 0.6em per character.
const CH_UI = 6.3, CH_MONO = 7.2, ICON = 15, GAP = 8;
const textWidth = (t, ch) => [...t].reduce((a, c) => a + (c.codePointAt(0) > 0x2000 ? ICON : ch), 0);
const widthOf = (texts, ch) => Math.ceil(14 + 6 + texts.reduce((a, t) => a + textWidth(t, ch), 0) + Math.max(0, texts.length - 1) * GAP);

export default class Time extends View {
  init(_props, cx) {
    this.shown = ""; this.picking = false; this.width = 0;
    this.tick(cx);
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        this.command(await nextCommand());
        this.tick(cx); cx.notify();
      }
    });
  }

  command(c) {
    const ms = parseLength(c);
    if (ms) addTimer("down", ms);
    else if (c === "stopwatch") addTimer("up");
    else if (c === "toggle") { const last = timers().filter((x) => !x.rang).at(-1); if (last) toggleTimer(last.id); }
    else if (c === "pause-all") setAll(false);
    else if (c === "resume-all") setAll(true);
    else if (c === "clear") saveTimers([]);
    else if (c === "pick") this.picking = !this.picking;
  }

  tick(cx) {
    const now = Date.now();
    // Countdowns that just ran out: mark, announce, ring.
    const list = timers();
    const due = list.filter((x) => x.kind === "down" && !x.rang && remaining(x, now) === 0);
    if (due.length) {
      saveTimers(list.map((x) => (due.includes(x) ? { ...x, rang: true, acc: x.ms, at: null } : x)));
      for (const x of due) notify({ title: "Timer done", body: `${lengthOf(x.ms)} timer finished`, level: "success" });
      if (window()?.platform === "macos") cx.spawn(async () => { try { await exec("afplay", [SOUND], { timeout: 5000 }); } catch { /* no sound */ } });
    }
    const shown = [strftime(opts().format, new Date(now)), ...timers().map((x) => `${x.id}${x.at ? "" : "p"}${x.rang ? "r" : ""}${timerText(x, now)}`), this.picking].join("|");
    if (shown !== this.shown) { this.shown = shown; cx.notify(); }
    this.fit();
  }

  // Everything the bar shows as text, for widthOf().
  texts() {
    const now = Date.now();
    const clock = pieces(strftime(opts().format, new Date(now))).map((p) => (p.sep ? "|" : p.text));
    const ts = timers().flatMap((x) => [`⏱ ${timerText(x, now)}${x.at || x.rang ? "" : " ❚❚"}`, "×"]);
    const picker = this.picking ? ["⏱", ...opts().presets.map((m) => `${m}m`), "×"] : ["+"];
    return [...clock, "|", ...ts, ...picker];
  }

  fit() {
    const px = widthOf(this.texts(), opts().font ? CH_MONO : CH_UI);
    if (Math.abs(px - this.width) >= 4) {
      this.width = px;
      run("layout.resize", { id: opts().block, px });
    }
  }

  render() {
    const t = theme();
    const { tooltip, presets, font } = opts();
    const now = Date.now();
    const sep = () => div().text_color(t.border).child("|");
    const chip = (id, label, c, tip, onClick) => div().id(id).flex_none().cursor_pointer().text_color(c)
      .tooltip(tip).on_click((_e, cx) => { onClick(); this.fit(); cx.notify(); }).child(label);

    const timerEls = timers().flatMap((x) => {
      const done = x.rang, paused = !x.at && !done;
      const c = done ? t.blocked : paused ? t.dim : t.accent;
      const icon = x.kind === "up" ? "⏱" : done ? "⏰" : "⏳";
      const what = x.kind === "up" ? "stopwatch" : `${lengthOf(x.ms)} timer`;
      const label = h_flex().id(`tm-${x.id}`).gap(4).items_center().flex_none().cursor_pointer().text_color(c)
        .tooltip(done ? `${what} done · click to dismiss` : `${what} · click to ${paused ? "resume" : "pause"}`)
        .on_click((_e, cx) => { toggleTimer(x.id); this.picking = false; this.fit(); cx.notify(); })
        .child(icon).child(timerText(x, now) + (paused ? " ❚❚" : ""));
      return [
        done ? label.loop("opacity", { from: 0.35, to: 1, period: 900 }) : label,
        chip(`tx-${x.id}`, "×", t.dim, "remove", () => removeTimer(x.id)),
      ];
    });

    const pickerEls = this.picking
      ? [
          chip("pk-up", "⏱", t.foreground, "start a stopwatch", () => { addTimer("up"); this.picking = false; }),
          ...presets.map((m) => chip(`pk-${m}`, `${m}m`, t.foreground, `start a ${m}-minute timer`, () => { addTimer("down", m * 60000); this.picking = false; })),
          chip("pk-x", "×", t.dim, "close", () => { this.picking = false; }),
        ]
      : [chip("pk-open", "+", t.dim, "add a timer", () => { this.picking = true; })];

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
      .children(pickerEls);
  }
}
