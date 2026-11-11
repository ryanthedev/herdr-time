# Time

A clock and timers at the left end of the status bar. The date and time tick every second in any strftime-style format; beside them sit stopwatches and countdowns, each with an optional message and an animated icon. A finished countdown shakes in the bar and flashes a banner in the middle of the window until it is dismissed or snoozed.

![Time](preview.png)

## What you see

**The bar**: one 28px strip drawn by the mod `time` in a block placed just before the existing status bar mod.

- **Clock**: `Wed 11 Nov 2026-11-11 | 14:55:54` by default, 11.8px in the terminals' font (monospaced, so digits never change width and nothing shifts each second). Plain text is the theme's `muted`, `[bracketed]` parts `foreground`, `|` a separator in `border`. Hover: `Wednesday 11 November 2026 · week 46 · day 315 · UTC-0600`.
- **A `|` separator**, then each **timer**: a 14px icon, its time (`m:ss`, or `h:mm:ss` from an hour), its message (`muted`, cut to 18 characters with …), then an 11px `×` in `dim`.
  - Running stopwatch: stopwatch icon whose hand sweeps once every 3s; `accent`.
  - Running countdown: hourglass breathing (opacity 0.55 to 1, 2s); `accent`. A 2px bar under the time drains from full to empty, its width eased linearly over each second. Countdowns round up, so 0:00 only shows when done.
  - Paused: pause icon pulsing slowly (0.35 to 0.9, 1.8s); `dim`; the drain bar stays, dimmer.
  - Finished: alarm-clock icon shaking (left ±1.5px every 140ms), the whole timer blinking (0.45 to 1, 700ms); `blocked`.
- **`+`** (13px plus icon, `dim`, `accent` on hover) opens the dialog.
- **Ground**: the theme background at the layout's terminal opacity, a 1px top border, as the shipped `workspace-status` bar draws, so the two blocks read as one bar.

**The New timer dialog** (400×330, centered, dims the window, `popover` background): an hourglass and "New timer", Esc on the right; a Message input ("Tea is ready (optional)"); a Length input ("25m, 90s, 1h30m"); a hint "Enter starts it." that turns into a `blocked` error for a bad length; preset buttons `1m 5m 15m 25m 1h`; Stopwatch and Start (primary) at the bottom right.

**The banner** (460 wide, 64 + 58 per finished timer up to four, a frameless window in the middle of the window): rounded 14px, `popover` with a 2px `blocked` border and a `blocked` layer pulsing over it (opacity 0.03 to 0.2, 900ms). Header "Time's up" (or "2 timers are up") in `blocked`, "Esc dismisses all" on the right. One row per finished timer: a 26px alarm icon shaking ±2px, the message (or "25m timer") at 16px semibold, "25m timer · done at 14:55" under it, then **+5m** and **Dismiss** (primary). Beyond four: "and N more".

## How it behaves

- **Click a timer**: pause or resume; on a finished one, dismiss. **Click its ×**: remove it.
- **Dialog**: Enter in Message moves to Length; Enter in Length or Start starts the countdown with the message; a preset starts that length at once; Stopwatch starts one with the message; Esc closes.
- **A countdown reaching zero** (checked every second by the bar): marked finished with its time, a Herdr notification ("Time's up", the message), `afplay /System/Library/Sounds/Glass.aiff` on macOS, and the banner opens (`openOverlay` with `key: "time-flash"`, so a second finish replaces it in place with both rows). The bar opens it on start too if any finished timer is waiting.
- **Banner**: +5m removes the timer and starts a 5-minute countdown with the same message; Dismiss removes it; Esc removes every finished timer. It checks every 500ms and closes itself once no finished timer is left. Its buttons stop the mouse-down so a click doesn't drag the window.
- **Width**: the bar resizes its own layout block (`layout.resize`) whenever its estimated content width changes by 4px or more.
- **Key commands** via `nextCommand()` (`"alt-t": "time:new"` in keys.json, or `herdr-app do time.<command>`; text after a space is the message): `new`, `stopwatch [msg]`, `timer-<length> [msg]`, `toggle` (newest unfinished), `pause-all`, `resume-all`, `dismiss`, `clear`.
- No limit on the number of timers.
- Agent statuses: not used.

## Built from

