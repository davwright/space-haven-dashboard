"use strict";

// =============================================================================
//  storage-all widget — fifth migration target.
//
//  Categorised list of every non-empty storage item, grouped by main_cat_name
//  (Food, Resources, Construction, Fabric, Raw Materials, Gas/Energy, Other).
//
//  Rich internal layout per docs/docking-design.md:
//    - CSS-Grid container (auto-fill 220px+) so categories wrap based on pane
//      width — narrow pane → single column, wide pane → multi-column.
//    - Each category header is clickable (toggles a `collapsed` class hiding
//      the items list) and draggable (HTML5 DnD reorders categories).
//    - State (collapsed set + order) persists in ctx.params and is written
//      through SH.persistWidgetParams so the dockview layout serialiser
//      captures it on next save.
//    - ResizeObserver re-runs paint() on container width changes (mainly to
//      let future variants tighten the per-item layout when wide; the grid
//      itself reflows via CSS without JS).
//
//  Helpers (esc, iconImg, formatNum) live on window from app.js.
// =============================================================================

(function () {
  const STORAGE_CATEGORY_ORDER = [
    "Food", "Resources", "Construction", "Fabric", "Raw Materials", "Gas / Energy",
  ];

  function render(container, ctx) {
    container.classList.add("widget-storage-all");
    container.innerHTML = `
      <div class="sa-toolbar"><span class="muted" data-sa-count></span></div>
      <div class="sa-grid" data-sa-grid></div>
    `;
    // Normalise params so later code can assume both keys exist.
    if (!Array.isArray(ctx.params.collapsed)) ctx.params.collapsed = [];
    if (!Array.isArray(ctx.params.order)) ctx.params.order = [];

    // ResizeObserver — keeps a re-paint hook for the future "denser when wide"
    // tweak; the grid itself reflows in pure CSS so this isn't strictly needed
    // for the auto-fill columns. Disposed in dispose().
    container.__sa_ro = new ResizeObserver(() => {
      // Cheap — paint is idempotent and bounded by the snapshot data we already
      // have on ctx. We don't want the observer to fire infinite loops, so we
      // only mutate inner content (the observer watches `container`).
      paintGrid(container, ctx);
    });
    container.__sa_ro.observe(container);

    paintGrid(container, ctx);
  }

  function update(container, ctx) {
    // Snapshot changed — repaint, but keep params (collapsed/order) intact.
    if (!Array.isArray(ctx.params.collapsed)) ctx.params.collapsed = [];
    if (!Array.isArray(ctx.params.order)) ctx.params.order = [];
    paintGrid(container, ctx);
  }

  function paintGrid(container, ctx) {
    const grid = container.querySelector("[data-sa-grid]");
    const countEl = container.querySelector("[data-sa-count]");
    if (!grid) return;
    const esc = window.esc || ((s) => String(s ?? ""));
    const iconImg = window.iconImg || (() => "");
    const formatNum = window.formatNum || ((n) => String(n));

    const snapshot = ctx.snapshot || {};
    const storageRaw = snapshot.storage;
    const list = Array.isArray(storageRaw) ? storageRaw : Object.values(storageRaw || {});
    const storage = list.filter((s) => (s.count || 0) > 0);

    if (countEl) {
      const totalUnits = storage.reduce((sum, s) => sum + s.count, 0);
      countEl.textContent = `${storage.length} items · ${formatNum(totalUnits)} total units`;
    }

    if (storage.length === 0) {
      grid.innerHTML = `<div class="muted">No storage observations yet.</div>`;
      return;
    }

    // Bucket by category. Null/unknown → "Other".
    const buckets = new Map();
    for (const cat of STORAGE_CATEGORY_ORDER) buckets.set(cat, []);
    for (const s of storage) {
      const cat = s.main_cat_name || "Other";
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(s);
    }

    // Default order: fixed list, then anything else by first-seen.
    const defaultOrder = [
      ...STORAGE_CATEGORY_ORDER.filter((k) => buckets.get(k)?.length),
      ...[...buckets.keys()].filter((k) => !STORAGE_CATEGORY_ORDER.includes(k) && buckets.get(k).length),
    ];
    // Honour user's saved order, appending any new categories that weren't
    // around when the order was saved.
    const saved = (ctx.params.order || []).filter((k) => buckets.get(k)?.length);
    const orderedKeys = [...saved];
    for (const k of defaultOrder) if (!orderedKeys.includes(k)) orderedKeys.push(k);

    const collapsed = new Set(ctx.params.collapsed || []);

    grid.innerHTML = orderedKeys.map((cat) => {
      const items = buckets.get(cat).slice().sort((a, b) =>
        (a.name || "").localeCompare(b.name || "")
      );
      const total = items.reduce((sum, s) => sum + s.count, 0);
      const isCollapsed = collapsed.has(cat);
      const rows = items.map((s) =>
        `<div class="storage-item" data-elementary-id="${esc(s.elementary_id)}">`
        + iconImg(s.elementary_id, s.name)
        + `<span>${esc(s.name || `Item #${s.elementary_id}`)}</span>`
        + `<span>${formatNum(s.count)}</span>`
        + `</div>`
      ).join("");
      return `<div class="storage-category${isCollapsed ? " collapsed" : ""}" data-cat="${esc(cat)}" draggable="true">
        <h3 class="storage-category-head">
          <span class="sa-caret">${isCollapsed ? "▸" : "▾"}</span>
          <span class="sa-cat-name">${esc(cat)}</span>
          <span class="muted">${formatNum(total)} units</span>
        </h3>
        <div class="storage-category-items">${rows}</div>
      </div>`;
    }).join("");

    wireCategoryHandlers(grid, ctx);
  }

  function wireCategoryHandlers(grid, ctx) {
    let dragSrc = null;

    grid.querySelectorAll(".storage-category").forEach((cat) => {
      const head = cat.querySelector(".storage-category-head");

      // Click on header → toggle collapsed. Uses pointerdown→pointerup so
      // dragstart doesn't interfere; we treat as click if no drag started.
      head.addEventListener("click", (ev) => {
        // If the drag layer fired this synthetic click on drop, skip.
        if (ev.defaultPrevented) return;
        const catId = cat.dataset.cat;
        const set = new Set(ctx.params.collapsed || []);
        if (set.has(catId)) set.delete(catId); else set.add(catId);
        ctx.params.collapsed = [...set];
        persistParams(ctx);
        cat.classList.toggle("collapsed");
        const caret = cat.querySelector(".sa-caret");
        if (caret) caret.textContent = cat.classList.contains("collapsed") ? "▸" : "▾";
      });

      // Drag-to-reorder. The whole category is draggable; we just remember
      // which one started and move the DOM on drop, then persist the new order.
      cat.addEventListener("dragstart", (ev) => {
        dragSrc = cat;
        cat.classList.add("sa-dragging");
        try { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", cat.dataset.cat); } catch {}
      });
      cat.addEventListener("dragend", () => {
        cat.classList.remove("sa-dragging");
        dragSrc = null;
        grid.querySelectorAll(".storage-category").forEach((c) => c.classList.remove("sa-drop-target"));
      });
      cat.addEventListener("dragover", (ev) => {
        if (!dragSrc || dragSrc === cat) return;
        ev.preventDefault(); // allow drop
        try { ev.dataTransfer.dropEffect = "move"; } catch {}
        cat.classList.add("sa-drop-target");
      });
      cat.addEventListener("dragleave", () => {
        cat.classList.remove("sa-drop-target");
      });
      cat.addEventListener("drop", (ev) => {
        ev.preventDefault();
        cat.classList.remove("sa-drop-target");
        if (!dragSrc || dragSrc === cat) return;
        // Insert dragSrc before `cat` if dragSrc is currently after it,
        // otherwise insert after — mimics typical drag-to-reorder feel.
        const kids = [...grid.children];
        const srcIdx = kids.indexOf(dragSrc);
        const dstIdx = kids.indexOf(cat);
        if (srcIdx < dstIdx) cat.after(dragSrc);
        else cat.before(dragSrc);
        // Persist new order based on current DOM.
        ctx.params.order = [...grid.querySelectorAll(".storage-category")].map((c) => c.dataset.cat);
        persistParams(ctx);
      });
    });
  }

  function persistParams(ctx) {
    if (typeof SH.persistWidgetParams === "function" && ctx.nodeId) {
      SH.persistWidgetParams(ctx.nodeId, ctx.params);
      return;
    }
    // Fallback — sessionStorage so a page refresh keeps the state at least
    // until SH.persistWidgetParams ships. Keyed by nodeId.
    try {
      const key = `sh.widget.${ctx.nodeId || "storage-all"}.params`;
      sessionStorage.setItem(key, JSON.stringify(ctx.params));
    } catch { /* quota / disabled — drop silently */ }
  }

  function dispose(container) {
    if (container && container.__sa_ro) {
      try { container.__sa_ro.disconnect(); } catch {}
      container.__sa_ro = null;
    }
  }

  SH.registerWidget({
    id: "storage-all",
    name: "Storage",
    category: "Industry",
    description: "All storage items grouped by category; draggable and collapsible",
    icon: "📦",
    defaultParams: { collapsed: [], order: [] },
    render,
    update,
    dispose,
  });
})();
