"use strict";

// =============================================================================
//  crops-growing widget — third migration target.
//
//  Mirrors the legacy renderCrops in app.js: groups grow beds by plant_id and
//  shows one row per crop type with per-bed markers on a 0..100% growth
//  track, plus stage labels at the quartile boundaries.
//
//  Reads from ctx.snapshot.growBeds (still an array — not normalized) and
//  ctx.snapshot.crops.byElement (fallback name lookup).
//
//  Helpers (iconImg, esc, bedETA, stageSeverityClass) live in app.js as
//  top-level function declarations, hence on `window` for plain scripts.
// =============================================================================

(function () {
  function render(container, ctx) {
    container.classList.add("widget-crops-growing");
    container.innerHTML = `<div class="cg-body"></div>`;
    paint(container, ctx.snapshot);
  }

  function update(container, ctx) {
    paint(container, ctx.snapshot);
  }

  function paint(container, snapshot) {
    const body = container.querySelector(".cg-body");
    if (!body) return;
    if (typeof window.bedETA !== "function" || typeof window.stageSeverityClass !== "function") {
      body.innerHTML = `<div class="widget-error">crops-growing helpers not yet loaded.</div>`;
      return;
    }
    const beds = (snapshot && snapshot.growBeds) || [];
    if (beds.length === 0) {
      body.innerHTML = `<div class="muted">No grow beds.</div>`;
      return;
    }

    const esc = window.esc || ((s) => String(s ?? ""));
    const iconImg = window.iconImg || (() => "");
    const bedETA = window.bedETA;
    const stageSeverityClass = window.stageSeverityClass;
    const byElementMeta = (snapshot && snapshot.crops && snapshot.crops.byElement) || {};

    const groups = new Map();
    for (const bed of beds) {
      const key = String(bed.plant_id);
      if (!groups.has(key)) {
        groups.set(key, {
          plant_id: bed.plant_id,
          name: bed.plant_name || (byElementMeta[key] && byElementMeta[key].name) || `Item #${key}`,
          beds: [],
        });
      }
      groups.get(key).beds.push(bed);
    }

    const rows = [...groups.values()].sort((a, b) => b.beds.length - a.beds.length);

    body.innerHTML = rows.map((g) => {
      const markers = g.beds.map((b) => {
        const left = Math.max(0, Math.min(100, b.growth * 100));
        const sev = stageSeverityClass(b.stage);
        const tip = `Bed (${b.bed_x},${b.bed_y}) · ${b.stage} · ${Math.round(b.growth * 100)}% · ${bedETA(b.growth, b.stage)}`;
        return `<span class="bed-marker stage-${sev}" style="left:${left.toFixed(1)}%" title="${esc(tip)}"></span>`;
      }).join("");

      const ticks = `<span class="bed-tick" style="left:25%"></span>`
                  + `<span class="bed-tick" style="left:50%"></span>`
                  + `<span class="bed-tick" style="left:75%"></span>`;

      return `<div class="crop-row">`
        + `<div class="crop-row-head">`
          + iconImg(g.plant_id, g.name)
          + `<span class="crop-name">${esc(g.name)}</span>`
          + `<span class="crop-count">×${g.beds.length}</span>`
        + `</div>`
        + `<div class="bed-track">${ticks}${markers}</div>`
        + `<div class="bed-stage-labels">`
          + `<span>Seedling</span><span>Growing</span><span>Maturing</span><span>Mature</span>`
        + `</div>`
      + `</div>`;
    }).join("");
  }

  function dispose(/*container*/) {
    // No bindings, no timers.
  }

  SH.registerWidget({
    id: "crops-growing",
    name: "Crops Growing",
    category: "Botany",
    description: "Grow beds by crop type with per-bed markers and ETA",
    icon: "🌱",
    render,
    update,
    dispose,
  });
})();
