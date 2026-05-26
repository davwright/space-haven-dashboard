"use strict";

// =============================================================================
//  Space Haven Dashboard — advisor layer engine.
//
//  Pure rules → derived insights → toast/notification rendering. See
//  docs/advisor-layer-design.md for the spec. Rules are registered via
//  SH.advisor.registerRule(...) and re-evaluated whenever the tree changes.
//
//  Wire-up (see TODO at bottom): if state.js exposes onTreeReplaced /
//  onApplyOps hooks, we subscribe; otherwise we poll at 1Hz so the engine
//  still works while the docking framework agent finishes its parallel edits.
// =============================================================================

(function () {
  const rules = new Map();           // ruleId → { def, lastFingerprint }
  const insights = new Map();        // insightId → Insight
  const subscribers = new Set();     // callback(diff)
  const muted = new Map();           // insightId → muteUntilTick (or ms timestamp)

  function registerRule(def) {
    if (!def.id || !def.evaluate || !def.watch) {
      throw new Error("rule missing id/evaluate/watch: " + JSON.stringify(def));
    }
    rules.set(def.id, { def, lastFingerprint: null });
  }

  function getByPath(obj, path) {
    if (!obj || !path) return undefined;
    const segs = path.split("/").filter(Boolean);
    let cur = obj;
    for (const s of segs) {
      if (cur == null) return undefined;
      cur = cur[s];
    }
    return cur;
  }

  function fingerprintPaths(tree, paths) {
    // Hash a small JSON of the values at each watched path. Cheap.
    const parts = [];
    for (const p of paths) {
      const v = getByPath(tree, p);
      parts.push(p + ":" + (v == null ? "null" : JSON.stringify(v).slice(0, 200)));
    }
    return parts.join("|");
  }

  function evaluateAll() {
    if (!window.SH || !SH.tree) return;
    const tree = SH.tree;
    const now = SH.tick || Date.now();
    const next = new Map();
    for (const rule of rules.values()) {
      const fp = fingerprintPaths(tree, rule.def.watch);
      if (fp === rule.lastFingerprint) {
        // Carry over: reuse insights from last run for this rule
        for (const i of insights.values()) if (i.ruleId === rule.def.id) next.set(i.id, i);
        continue;
      }
      rule.lastFingerprint = fp;
      let out;
      try {
        out = rule.def.evaluate(tree) || [];
      } catch (e) {
        console.error(`[advisor] rule "${rule.def.id}" threw:`, e);
        continue;
      }
      for (const i of out) {
        if (muted.has(i.id) && muted.get(i.id) > now) continue;
        next.set(i.id, { ...i, ruleId: rule.def.id, emittedAt: now });
      }
    }
    const added   = [...next.values()].filter((i) => !insights.has(i.id));
    const removed = [...insights.keys()].filter((k) => !next.has(k));
    insights.clear();
    for (const [k, v] of next) insights.set(k, v);
    const diff = { added, removed, all: [...insights.values()] };
    for (const sub of subscribers) {
      try { sub(diff); } catch (e) { console.error("[advisor] subscriber threw", e); }
    }
  }

  function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

  function listInsights() { return [...insights.values()]; }

  // Mute an insight by id for N milliseconds (default 5 minutes).
  function dismiss(insightId, durationMs) {
    const now = SH.tick || Date.now();
    muted.set(insightId, now + (durationMs || 5 * 60 * 1000));
    insights.delete(insightId);
    for (const sub of subscribers) {
      try { sub({ added: [], removed: [insightId], all: [...insights.values()] }); }
      catch (e) { console.error("[advisor] subscriber threw", e); }
    }
  }

  // TODO(state.js integration): state.js does not currently expose
  // onTreeReplaced / onApplyOps hooks. The docking-framework agent is
  // editing state.js in parallel; once they add a hook like
  // `SH.onTreeReplaced(fn)` and an after-applyOps callback, replace the
  // setInterval below. The polling path is functionally correct but
  // burns one fingerprint pass per second even when nothing changed.
  function startEngine() {
    if (typeof SH.onTreeReplaced === "function") {
      SH.onTreeReplaced(evaluateAll);
    } else {
      setInterval(evaluateAll, 1000);
    }
    evaluateAll(); // initial pass
  }

  // ---- Toast fallback rendering ---------------------------------------------

  function ensureToastContainer() {
    let el = document.getElementById("advisor-toasts");
    if (!el) {
      el = document.createElement("div");
      el.id = "advisor-toasts";
      document.body.appendChild(el);
    }
    return el;
  }

  function renderToast(insight) {
    const container = ensureToastContainer();
    if (container.querySelector(`[data-insight-id="${insight.id}"]`)) return;
    const card = document.createElement("div");
    card.className = `advisor-toast sev-${insight.severity || "info"}`;
    card.dataset.insightId = insight.id;
    card.innerHTML = `
      <div class="t-row">
        <span class="t-icon">${insight.icon || "i"}</span>
        <span class="t-title">${escHtml(insight.title || "")}</span>
        <button class="t-dismiss" aria-label="dismiss">&times;</button>
      </div>
      <div class="t-body">${insight.bodyType === "html" ? insight.body : escHtml(insight.body || "")}</div>
    `;
    card.querySelector(".t-dismiss").addEventListener("click", () => {
      SH.advisor.dismiss(insight.id);
      card.classList.add("dismissing");
      setTimeout(() => card.remove(), 200);
    });
    container.appendChild(card);
  }

  function clearToast(insightId) {
    const el = document.querySelector(`#advisor-toasts [data-insight-id="${CSS.escape(insightId)}"]`);
    if (el) el.remove();
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Default subscriber: render toasts. The notifications widget sets a
  // window flag when at least one instance is mounted; we skip toast
  // rendering while that's true so we don't duplicate the same insights
  // in the corner AND in the dock.
  subscribe(({ added, removed }) => {
    if (window.SH_NOTIFICATIONS_WIDGET_MOUNTED) return;
    for (const i of added) renderToast(i);
    for (const id of removed) clearToast(id);
  });

  window.SH = window.SH || {};
  window.SH.advisor = {
    registerRule,
    subscribe,
    listInsights,
    dismiss,
    _evaluateAll: evaluateAll,
  };

  // Auto-start when the DOM is ready and SH.tree exists.
  function tryStart() {
    if (window.SH && SH.tree && Object.keys(SH.tree).length > 0) startEngine();
    else setTimeout(tryStart, 100);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryStart);
  } else {
    tryStart();
  }
})();
