"use strict";

// =============================================================================
//  Widget runtime — the bridge between the SH state framework and the
//  dockview host.
//
//  A widget is a small bundle of { id, render(container, ctx), dispose(container) }.
//  The host (dockview) hands us a panel body element, we mount a widget
//  into it, and tear it down when the panel closes.
//
//  ctx.bindCell wraps SH.bindCell and tracks the bound nodes so disposal
//  can unbind them all without the widget having to remember.
// =============================================================================

(function () {
  const widgets = new Map();   // id → widget definition
  const mounted = new Map();   // nodeId → { def, container, ctx }

  function registerWidget(def) {
    if (!def || !def.id || typeof def.render !== "function" || typeof def.dispose !== "function") {
      throw new Error("widget missing id/render/dispose: " + JSON.stringify(def && def.id));
    }
    widgets.set(def.id, def);
  }

  function mountWidget(widgetId, container, params, nodeId) {
    const def = widgets.get(widgetId);
    if (!def) {
      container.innerHTML = `<div class="widget-error">Unknown widget: ${widgetId}</div>`;
      return null;
    }
    const ctx = {
      snapshot: SH.tree,
      params: params || {},
      nodeId,
      bindings: [],
      bindCell(path, node, fn) {
        SH.bindCell(path, node, fn);
        this.bindings.push({ node });
      },
    };
    container.classList.add("sh-widget");
    container.innerHTML = "";
    try {
      def.render(container, ctx);
    } catch (e) {
      console.error("widget render failed", widgetId, e);
      container.innerHTML = `<div class="widget-error">Widget ${widgetId} failed to render: ${String(e && e.message || e)}</div>`;
    }
    const handle = { def, container, ctx };
    mounted.set(nodeId, handle);
    return handle;
  }

  function updateWidget(nodeId) {
    const m = mounted.get(nodeId);
    if (!m) return;
    if (typeof m.def.update === "function") {
      m.ctx.snapshot = SH.tree;
      try { m.def.update(m.container, m.ctx); }
      catch (e) { console.error("widget update failed", m.def.id, e); }
    } else {
      // Re-render from scratch. Unbind first so we don't leak.
      const { def, container, ctx } = m;
      for (const b of ctx.bindings) SH.unbindCell(b.node);
      ctx.bindings = [];
      ctx.snapshot = SH.tree;
      container.innerHTML = "";
      try { def.render(container, ctx); }
      catch (e) {
        console.error("widget re-render failed", def.id, e);
        container.innerHTML = `<div class="widget-error">Widget ${def.id} failed to re-render: ${String(e && e.message || e)}</div>`;
      }
    }
  }

  function unmountWidget(nodeId) {
    const m = mounted.get(nodeId);
    if (!m) return;
    try { m.def.dispose(m.container); } catch (e) { console.error("dispose failed", m.def.id, e); }
    for (const b of m.ctx.bindings) SH.unbindCell(b.node);
    m.container.innerHTML = "";
    m.container.classList.remove("sh-widget");
    mounted.delete(nodeId);
  }

  function listWidgets() { return [...widgets.values()]; }
  function updateAll() { for (const id of mounted.keys()) updateWidget(id); }

  // Re-update mounted widgets whenever the tree is replaced or patched.
  if (typeof SH.onTreeReplaced === "function") SH.onTreeReplaced(updateAll);

  SH.registerWidget   = registerWidget;
  SH.mountWidget      = mountWidget;
  SH.updateWidget     = updateWidget;
  SH.unmountWidget    = unmountWidget;
  SH.listWidgets      = listWidgets;
  SH.updateAllWidgets = updateAll;
})();
