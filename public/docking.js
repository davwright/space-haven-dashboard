"use strict";

// =============================================================================
//  Docking workspace host (dockview-core integration).
//
//  Loaded as a plain script; the dockview module is loaded separately as an
//  ESM module that assigns itself to window.Dockview before bootDocking runs.
//
//  Bridge:
//    - One dockview "component" handler ("sh-widget") for every widget. The
//      panel params carry { widgetId, params } so we know what to mount.
//    - On panel add: SH.mountWidget into the panel's element.
//    - On panel removal: SH.unmountWidget.
//    - Layout persisted to localStorage on every change. Hydrated on boot;
//      if absent, workspaces.default.json is fetched and installed.
// =============================================================================

(function () {
  const LS_KEY = "sh.workspaces";
  const DEFAULTS_URL = "workspaces.default.json";

  let api = null;          // DockviewApi handle
  let active = null;       // active workspace { id, name, dockviewLayout? }
  let workspaces = null;   // [{ id, name, dockviewLayout?, tree? }]
  let saveTimer = null;
  let panelSeq = 0;

  // ----- Persistence -----

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schemaVersion !== 1) return null;
      return parsed;
    } catch (e) {
      console.warn("workspaces: bad localStorage payload, ignoring", e);
      return null;
    }
  }

  function persist() {
    if (!workspaces) return;
    // Capture the current dockview layout into the active workspace.
    if (api && active) {
      try { active.dockviewLayout = api.toJSON(); }
      catch (e) { console.error("toJSON failed", e); }
    }
    const payload = {
      schemaVersion: 1,
      workspaces,
      active: active ? active.id : null,
    };
    try { localStorage.setItem(LS_KEY, JSON.stringify(payload)); }
    catch (e) { console.error("workspaces persist failed", e); }
  }

  function schedulePersist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; persist(); }, 200);
  }

  // ----- Panel content factory -----

  // Every dockview panel runs through one component class — it just delegates
  // to SH.mountWidget. The panel's `params` carries the widget id + widget
  // params; the panel id doubles as the widget nodeId.
  class WidgetPanel {
    constructor() {
      this.element = document.createElement("div");
      this.element.className = "sh-panel-content";
      this._nodeId = null;
    }
    init(params) {
      // dockview gives us { params, api, ... }. params.params is the panel's
      // user params (we stuffed { widgetId, widgetParams } in there).
      const p = (params && params.params) || {};
      const widgetId = p.widgetId;
      const widgetParams = p.widgetParams || {};
      // params.api.id is the panel id we used at addPanel time.
      this._nodeId = (params.api && params.api.id) || ("panel-" + (++panelSeq));
      if (!widgetId) {
        this.element.innerHTML = `<div class="widget-error">Panel has no widgetId in params.</div>`;
        return;
      }
      SH.mountWidget(widgetId, this.element, widgetParams, this._nodeId);
    }
    dispose() {
      if (this._nodeId) SH.unmountWidget(this._nodeId);
    }
  }

  // ----- Tree → dockview installer (for default workspaces) -----

  // Our default-workspace schema is a recursive `tree` with tabgroups and
  // splits. Dockview's preferred entry path is addPanel. For phase 1 we only
  // ship tabgroup-only defaults, so this walker just adds tabs in order.
  // Splits in defaults are deferred to phase 3+ — by then users will have
  // accumulated their own layouts anyway.
  function installTreeAsPanels(ws) {
    if (!api || !ws.tree) return;
    let count = 0;
    function walk(node) {
      if (!node) return;
      if (node.type === "tabgroup") {
        for (const tab of node.tabs || []) {
          count++;
          const pid = `${ws.id}-${tab.widget}-${count}`;
          api.addPanel({
            id: pid,
            component: "sh-widget",
            title: widgetTitle(tab.widget),
            params: { widgetId: tab.widget, widgetParams: tab.params || {} },
          });
        }
      } else if (node.type === "split") {
        // For now flatten — phase 3+ implements real splits.
        walk(node.a);
        walk(node.b);
      }
    }
    walk(ws.tree);
  }

  function widgetTitle(widgetId) {
    const defs = SH.listWidgets ? SH.listWidgets() : [];
    const def = defs.find((d) => d.id === widgetId);
    return (def && def.name) || widgetId;
  }

  // ----- Boot -----

  async function bootDocking() {
    const host = document.getElementById("workspace-host");
    if (!host) {
      console.error("bootDocking: #workspace-host not found");
      return;
    }
    if (!window.Dockview || typeof window.Dockview.createDockview !== "function") {
      console.error("bootDocking: dockview-core not loaded (window.Dockview missing)");
      host.innerHTML = `<div class="widget-error">Dockview failed to load. Check the browser console.</div>`;
      return;
    }

    api = window.Dockview.createDockview(host, {
      className: "dockview-theme-dark sh-dockview",
      createComponent: (opts) => {
        // opts: { id, name }. We only handle "sh-widget".
        if (opts.name === "sh-widget") return new WidgetPanel();
        // Fallback that never throws — shows the error inside the panel.
        const fallback = new WidgetPanel();
        fallback.element.innerHTML = `<div class="widget-error">Unknown panel component: ${opts.name}</div>`;
        return fallback;
      },
    });

    // Persist on any layout change. dockview fires a single onDidLayoutChange
    // for adds, removes, drags, splits and tab moves.
    if (typeof api.onDidLayoutChange === "function") {
      api.onDidLayoutChange(() => schedulePersist());
    }
    // Also catch panel removals so we tear down the widget. Dockview will
    // call dispose() on our WidgetPanel automatically, which unmounts; this
    // is belt-and-braces.
    if (typeof api.onDidRemovePanel === "function") {
      api.onDidRemovePanel(() => schedulePersist());
    }
    if (typeof api.onDidAddPanel === "function") {
      api.onDidAddPanel(() => schedulePersist());
    }

    // Hydrate from localStorage; fall back to default presets.
    const stored = loadState();
    if (stored && Array.isArray(stored.workspaces) && stored.workspaces.length) {
      workspaces = stored.workspaces;
      active = workspaces.find((w) => w.id === stored.active) || workspaces[0];
    } else {
      try {
        const r = await fetch(DEFAULTS_URL, { cache: "no-cache" });
        const defaults = await r.json();
        workspaces = defaults.workspaces || [];
        active = workspaces.find((w) => w.id === defaults.active) || workspaces[0];
      } catch (e) {
        console.error("failed to load default workspaces", e);
        workspaces = [];
        active = null;
      }
    }

    if (active) {
      if (active.dockviewLayout) {
        try { api.fromJSON(active.dockviewLayout); }
        catch (e) {
          console.error("fromJSON failed; falling back to tree install", e);
          installTreeAsPanels(active);
        }
      } else if (active.tree) {
        installTreeAsPanels(active);
      }
    }
  }

  function getActiveWorkspace() { return active; }
  function getWorkspaces() { return workspaces; }

  // Widgets with rich internal state (collapsed sections, custom orders, etc.)
  // call this when their `ctx.params` mutate so the new values are pushed into
  // the dockview panel — `api.toJSON()` then captures them on the next save.
  function persistWidgetParams(nodeId, params) {
    if (!api || !nodeId) return;
    const panel = api.getPanel ? api.getPanel(nodeId) : null;
    if (!panel) return;
    // dockview's panel.params shape is { widgetId, widgetParams }. Swap in
    // the new widgetParams; updateParameters re-fires the params event and
    // marks the layout dirty so the next toJSON() includes them.
    try {
      const cur = (panel.params && typeof panel.params === "object") ? panel.params : {};
      panel.api.updateParameters({ ...cur, widgetParams: params });
      schedulePersist();
    } catch (e) {
      console.warn("persistWidgetParams failed", e);
    }
  }

  SH.bootDocking = bootDocking;
  SH.getActiveWorkspace = getActiveWorkspace;
  SH.getWorkspaces = getWorkspaces;
  SH.persistWidgetParams = persistWidgetParams;
  // Test hook: lets the rest of the app force a save.
  SH.persistWorkspaces = persist;
})();
