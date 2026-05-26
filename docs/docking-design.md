# Docking Workspace Design

The dashboard is becoming a configurable "ship's computer console." Users
compose their own layouts: drag a panel to dock left, right, above,
below, or *into* an existing pane (tabbed). Sliders between siblings let
you rebalance space. Hierarchical — every pane is either a tab-group of
widgets or a split with two children, recursively. Same paradigm as
VSCode, JetBrains IDEs, Tableau, JupyterLab.

## End-state UX

- One **workspace** = a tree of panes
  - Leaf pane = a tab-group of widgets
  - Internal pane = a split (horizontal or vertical) with two children
- **Drag a widget header** → drop zones appear: top/right/bottom/left of
  the target pane → split. Center → add as a new tab in the target pane.
- **Drag a slider** between two sibling panes → resize relative widths/heights
- **Right-click a tab** → close, rename, pop out to a new window (later)
- **Workspace bar** at top: multiple named workspaces (browser-tabs style);
  user creates, renames, deletes; the active workspace's tree fills the
  body
- **Widget palette** (sidebar, toggleable): drag a widget from the palette
  onto a drop zone in the workspace to add it
- All state persists to `localStorage` after every change; "Export" /
  "Import" round-trip to JSON for sharing

The current fixed tabs (Status, Skills, Nutrition, Storage, Map) go away.
Their content becomes widgets. We ship default workspaces approximating
them as starting points.

## Library: dockview-core

Why dockview-core:
- Vanilla TS, ESM-friendly, MIT
- Does exactly hierarchical drag-to-split + tab-into-pane out of the box
- Theme-able with CSS variables; matches our existing dark/cyan look
- Mature; production users (Theia, others)
- ~50 KB minified, no dependencies

Why not the others:
- **Gridstack**: free-floating grid, not hierarchical. Doesn't do split-edges.
- **golden-layout**: oldest in this space; works but feels dated, jQuery-ish.
- **Lumino (Phosphor)**: JupyterLab's; heavier, more opinionated, integrates
  best with its widget framework.
- **Roll our own**: ~1500 LOC of drag/drop/split/resize math. Not worth it.

Loading: `<script type="module" src="https://cdn.jsdelivr.net/npm/dockview-core@1/dist/dockview-core.esm.js"></script>`
plus its CSS. Pin a major version.

Caveat: dockview ships ESM-only modern bundles. Our codebase has been
strict no-build-step so far. dockview's ESM via `<script type="module">`
works without a build — confirmed by their docs. If it doesn't, fallback
is to vendor the UMD build into `public/vendor/` and load it traditionally.

## Widget contract

```js
SH.registerWidget({
  id: "crew-status",                      // stable; used in layout JSON
  name: "Crew Status",                    // palette display + default tab title
  category: "Crew",                       // palette grouping
  description: "Mood, health, food, conditions",
  icon: "🧑",                             // optional, palette decoration

  render(container, ctx) {
    // Populate container with initial DOM. Called once when widget mounted.
    // ctx = { snapshot, bindCell, applyOp, params }
    //   snapshot — current SH.tree
    //   bindCell — alias for SH.bindCell, scoped so dispose() can clean up
    //   params  — per-instance widget config (e.g. {filter: "hunger"})
  },

  update(container, ctx) {
    // Optional. Called when a new snapshot arrives if the widget hasn't
    // migrated to bindCell. Default behavior: full re-render.
  },

  dispose(container) {
    // Tear down listeners, intervals, observers, bindings. Required.
  },

  configure(container, ctx) {
    // Optional. Open an inline form to edit `params`. The host calls this
    // when the user hits the gear icon on a widget header.
  },
});
```

Notes:
- Multiple instances of the same widget id are allowed (e.g. two
  `crew-status` widgets with different `params`).
