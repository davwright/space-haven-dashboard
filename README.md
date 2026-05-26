# Space Haven Dashboard

A live observation dashboard for [Space Haven](https://bugbyte.fi/spacehaven/)
savegames. Reads your savefile in real-time — zero game modification, zero
network calls.

![Crew view](docs/screenshots/crew.png)
![Nutrition view](docs/screenshots/nutrition.png)
![Galaxy view](docs/screenshots/galaxy.png)

## Features

- **Crew view** — Numbers-mod-style dense table. Per-crew mood, health, food,
  rest, comfort, oxygen with severity-band colors and trend arrows. Top-3
  skills with passion flames. PSI-style fixed-slot condition icon strip. Sort
  by any column. "Needs attention only" filter.
- **Nutrition view** — Stomach + belly contents as stacked nutrient bars
  (protein / carbs / fat / vitamins / toxins) per crew. "Show only crew in
  food distress" toggle. Ship-wide storage panel.
- **Galaxy view** — every star, planet, moon, and asteroid field your crew
  has ever observed. Stars colored by spectral class (O/B/A/F/G/K/M). Pan
  with mouse drag, zoom with wheel. Time slider scrubs across game days with
  tick marks for timeline events. Bodies seen in the past but not in the
  current snapshot fade to 40% with a "last seen day N" tooltip — your
  exploration history is never forgotten.
- **Live updates** — `chokidar` watches the autosave folders. The moment
  Space Haven writes a new game file, the dashboard re-parses it and pushes
  the update to the browser over Server-Sent Events.
- **Permanent local history** — every parsed save is kept forever in a SQLite
  file under `data/`. Identical re-saves are deduplicated by hashing the
  visible-body set.

## Setup

```bash
cd space-haven-dashboard
npm install
SPACE_HAVEN_SAVE_DIR="/path/to/your/world" npm start
```

`SPACE_HAVEN_SAVE_DIR` should point at the world folder that contains
`autosave1`, `autosave2`, …, `save`. On a Steam install that's typically:

- Windows: `C:\Program Files (x86)\Steam\steamapps\common\SpaceHaven\savegames\<world>\`
- The dashboard auto-probes the two most common Steam paths if you don't set
  the env var.

The server defaults to <http://localhost:4173>. Override with `PORT=…`.

## Save format compatibility

Tested against Space Haven Alpha 19 saves (the `<starmap><systems><l><bodies>`
schema with `<info isVisible="…">` flags). If Bugbyte rev the save format the
parser may need a small update — see `src/parse-save.js` and the layout
comment at the top.

## How history works

Space Haven autosaves more often than the world state actually changes, and
the latest save is *not* the only thing you care about — what you saw three
game-days ago matters too.

This dashboard treats every parsed save as a permanent **snapshot**.
Snapshots live in `data/history.db` (a single SQLite file, via `better-sqlite3`
or the Node 22 built-in `node:sqlite`). Each snapshot records:

- the game day (highest `day` in `timeline.xml`)
- every visible celestial body
- every observed non-player ship (galaxy fleets + standalone `ships/*.xml`)
- the full per-crew state (vitals, conditions, skills, jobs, relationships,
  nutrition)
- a coarse ship-storage roll-up (item counts by `elementaryId`)
- the timeline events known at that point

The **fog of war** falls out naturally: when the slider sits at day N, a body
is rendered if it was visible in *any* snapshot at or before day N. Bodies
visible earlier but not in the chosen snapshot fade.

## Game data lookup

The dashboard reads `library/texts` and `library/haven` from your installed
`spacehaven.jar` to translate the game's numeric ids into human names
(`#2668` becomes "Fatty acids deficiency"). This applies to crew conditions,
traits, attributes, ship storage items and faction names.

- The import runs **automatically on startup** if the library has never been
  imported, or if Bugbyte has shipped a game update (detected by jar mtime).
- You can manually force a refresh with:

  ```bash
  npm run import-library
  ```

- If `spacehaven.jar` isn't found in the usual Steam locations, the dashboard
  logs a warning and continues — every id just renders as `#1582` etc. Set
  `SPACE_HAVEN_JAR_PATH=/your/path/to/spacehaven.jar` if your install lives
  somewhere non-standard.
- The dashboard does **not** redistribute Bugbyte's data. The library is read
  on your own machine from your own copy of the game on first run, and the
  resulting names live in your local `data/history.db`.

English is the only display language at present. The import does capture all
13 language columns, so a future language switcher only needs UI work.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/status` | save root, snapshot count, day range |
| GET | `/history/days` | every snapshot (id, game_day, real_timestamp) |
| GET | `/history/snapshot/:day` | full fog-of-war state at the nearest snapshot ≤ `:day` |
| GET | `/history/crew` | per-crew vital series across all snapshots |
| GET | `/history/timeline-ticks` | unique `(day, type)` timeline events |
| GET | `/events` | SSE stream; `snapshot` event on new ingest |

## Design credits

The crew, nutrition, and galaxy views were designed by stealing shamelessly
from the long and excellent tradition of RimWorld community UI:

- **[Numbers](https://steamcommunity.com/sharedfiles/filedetails/?id=1414302321)**
  — the dense, sortable, configurable-column colonist grid.
- **[Pawn State Icons (PSI)](https://steamcommunity.com/sharedfiles/filedetails/?id=2625909452)**
  — fixed-width status icon strips that keep rows aligned for fast scanning.
- **[CM Color Coded Mood Bar](https://steamcommunity.com/sharedfiles/filedetails/?id=1551123140)**
  — six discrete mood-severity colors, not a continuous gradient.
- **[ResearchPal](https://steamcommunity.com/workshop/filedetails/?id=946390822)**
  — clean tree layout, hover tooltips that explain everything, dark
  background with cyan accents.

If you build a similar tool for another game, please steal from these too.

## Contributing

PRs welcome. Most of what was previously hand-maintained — condition,
attribute, item, trait, faction names — is now resolved automatically from
the game's own `library/` data (see "Game data lookup" above). The one
remaining manual lookup is skills: the `<s sk="N">` ids in saves don't map
cleanly to anything in `library/haven`, so `src/lookups.js#skillInfo` still
returns `Skill #N` placeholders. If you find a reliable mapping, please open
an issue or PR.

## Live streaming

The dashboard is being moved from "poll the savefile" to "stream from the
running game." The browser is now built around a small path-binding
framework (`public/state.js`) so future patch frames can route surgically
to the right DOM nodes without a full re-render. The current SSE `snapshot`
event still drives most tabs; the Status tab has been migrated as the
proof-of-concept.

- Architecture and protocol: [`docs/live-streaming-design.md`](docs/live-streaming-design.md)
- Background research: [`docs/streaming-research.md`](docs/streaming-research.md)

## Tests

```bash
npm test
```

Tests are real-shape XML fixtures under `test/fixtures/`. No game install
required to run them.

## License

MIT — see `LICENSE`.
