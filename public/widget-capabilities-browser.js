"use strict";

// =============================================================================
//  capabilities-browser widget — the inverse of capability gating.
//
//  Reads SH.listWidgets() + SH.advisor.listRules() (if exposed), collects
//  every `requires` predicate, groups by capability axis (Tech / Component /
//  Skill / Profession / Resource), and shows the player which widgets +
//  rules each axis enables.
//
//  Player state comes from SH.tree:
//    - researchedTech: number[] of tech ids
//    - crew: object keyed by cid → { skills: [{sk, level}, ...] }
//    - bodies: not yet useful for component detection; placeholder
//
//  When a widget/rule doesn't declare `requires` (most don't yet) we still
//  list it under "Always available" so the browser stays informative even
//  before the gating migration completes.
//
//  See docs/capability-gating-design.md → "Inverting the lens".
// =============================================================================

(function () {
  function render(container, ctx) {
    container.classList.add("widget-capabilities-browser");
    container.innerHTML = `
      <div class="cb-head">
        <span>Capabilities</span>
        <span class="muted" data-cb-summary></span>
      </div>
      <div class="cb-body"></div>
    `;
    paint(container);
  }

  function update(container, ctx) { paint(container); }
  function dispose() {}

  function paint(container) {
    const body = container.querySelector(".cb-body");
    const summary = container.querySelector("[data-cb-summary]");
    if (!body) return;

    const widgets = (SH.listWidgets ? SH.listWidgets() : []).slice();
    const rules = (SH.advisor && typeof SH.advisor.listRules === "function")
      ? SH.advisor.listRules()
      : [];

    // Player state
    const tree = SH.tree || {};
    const researched = new Set((tree.researchedTech || []).map(String));
    const crewSkillMax = computeMaxSkills(tree.crew || {});

    // Bucket every widget + rule by its requirement axes.
    const buckets = new Map(); // axisKey → { label, items: [{ kind, ref, met }], met }

    const ungated = []; // anything without `requires`

    function consider(entry) {
      const reqs = entry.requires || [];
      if (!reqs.length) { ungated.push(entry); return; }
      for (const p of reqs) {
        const key = axisKey(p);
        const label = axisLabel(p, tree);
        const met = evaluate(p, { researched, crewSkillMax });
        if (!buckets.has(key)) buckets.set(key, { label, items: [], met });
        buckets.get(key).items.push({ ...entry, met });
      }
    }

    for (const w of widgets) consider({ kind: "widget", id: w.id, name: w.name, unlocks: w.unlocks || w.description, requires: w.requires });
    for (const r of rules)   consider({ kind: "rule",   id: r.id, name: r.name || r.id, unlocks: r.description, requires: r.requires });

    // Sort buckets: unmet first (aspirational), met second.
    const sortedBuckets = [...buckets.entries()].sort(([, a], [, b]) => {
      if (a.met !== b.met) return a.met ? 1 : -1;
      return a.label.localeCompare(b.label);
    });

    // Summary line
    const metCount  = sortedBuckets.filter(([, b]) => b.met).length;
    const totalCount = sortedBuckets.length;
    summary.textContent = totalCount
      ? `${metCount}/${totalCount} capabilities unlocked`
      : "no gated capabilities declared yet";

    // Render
    const sections = sortedBuckets.map(([key, bucket]) => {
      const items = bucket.items.map((i) => {
        const cls = i.kind === "widget" ? "cb-widget" : "cb-rule";
        const onclick = i.kind === "widget" ? `data-add-widget="${esc(i.id)}"` : "";
        const unlocks = i.unlocks ? `<span class="cb-unlocks">${esc(i.unlocks)}</span>` : "";
        return `<div class="cb-item ${cls}" ${onclick}>
          <span class="cb-item-kind">${i.kind === "widget" ? "🪟" : "🔔"}</span>
          <span class="cb-item-name">${esc(i.name)}</span>
          ${unlocks}
        </div>`;
      }).join("");
      const status = bucket.met ? "✅" : "🔒";
      return `<details class="cb-bucket ${bucket.met ? "met" : "unmet"}" ${bucket.met ? "" : "open"}>
        <summary><span class="cb-status">${status}</span> <span class="cb-bucket-label">${esc(bucket.label)}</span></summary>
        <div class="cb-bucket-items">${items}</div>
      </details>`;
    });

    if (ungated.length) {
      const items = ungated.map((i) => {
        const onclick = i.kind === "widget" ? `data-add-widget="${esc(i.id)}"` : "";
        const unlocks = i.unlocks ? `<span class="cb-unlocks">${esc(i.unlocks)}</span>` : "";
        return `<div class="cb-item ${i.kind === "widget" ? "cb-widget" : "cb-rule"}" ${onclick}>
          <span class="cb-item-kind">${i.kind === "widget" ? "🪟" : "🔔"}</span>
          <span class="cb-item-name">${esc(i.name)}</span>
          ${unlocks}
        </div>`;
      }).join("");
      sections.push(`<details class="cb-bucket always" open>
        <summary><span class="cb-status">∞</span> <span class="cb-bucket-label">Always available</span></summary>
        <div class="cb-bucket-items">${items}</div>
      </details>`);
    }

    body.innerHTML = sections.join("") || `<div class="muted" style="padding:1rem">No widgets or rules registered.</div>`;

    // Click-to-add: if the entry is a widget and the docking host has the
    // add helper, mount it into the current workspace.
    body.querySelectorAll("[data-add-widget]").forEach((el) => {
      el.addEventListener("click", () => {
        const wid = el.dataset.addWidget;
        if (SH.addWidgetToWorkspace) SH.addWidgetToWorkspace(wid, {});
      });
    });
  }

  // -- predicate evaluation --------------------------------------------------

  function evaluate(p, state) {
    if (!p || typeof p !== "object") return false;
    if (p.any && Array.isArray(p.any)) return p.any.some((q) => evaluate(q, state));
    if (p.all && Array.isArray(p.all)) return p.all.every((q) => evaluate(q, state));
    if (p.not) return !evaluate(p.not, state);
    switch (p.type) {
      case "research":   return state.researched.has(String(p.tech));
      case "skill":      return (state.crewSkillMax[p.skill] || 0) >= (p.level || 1);
      case "component":  return false;  // not yet tracked
      case "operator-at": return false; // not yet tracked
      case "profession": return false;  // could be wired from <j profession> data
      case "resource":   return false;  // could be wired from storage
      default:           return false;
    }
  }

  // -- predicate labeling ----------------------------------------------------

  function axisKey(p) {
    if (p.any) return "any:" + p.any.map(axisKey).join("|");
    if (p.all) return "all:" + p.all.map(axisKey).join("&");
    if (p.not) return "not:" + axisKey(p.not);
    switch (p.type) {
      case "research":   return `tech:${p.tech}`;
      case "skill":      return `skill:${p.skill}:${p.level}`;
      case "component":  return `component:${p.id}:${p.state || "functioning"}`;
      case "operator-at":return `operator-at:${p.component}${p.skill ? ":" + p.skill + ":" + p.level : ""}`;
      case "profession": return `profession:${p.role}`;
      case "resource":   return `resource:${p.id}:${p.min || 1}`;
    }
    return JSON.stringify(p);
  }

  function axisLabel(p, tree) {
    if (p.any) return p.any.map((q) => axisLabel(q, tree)).join(" OR ");
    if (p.all) return p.all.map((q) => axisLabel(q, tree)).join(" AND ");
    if (p.not) return "NOT " + axisLabel(p.not, tree);
    switch (p.type) {
      case "research":   return `Research: ${techName(p.tech)}`;
      case "skill":      return `${p.skill} ≥ ${p.level}`;
      case "component":  return `Component: ${p.id} (${p.state || "functioning"})`;
      case "operator-at":return `Operator at ${p.component}${p.skill ? ` with ${p.skill} ≥ ${p.level}` : ""}`;
      case "profession": return `Profession: ${p.role}`;
      case "resource":   return `Resource: ${p.id} ≥ ${p.min || 1}`;
    }
    return JSON.stringify(p);
  }

  function techName(id) {
    // Pull from cached /library/techs if a previous fetch populated it.
    if (window._techIndex) {
      const t = window._techIndex.get(String(id));
      if (t) return t.name;
    }
    return `#${id}`;
  }

  // Best-effort tech index load. Idempotent.
  function ensureTechIndex() {
    if (window._techIndex) return;
    fetch("/library/techs").then((r) => r.json()).then((list) => {
      window._techIndex = new Map((list || []).map((t) => [String(t.id), t]));
    }).catch(() => {});
  }

  // -- skill aggregation -----------------------------------------------------

  function computeMaxSkills(crewObj) {
    const out = {};
    const list = Array.isArray(crewObj) ? crewObj : Object.values(crewObj || {});
    for (const c of list) {
      for (const s of c.skills || []) {
        if (!s || !s.name) continue;
        if (!out[s.name] || s.level > out[s.name]) out[s.name] = s.level;
      }
    }
    return out;
  }

  // -- util ------------------------------------------------------------------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // -- registration ----------------------------------------------------------

  if (typeof SH === "object" && typeof SH.registerWidget === "function") {
    ensureTechIndex();
    SH.registerWidget({
      id: "capabilities-browser",
      name: "Capabilities",
      category: "Meta",
      description: "See which widgets + rules each upgrade would unlock",
      icon: "🔓",
      render,
      update,
      dispose,
    });
  }
})();
