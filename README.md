# herdr-time

A Herdr desktop app mod for the left end of the status bar: the date and time in any format you like, plus clickable timers.

![Time](preview.png)

Top to bottom: running countdowns, a stopwatch and a paused timer; the + picker open; a finished countdown pulsing red.

## Install

Ask your agent: `Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/ryanthedev/herdr-time`

Or by hand: `scripts/install.sh` copies `mods/time` into `~/.config/herdr-app/mods/time` and runs `herdr-app check`. Then place it in your layout (below). [RECIPE.md](RECIPE.md) is the full brief for rebuilding it.

- `mods/time/`: the mod (`main.js`, `mod.json`).
- `scripts/demo-setup.sh`, `scripts/fake-agent.sh`: a throwaway demo space for screenshots in an isolated window.

## Format

Set in the layout block's props (all optional):

```json
{ "id": "time", "type": "block",
  "content": { "mod": "time", "props": {
    "format":  "%a %-d %b %Y-%m-%d | %s | [%H:%M:%S]",
    "tooltip": "%A %-d %B %Y · week %V · day %j · UTC%z",
    "presets": [1, 5, 15, 25, 60],
    "font":    "BerkeleyMono Nerd Font",
    "block":   "time" } } }
```

- **Tokens** (strftime style): `%a` Wed, `%A` Wednesday, `%b` Nov, `%B` November, `%d` day, `%e` space-padded day, `%m` month, `%y` 26, `%Y` 2026, `%H` 00-23, `%I` 01-12, `%p` AM/PM, `%M` minutes, `%S` seconds, `%s` Unix seconds, `%j` day of year, `%V` ISO week, `%u` weekday 1-7, `%w` weekday 0-6, `%z` UTC offset, `%%` a percent sign. `%-d`, `%-m`, `%-H`, `%-I`, `%-j`, `%-V` drop the leading zero.
- **`|`** draws a dim separator. **`[...]`** draws its text bright; the rest is muted.
- **`presets`** are the countdown lengths (minutes) the + picker offers.
- **`font`** is the font family. Left out, it uses your terminals' font (monospaced), so digits keep their width and the bar doesn't shift each second. `""` uses the app's UI font.
- **`block`** is this block's layout id. The mod resizes it to fit as timers come and go.

## Timers

- **Add:** click `+`, then ⏱ (stopwatch) or a preset length.
- **Pause / resume:** click the timer. A paused timer is dim with ❚❚.
- **Remove:** click its `×`.
- **Finished countdown:** turns into a pulsing red ⏰ 0:00, posts a Herdr notification and plays a sound (macOS). Click it to dismiss.
- **Kept:** timers live in Herdr's shared state (`time.timers`), so they survive reloads and app restarts.

Key commands, for `keys.json` (`"alt-t": "time:timer-25m"`) or `herdr-app do time.<command>`:

| Command | Does |
|---|---|
| `stopwatch` | start a stopwatch |
| `timer-<n>s` / `timer-<n>m` / `timer-<n>h` | start a countdown, e.g. `timer-90s`, `timer-25m`, `timer-1.5h` |
| `toggle` | pause or resume the newest timer |
| `pause-all` / `resume-all` | pause or resume every timer |
| `clear` | remove every timer |
| `pick` | open or close the + picker |

## Placing it

`mod.json` uses `"place": "none"`, so the layout decides where it shows. Wrap your layout's bottom `status` block in a row with this block first:

```json
{ "id": "status-bar", "type": "row", "size": { "px": 28 }, "resizable": false,
  "children": [ <the time block above>, { "id": "status", "type": "block", "content": { "mod": "workspace-status" } } ] }
```

Apply a changed layout with `herdr-app do layout.set '{"layout": <whole layout json>}'`.