- **Layout**: the status block wrapped in a row so the clock sits to its left:
  ```json
  { "id": "status-bar", "type": "row", "size": { "px": 28 }, "resizable": false, "children": [
    { "id": "time", "type": "block", "size": { "px": 330 }, "content": { "mod": "time", "props": { "block": "time" } } },
    { "id": "status", "type": "block", "content": { "mod": "workspace-status" } } ] }
  ```
  No `divider` and no `gap` on the row: either shows a seam.
- **`mods/time/mod.json`**: `{ "place": "none", "title": "Time" }`.
- **One mod, three views** by `props().mode`: the bar (no mode), `"new"` (the dialog, opened with `openOverlay({ mod: "time", kind: "dialog", props: { mode: "new" } })`), `"flash"` (the banner, `kind: "window", frame: "none", key: "time-flash"`).
- **Bar props** (all optional): `format` (default `%a %-d %b %Y-%m-%d | [%H:%M:%S]`), `tooltip`, `presets` (minutes), `font` (default `settings().font_family`; `""` for the UI font), `block` (its layout id, default `time`).
- **Tokens**, formatted by hand from `Date` (no `Intl`): `%a %A %b %B %d %e %m %y %Y %H %I %p %M %S %s %j %V %u %w %z %%`; `%-x` drops the leading zero. `%V` is ISO 8601, `%z` from `getTimezoneOffset()`.
- **State**: shared `time.timers`, a list of `{ id, kind: "up" | "down", ms, acc, at, rang, doneAt, msg }`. Time run = `acc + (now - at)` while running; pausing folds it into `acc` and sets `at` to null. Shared state persists.
- **Icons**: `mods/time/icons/*.svg`, 24×24 Lucide-style strokes in `currentColor` (stopwatch, hand, hourglass, alarm, pause, plus, x), drawn with `svg("mods/time/icons/<name>.svg")` so they take the text color. The stopwatch hand is its own svg stacked on the body and turned with `.spin(3000)`.
- **herdr**: `theme`, `layout`, `props`, `settings`, `shared`, `setShared`, `nextCommand`, `notify`, `exec`, `run("layout.resize")`, `window`, `openOverlay`, `closeOverlay`.
- **gpui-kit / gpui-base**: `div`, `svg`, `h_flex`, `v_flex`, `InputState`, `Input`, `.spin`, `.loop`, `.transition("width")`, `.font_family`, `.tooltip`, `.on_click((e, cx) => …)`, `.on_mouse_down("left", …)`, `.track_focus`, `.on_key_down`.
- **Programs**: `afplay` (macOS only) for the chime. No network, no files outside its folder.

## Watch out

- `settings()` names the terminal font `font_family`, not `font` (settings.json's `font`). Reading `font` gets nothing and the clock falls back to the proportional UI font, where the digits jiggle every second.
- `.spin` turns an svg around its own center. The stopwatch's dial center is at y=14 of 24, so the hand's svg is drawn centered on (12,12) and placed `14 * 2/24` px lower.
- The shakes (`.loop("left", …)`) sit on `relative()` boxes; whether `left` moves a static element was not tested.
- A click handler that only changes the view's own fields must call `cx.notify()`; `setShared` re-renders by itself.
- Icons count as about 15px in the width estimate, a monospaced character about 7.2px at this size.
- A frameless `window` overlay drags on any press its controls don't stop.
- The banner only reopens on the next finish or the next start; closing it some other way (`overlay.close`) leaves finished timers in the bar.
- `"place": "none"` means the mod never starts until a layout block names it.

## Done when

- `herdr-app check mods/time` passes and `herdr-app status` lists no errors.
- The clock matches `date "+%a %-d %b %Y-%m-%d | %H:%M:%S"` and nothing to its right moves as the seconds change.
- `herdr-app do "time.timer-25m Tea is ready"` adds an hourglass, 25:00 counting down, "Tea is ready" and a draining bar; `time.stopwatch` adds a stopwatch whose hand sweeps; `time.toggle` pauses the newest (pause icon, dim).
- `herdr-app do "time.timer-3s Check the oven"` turns red and shakes after 3 seconds, posts a notification, chimes, and opens the banner with "Check the oven"; a second one finishing adds a row; `time.dismiss` closes the banner.
- `herdr-app do time.new` opens the dialog; a preset starts that timer and closes it.