- The host generates a per-instance `nodeId` automatically; the widget
  receives it via `ctx.nodeId` only if it needs it (most don't).
- Bindings registered via `ctx.bindCell` are tracked by the host and
  cleaned up on `dispose` even if the widget forgets — but the widget
  should still call `SH.unbindCell` for non-bindCell listeners.

## Layout state

Each workspace's pane tree:

```js
SH.workspaces = [
  {
    id: "captain",
    name: "Captain's bridge",
    tree: {
      type: "split",
      direction: "horizontal",
      ratio: 0.6,                       // left 60%, right 40%
      a: {
        type: "tabgroup",
        active: 0,
        tabs: [
          { widget: "crew-status",     params: {} },
          { widget: "events-feed",     params: {} },
        ],
      },
      b: {
        type: "split",
        direction: "vertical",
        ratio: 0.7,
        a: { type: "tabgroup", active: 0, tabs: [{ widget: "map-galaxy",  params: {} }] },
        b: { type: "tabgroup", active: 0, tabs: [{ widget: "conditions",  params: {} }] },
      },
    },
  },
  ...
];
SH.activeWorkspace = "captain";
```

This matches dockview's native serialization format closely; the host
just translates between our schema and theirs.

Persisted to `localStorage` under key `sh.workspaces` after every drag/
resize/tab-change. On boot: hydrate; if missing, install default
presets.

## Default presets

Ship a small set users can start from. Names mirror Space Haven's own
profession/department concepts so the mental model carries over:

- **Captain's bridge** — Crew Status + Map + Events tab-grouped on right
- **Cook** — Food storage | Kitchen recipes | Crops growing in three
  vertical splits, plus Nutrition by crew at the bottom
- **Botany** — Crops growing (full-size) + Fertility supply + Bio matter /
  Compost flow, plus (future) Grow-bed map overlay
- **Industry** — Storage by category + Recipes (all facility types) +
  (future) Power / Atmosphere / Construction queues
- **Navigation** — Map full-screen with a tab group below for events,
  travel history, jump-edge topology
- **Spreadsheet** — Crew skills + Storage all-items side by side, dense
  Numbers-style data view

Defaults are baked into `public/workspaces.default.json` and copied into
`localStorage` on first run only. The user can reset to defaults via a
menu.

## Initial widget catalog

Decomposing the existing UI:

| Widget ID | From current tab | Notes |
|-----------|------------------|-------|
| `crew-status` | Status | The dense Numbers-grid of vitals + conditions |
| `crew-conditions` | Status | PSI-style icon strip per crew, just that |
| `crew-skills` | Skills | All 14 skills with multi-sort |
| `crew-traits-attrs` | Skills | Trait chips + Bra/Zes/Int/Per |
| `nutrition-bars` | Nutrition | Stomach/belly per crew |
| `food-storage` | Nutrition | Food items in storage with icons |
| `recipes` | Nutrition | Kitchen recipes (makeable/all toggle) |
| `crops-growing` | Nutrition | Per-bed markers + ETA |
| `fertility` | Nutrition (new) | Compost/fertilizer/bio matter/corpses |
| `storage-all` | Storage | Categorised list of every item |
| `map-galaxy` | Map | Galaxy view at top zoom |
| `map-system` | Map | System detail with orbital rings |
| `ship-position` | Map | "You are at X" current-system summary |
| `events-feed` | (new) | Day-by-day event log, click to jump slider |
| `day-slider` | (new) | Time-travel slider as its own widget |

Future (the user named these):
- `trade-prices` — per-system trader inventories
- `trade-routes` — your historical travel economics
- `cargo-manifest` — what's on your ship right now
- `mineral-inventory` — what's been mined
- `mineral-frontier` — scanned-but-unmined deposits
- `derelict-log` — derelicts encountered + their stuff
- `research-tree` — uses haven's Tech/TechTree (needs extractor extension)

## Streaming compatibility

Each widget owns its `SH.bindCell` subscriptions via `ctx.bindCell`. When
the Java agent goes live, no global change is needed: widgets that have
migrated get surgical patches; widgets that haven't, fall back to
`update(container, ctx)` on each snapshot. The streaming migration
becomes per-widget rather than per-tab, which is easier.

## Migration phases

1. **Add dockview-core** — load it, theme it, render an empty workspace
   shell. The old tabs still work side-by-side initially.
2. **Widget framework** — `SH.registerWidget`, `SH.mountWidget`,
   workspace persistence layer. Wire one widget (`crew-status`) end to
   end as a model.
3. **Extract widgets in batches** — by current tab. Each existing
   `render*` function becomes a widget's `render` + `dispose`.
4. **Workspace bar UI** — multi-workspace, create / rename / delete.
5. **Widget palette** — sidebar listing registered widgets, drag onto
   workspace.
6. **Delete the old tabs** — once all content is widgetized.
7. **Polish** — gear icon, configure dialog, export/import JSON,
   responsive (defer until needed).

Realistic effort: phases 1–2 are 1–2 sittings. Phase 3 (extracting
~10 widgets) is the bulk of the work — 2–3 sittings, batched.

## Open questions

- **dockview ESM via `<script type="module">`** — confirm it works
  without a build step at our target browsers (modern Chrome/Edge only,
  since this is a dev tool). Fallback: vendor a UMD build in
  `public/vendor/`.
- **Tab handles for the day-slider widget** — the slider is uniquely
  global state (the time-travel cursor). Decide: does it live as a
  widget, or as a workspace-level toolbar always visible? Recommend
  toolbar — it controls all widgets simultaneously.
- **What does "configure" look like?** — e.g. crew-status should let
  you toggle visibility per column. Defer the configure UI until users
  ask; for v1, widgets are unconfigured.
- **Pop-out windows?** — dockview supports floating panels. Probably
  nice for a true "secondary monitor as the engineer's console" flow.
  Defer.

## Layout schema versioning

`localStorage` payloads carry `{ schemaVersion: 1, ... }`. If we change
the schema, the bootstrap notices and either migrates (preferred) or
discards-with-warning (fallback). Users keep their workspaces across
dashboard updates.
