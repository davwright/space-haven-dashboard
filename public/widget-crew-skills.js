"use strict";

// =============================================================================
//  crew-skills widget — fourth migration target.
//
//  Mirrors the legacy renderSkills in app.js: name + traits + 4 attribute
//  columns + 14 skill columns with vertical tally-bar cells and optional
//  passion slots, all driven by multi-criteria sort state.
//
//  Sort state intentionally lives in app.js (`window.skillSort`, exposed via
//  the existing top-level `let`) — the legacy Skills tab and this widget
//  share it so toggling sort in either place updates the other.
//
//  Helpers used (all module-level functions in app.js, hence on window):
//    skillHeaderCell, toggleSkillSort, sortCrewForSkills, skillRow,
//    ATTR_COLUMNS, SKILL_COLUMNS, esc.
// =============================================================================

(function () {
  function render(container, ctx) {
    container.classList.add("widget-crew-skills");
    container.innerHTML = `
      <div class="cs-toolbar">
        <span class="muted" data-sk-count></span>
        <a href="#" class="reset-sort" data-sk-reset hidden>Reset sort</a>
      </div>
      <div class="cs-table-wrap">
        <table class="crew-table skills-table">
          <thead><tr data-sk-head></tr></thead>
          <tbody data-sk-body></tbody>
        </table>
      </div>
    `;
    paint(container, ctx.snapshot);
  }

  function update(container, ctx) {
    paint(container, ctx.snapshot);
  }

  function paint(container, snapshot) {
    const head = container.querySelector("[data-sk-head]");
    const body = container.querySelector("[data-sk-body]");
    const countEl = container.querySelector("[data-sk-count]");
    const resetEl = container.querySelector("[data-sk-reset]");
    if (!head || !body) return;

    if (typeof window.skillHeaderCell !== "function" ||
        typeof window.skillRow !== "function" ||
        !Array.isArray(window.ATTR_COLUMNS) ||
        !Array.isArray(window.SKILL_COLUMNS)) {
      body.innerHTML = `<tr><td class="widget-error">crew-skills helpers not yet loaded.</td></tr>`;
      return;
    }

    const snap = snapshot || {};
    // tree.crew may be array (legacy snapshot) or object (post-normalize).
    const crewRaw = snap.crew || [];
    const crew = Array.isArray(crewRaw) ? crewRaw : Object.values(crewRaw);

    // Header — shares the same skillHeaderCell renderer so the sort indicators
    // (arrows + tiebreaker numbers) match the legacy tab exactly.
    const headCells = [];
    headCells.push(window.skillHeaderCell("name", "Name", false));
    headCells.push(`<th class="traits-col">Traits</th>`);
    for (const a of window.ATTR_COLUMNS) {
      headCells.push(window.skillHeaderCell(a.key, a.name, false, a.name, "attr-col"));
    }
    for (const c of window.SKILL_COLUMNS) {
      const cls = "skill-col" + (c.extra ? " skill-extra" : "");
      headCells.push(window.skillHeaderCell(c.sk, c.name, true, c.name, cls));
    }
    head.innerHTML = headCells.join("");

    // Re-bind header click handlers each paint (rebuilt above).
    head.querySelectorAll("th[data-sort-key]").forEach((th) => {
      th.addEventListener("click", (ev) => {
        const raw = th.dataset.sortKey;
        const key = /^\d+$/.test(raw) ? Number(raw) : raw;
        window.toggleSkillSort(key, ev.shiftKey);
        // Repaint both the widget and the legacy tab so sort state stays in sync.
        paint(container, snap);
        if (typeof window.renderSkills === "function") {
          try { window.renderSkills(); } catch { /* legacy view may not be mounted */ }
        }
      });
    });

    // Reset link mirrors legacy behaviour.
    const sort = window.skillSort || [];
    if (resetEl) {
      resetEl.hidden = sort.length === 0;
      resetEl.onclick = (ev) => {
        ev.preventDefault();
        // Mutate via the same module-level state — clear in place so the legacy
        // tab sees it too (assignment to `window.skillSort = []` would replace
        // the binding in app.js, not the underlying `let`, so do `.length = 0`).
        if (Array.isArray(window.skillSort)) window.skillSort.length = 0;
        paint(container, snap);
        if (typeof window.renderSkills === "function") {
          try { window.renderSkills(); } catch { /* ignore */ }
        }
      };
    }

    const rows = window.sortCrewForSkills(crew);
    if (countEl) countEl.textContent = `${rows.length} crew`;
    body.innerHTML = rows.map(window.skillRow).join("");
  }

  function dispose(/*container*/) {
    // No bindings, no timers.
  }

  SH.registerWidget({
    id: "crew-skills",
    name: "Crew Skills",
    category: "Crew",
    description: "All 14 skills + 4 attributes + traits; multi-sort columns",
    icon: "📊",
    render,
    update,
    dispose,
  });
})();
