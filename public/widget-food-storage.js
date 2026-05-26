"use strict";

// =============================================================================
//  food-storage widget — second migration target.
//
//  Mirrors the legacy renderFoodStorage in app.js. Reads from
//  ctx.snapshot.storage (object keyed by elementary_id post-normalize, or
//  array pre-normalize — we handle both).
//
//  Helpers (isFoodItem, iconImg, esc, formatNum) live in app.js as top-level
//  function declarations, which makes them properties of `window` for plain
//  scripts. Same load-order trick as widget-crew-status: this file runs
//  before app.js, but render() resolves helpers lazily at panel-mount time.
// =============================================================================

(function () {
  function render(container, ctx) {
    container.classList.add("widget-food-storage");
    container.innerHTML = `
      <div class="fs-head">Food in storage</div>
      <div class="fs-body"></div>
    `;
    paint(container, ctx.snapshot);
  }

  function update(container, ctx) {
    paint(container, ctx.snapshot);
  }

  function paint(container, snapshot) {
    const body = container.querySelector(".fs-body");
    if (!body) return;
    if (typeof window.isFoodItem !== "function") {
      body.innerHTML = `<div class="widget-error">food-storage helpers not yet loaded.</div>`;
      return;
    }
    const storage = (snapshot && snapshot.storage) || {};
    const list = Array.isArray(storage) ? storage : Object.values(storage);
    const foods = list.filter((s) => (s.count || 0) > 0 && window.isFoodItem(s));
    foods.sort((a, b) => b.count - a.count);
    if (foods.length === 0) {
      body.innerHTML = `<div class="muted">No food in storage.</div>`;
      return;
    }
    const esc = window.esc || ((s) => String(s ?? ""));
    const iconImg = window.iconImg || (() => "");
    const formatNum = window.formatNum || ((n) => String(n));
    body.innerHTML = foods.map((s) =>
      `<div class="food-item">`
      + iconImg(s.elementary_id, s.name)
      + `<span class="food-name">${esc(s.name || `Item #${s.elementary_id}`)}</span>`
      + `<span class="food-count">${formatNum(s.count)}</span>`
      + `</div>`
    ).join("");
  }

  function dispose(/*container*/) {
    // No bindings, no timers — paint() runs on every update via the runtime.
  }

  SH.registerWidget({
    id: "food-storage",
    name: "Food Storage",
    category: "Botany",
    description: "Food items currently in ship storage with icons and counts",
    icon: "🍎",
    render,
    update,
    dispose,
  });
})();
