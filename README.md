# herdr-time

A Herdr desktop app mod for the left end of the status bar: the date and time in any format you like, plus stopwatches and countdowns with messages. A finished countdown flashes a banner until you dismiss or snooze it.

![Time](preview.png)

## Install

Ask your agent: `Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/ryanthedev/herdr-time`

Or by hand: `scripts/install.sh` copies `mods/time` (with its icons) into `~/.config/herdr-app/mods/time` and runs `herdr-app check`. Then place it in your layout (below). [RECIPE.md](RECIPE.md) is the full brief for rebuilding it.

- `mods/time/`: the mod (`main.js`, `mod.json`, `icons/`).
- `scripts/demo-setup.sh`, `scripts/fake-agent.sh`: a throwaway demo space for screenshots in an isolated window.

## Timers

![Timers in the bar](docs/bar.png)

- **Add:** click `+` for the New timer dialog: an optional message, a length (`25m`, `90s`, `1h30m`, or a number of minutes) or a preset, or a stopwatch.
- **How many:** as many as you like. The bar widens to fit them; the message shows next to each one, shortened to 18 characters.
- **Pause / resume:** click the timer. **Remove:** its `×`.
- **Icons move:** a running stopwatch's hand sweeps, a running countdown's hourglass breathes and a bar under its time drains as it runs, a paused timer pulses slowly, a finished one shakes.
- **When a countdown ends:** it turns red and shakes in the bar, a Herdr notification is posted, a chime plays (macOS), and a banner flashes in the middle of the window with every finished timer's message. Each row has **+5m** (snooze) and **Dismiss**; Esc dismisses them all. The banner closes itself once none are left.
- **Kept:** timers live in Herdr's shared state (`time.timers`), so they survive reloads and app restarts. A countdown that ended while Herdr was closed flashes when it opens.

![New timer](docs/new.png) ![Time's up](docs/flash.png)

Key commands, for `keys.json` (`"alt-t": "time:new"`) or `herdr-app do time.<command>`:

| Command | Does |
|---|---|
| `new` | open the New timer dialog |
| `stopwatch [message]` | start a stopwatch |
| `timer-<length> [message]` | start a countdown, e.g. `timer-25m Tea is ready`, `timer-90s`, `timer-1h30m` |
| `toggle` | pause or resume the newest timer |
| `pause-all` / `resume-all` | pause or resume every timer |
| `dismiss` | remove every finished timer |
| `clear` | remove every timer |

## Format

Set in the layout block's props (all optional):

```json
{ "id": "time", "type": "block",
  "content": { "mod": "time", "props": {
    "format":  "%a %-d %b %Y-%m-%d | [%H:%M:%S]",
    "tooltip": "%A %-d %B %Y · week %V · day %j · UTC%z",
    "presets": [1, 5, 15, 25, 60],
    "font":    "BerkeleyMono Nerd Font",
    "block":   "time" } } }
```

- **Tokens** (strftime style): `%a` Wed, `%A` Wednesday, `%b` Nov, `%B` November, `%d` day, `%e` space-padded day, `%m` month, `%y` 26, `%Y` 2026, `%H` 00-23, `%I` 01-12, `%p` AM/PM, `%M` minutes, `%S` seconds, `%s` Unix seconds, `%j` day of year, `%V` ISO week, `%u` weekday 1-7, `%w` weekday 0-6, `%z` UTC offset, `%%` a percent sign. `%-d`, `%-m`, `%-H`, `%-I`, `%-j`, `%-V` drop the leading zero.
- **`|`** draws a dim separator. **`[...]`** draws its text bright; the rest is muted.
- **`presets`** are the countdown lengths (minutes) the dialog offers.
- **`font`** is the font family. Left out, it uses your terminals' font (monospaced), so digits keep their width and the bar doesn't shift each second. `""` uses the app's UI font.
- **`block`** is this block's layout id. The mod resizes it to fit as timers come and go.

## Placing it

`mod.json` uses `"place": "none"`, so the layout decides where it shows. Wrap your layout's bottom `status` block in a row with this block first:

```json
{ "id": "status-bar", "type": "row", "size": { "px": 28 }, "resizable": false,
  "children": [ <the time block above>, { "id": "status", "type": "block", "content": { "mod": "workspace-status" } } ] }
```

Apply a changed layout with `herdr-app do layout.set '{"layout": <whole layout json>}'`.

Icons in `mods/time/icons` follow [Lucide](https://lucide.dev) (ISC).
