"use strict";

// =============================================================================
//  notifications widget — surface for SH.advisor insights
//
//  Subscribes to SH.advisor and renders each active insight as a card.
//  Mounting any instance of this widget suppresses the corner toasts
//  (advisor's default fallback). Unmounting all instances restores them.
//
//  Card actions:
//    - dismiss (×) → SH.advisor.dismiss(id)
//    - click body → if highlight is set, scroll to the bound DOM node
//      and flash it briefly.
//
//  Future: action-button rendering (insight.actions[]), pinning,
//  category filters, group-by-source.
// =============================================================================

(function () {
  // Counts how many instances of this widget are currently mounted; lets us
  // toggle the toast suppression flag.
  let mountedCount = 0;

  function render(container, ctx) {
    container.classList.add("widget-notifications");
    container.innerHTML = `
      <div class="notif-head">
        <span>Notifications</span>
        <span class="muted" data-notif-count></span>
      </div>
      <div class="notif-body"></div>
    `;
    mountedCount++;
    suppressToasts(true);
    paint(container, listInsights());

    // Subscribe to advisor diffs. The unsubscribe handle is stored on the
    // container so dispose can clean it up.
    const unsub = SH.advisor && typeof SH.advisor.subscribe === "function"
      ? SH.advisor.subscribe(({ all }) => paint(container, all))
      : () => {};
    container._notifUnsub = unsub;
  }

  function update(container, ctx) {
    paint(container, listInsights());
  }

  function dispose(container) {
    try { (container._notifUnsub || (() => {}))(); } catch {}
    delete container._notifUnsub;
    mountedCount = Math.max(0, mountedCount - 1);
    if (mountedCount === 0) suppressToasts(false);
  }

  function listInsights() {
    if (SH.advisor && typeof SH.advisor.listInsights === "function") {
      return SH.advisor.listInsights() || [];
    }
    return [];
  }

  function suppressToasts(on) {
    // Tell advisor.js to stop rendering corner toasts while a widget is
    // mounted. We use a window flag that advisor.js's toast renderer should
    // check; if it doesn't yet, hide the container via CSS instead.
    window.SH_NOTIFICATIONS_WIDGET_MOUNTED = on;
    const toasts = document.getElementById("advisor-toasts");
    if (toasts) toasts.style.display = on ? "none" : "";
  }

  function paint(container, insights) {
    const body = container.querySelector(".notif-body");
    const count = container.querySelector("[data-notif-count]");
    if (!body) return;
    insights = (insights || []).slice().sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    count.textContent = insights.length ? `${insights.length}` : "";
    if (insights.length === 0) {
      body.innerHTML = `<div class="muted notif-empty">No active notifications.</div>`;
      return;
    }
    body.innerHTML = insights.map(renderCard).join("");
    body.querySelectorAll("[data-dismiss]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.dismiss;
        if (SH.advisor && typeof SH.advisor.dismiss === "function") SH.advisor.dismiss(id);
      });
    });
    body.querySelectorAll("[data-insight-card]").forEach((card) => {
      card.addEventListener("click", () => {
        const id = card.dataset.insightCard;
        const insight = (listInsights() || []).find((i) => i.id === id);
        if (insight && insight.highlight) focusBoundNode(insight.highlight);
      });
    });
  }

  function severityRank(s) {
    return ({ critical: 4, warning: 3, info: 2, success: 1, debug: 0 })[s] || 0;
  }

  function renderCard(i) {
    const icon = i.icon ? `<span class="ni-icon">${escHtml(i.icon)}</span>` : "";
    const title = escHtml(i.title || "");
    const body = i.bodyType === "html" ? (i.body || "") : escHtml(i.body || "");
    const sev = i.severity || "info";
    return `<div class="notif-card sev-${sev}" data-insight-card="${escHtml(i.id)}">
      <div class="ni-row">
        ${icon}
        <span class="ni-title">${title}</span>
        <button class="ni-dismiss" data-dismiss="${escHtml(i.id)}" aria-label="dismiss">×</button>
      </div>
      <div class="ni-body">${body}</div>
    </div>`;
  }

  function focusBoundNode(highlight) {
    if (!highlight) return;
    const path = highlight.target;
    const bindings = SH.bindings;
    if (!bindings || !path) return;
    // Find any DOM node bound to this path (or an ancestor path).
    let nodes = [];
    if (bindings instanceof Map) {
      const set = bindings.get(path);
      if (set) for (const b of set) nodes.push(b.node);
      // Ancestor paths too: e.g. /crew/89 covers /crew/89/mood
      for (const [p, set] of bindings) {
        if (path.startsWith(p + "/") && set) for (const b of set) nodes.push(b.node);
      }
    }
    if (!nodes.length) return;
    const target = nodes[0];
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("notif-flash");
    setTimeout(() => target.classList.remove("notif-flash"), 1200);
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  if (typeof SH === "object" && typeof SH.registerWidget === "function") {
    SH.registerWidget({
      id: "notifications",
      name: "Notifications",
      category: "Advisor",
      description: "Active advisor insights — click to focus, × to dismiss",
      icon: "🔔",
      render,
      update,
      dispose,
    });
  }
})();
