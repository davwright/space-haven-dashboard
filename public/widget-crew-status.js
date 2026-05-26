"use strict";

// =============================================================================
//  crew-status widget — the first migration target.
//
//  Renders the same dense "vitals + conditions" grid as the legacy Status tab.
//  Reads from ctx.snapshot (== SH.tree). Coexists with the legacy renderStatus
//  in app.js — both can run at the same time without interfering.
//
//  Helpers (statusRow, bindStatCell, severity, STATUS_LIVE_KEYS, esc, …) are
//  exposed by app.js as window-level globals once it loads. This file must
//  load AFTER widgets.js but BEFORE app.js — both ordering constraints hold
//  per index.html's script order.
// =============================================================================

(function () {
  // The render function reads helpers off window at call time, not load time,
  // so the load order (this file before app.js) is fine: by the time a panel
  // is first rendered, app.js has long since executed.
  function render(container, ctx) {
    if (typeof window.statusRow !== "function") {
      container.innerHTML = `<div class="widget-error">crew-status helpers not yet loaded.</div>`;
      return;
    }
    const snap = ctx.snapshot || {};
    // tree.crew may be either array (legacy) or object (post-normalize).
    const crew = Object.values(snap.crew || {});

    container.innerHTML = `
      <div class="cs-toolbar">
        <span class="muted" data-cs-count></span>
      </div>
      <div class="cs-table-wrap">
        <table class="crew-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Mood</th>
              <th>Health</th>
              <th>Food</th>
              <th>Rest</th>
              <th>Comfort</th>
              <th>O₂</th>
              <th>Temp</th>
              <th>Conditions</th>
            </tr>
          </thead>
          <tbody class="cs-body"></tbody>
        </table>
      </div>
    `;

    const body = container.querySelector(".cs-body");
    const countEl = container.querySelector("[data-cs-count]");

    if (crew.length === 0) {
      body.innerHTML = `<tr><td colspan="9" class="muted">No crew data yet.</td></tr>`;
      if (countEl) countEl.textContent = "0 crew";
      return;
    }

    // Sort by name as a stable default. (The legacy Status tab has a full
    // sort/filter toolbar; widget v1 omits that — defer to phase 3 polish.)
    crew.sort((a, b) => String(a.name || a.cid).localeCompare(String(b.name || b.cid)));

    if (countEl) countEl.textContent = `${crew.length} crew`;

    body.innerHTML = crew.map(window.statusRow).join("");

    // Wire surgical bindings for live stats — uses ctx.bindCell so the host
    // can unbind them all on dispose without the widget tracking each one.
    const liveKeys = window.STATUS_LIVE_KEYS || ["mood","health","food","rest","comfort","oxygen","temperature"];
    for (const c of crew) {
      if (c.cid == null) continue;
      const tr = body.querySelector(`tr[data-cid="${c.cid}"]`);
      if (!tr) continue;
      for (const key of liveKeys) {
        const bar = tr.querySelector(`.stat-bar[data-stat="${key}"]`);
        if (!bar) continue;
        // We can't call the legacy bindStatCell — it uses SH.bindCell directly,
        // bypassing ctx tracking. Inline the binding here, going through ctx.
        const longVal = c[`${key}_long`];
        ctx.bindCell(`/crew/${c.cid}/${key}`, bar, makeStatRenderer(key, longVal, bar));
      }
    }
  }

  // Surgical renderer for one stat-bar wrapper. Closes over the bar's child
  // elements so the lookup happens once, not on every patch.
  function makeStatRenderer(key, longVal, barEl) {
    const fill = barEl.querySelector(".fill");
    const overFill = barEl.querySelector(".over-fill");
    const valEl = barEl.querySelector(".val");
    const severity = window.severity || (() => "neutral");
    return function (node, v) {
      if (v == null || Number.isNaN(v)) return;
      const sev = severity(key, v);
      node.classList.remove("s-extreme","s-major","s-minor","s-neutral","s-content","s-happy");
      node.classList.add(`s-${sev}`);
      let basePct, overPct = 0;
      if (key === "mood") {
        basePct = Math.max(0, Math.min(100, (v + 100) / 2));
      } else {
        basePct = Math.max(0, Math.min(100, v));
        if (v > 100) overPct = Math.min(100, ((v - 100) / 100) * 100);
      }
      if (overPct > 0) node.classList.add("over"); else node.classList.remove("over");
      if (fill) fill.style.width = `${basePct}%`;
      if (overFill) overFill.style.width = `${overPct}%`;
      if (valEl) valEl.textContent = Math.round(v);
      const tip = longVal != null
        ? `${Math.round(v)} (long-term ${Math.round(longVal)})`
        : `${Math.round(v)}`;
      node.setAttribute("title", tip);
    };
  }

  function dispose(/*container*/) {
    // Bindings registered via ctx.bindCell are unbound by the widget runtime.
    // No timers, observers, or external listeners to tear down.
  }

  // Wait for the widget runtime to exist. widgets.js loads before us, so
  // SH.registerWidget is always available at this point.
  SH.registerWidget({
    id: "crew-status",
    name: "Crew Status",
    category: "Crew",
    description: "Mood, health, food, conditions",
    icon: "🧑",
    render,
    dispose,
  });
})();
