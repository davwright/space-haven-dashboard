"use strict";

// =============================================================================
//  Space Haven Dashboard — frontend.
//
//  Three views: Crew (Numbers-mod style table), Nutrition (stomach/belly bars
//  + ship storage), Galaxy (zoomable star map with fog-of-war fade).
//
//  Data comes from the Node server's /history endpoints; live updates push
//  a "snapshot" SSE event whenever a new save is ingested.
// =============================================================================

const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);

const state = {
  days: [],
  currentDay: 0,
  snapshot: null,
  playing: false,
  playTimer: null,
  sortKey: "name",
  sortAsc: true,
  needsAttentionOnly: false,
  hungerOnly: false,
  galaxy: { scale: 1, tx: 0, ty: 0, drag: null },
};

// ---------------------------------------------------------------------------
//  Severity bands (six discrete buckets, applied uniformly across stats).
//  See style.css for the colors.
// ---------------------------------------------------------------------------

function severity(stat, v) {
  if (v == null || Number.isNaN(v)) return "neutral";
  // Mood ranges roughly -100 .. +100. Vitals 0..100+.
  if (stat === "mood") {
    if (v <= -40) return "extreme";
    if (v <= -15) return "major";
    if (v <= 5)   return "minor";
    if (v <= 20)  return "neutral";
    if (v <= 50)  return "content";
    return "happy";
  }
  // health / food / rest / comfort
  if (v <= 15) return "extreme";
  if (v <= 30) return "major";
  if (v <= 50) return "minor";
  if (v <= 70) return "neutral";
  if (v <= 90) return "content";
  return "happy";
}

// Used for Conditions (negative mood accumulator sum).
function conditionSeverity(totalMoodAc) {
  if (totalMoodAc <= -20) return "extreme";
  if (totalMoodAc <= -8)  return "major";
  if (totalMoodAc < 0)    return "minor";
  if (totalMoodAc > 0)    return "happy";
  return "neutral";
}

function trend(now, longTerm) {
  if (now == null || longTerm == null) return "";
  const diff = now - longTerm;
  if (Math.abs(diff) < 3) return "";
  return diff > 0 ? "up" : "dn";
}

// ---------------------------------------------------------------------------
//  Header / nav
// ---------------------------------------------------------------------------

document.querySelectorAll("header nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("header nav button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $("view-" + btn.dataset.view).classList.add("active");
    // Some views render on demand
    if (btn.dataset.view === "crew") renderCrew();
    else if (btn.dataset.view === "nutrition") renderNutrition();
    else if (btn.dataset.view === "galaxy") renderGalaxy();
  });
});

// ---------------------------------------------------------------------------
//  Data fetch
// ---------------------------------------------------------------------------

async function loadDays() {
  const r = await fetch("/history/days");
  state.days = await r.json();
  if (state.days.length === 0) {
    $("day-pill").textContent = "no snapshots yet";
    return;
  }
  const first = state.days[0].game_day;
  const last = state.days[state.days.length - 1].game_day;
  const slider = $("day-slider");
  slider.min = first;
  slider.max = last;
  slider.value = last;
  state.currentDay = last;
  $("day-range").textContent = `(day ${first}–${last}, ${state.days.length} snapshots)`;
  await renderTickMarks();
  await loadSnapshot(last);
}

async function loadSnapshot(day) {
  const r = await fetch(`/history/snapshot/${day}`);
  if (!r.ok) return;
  state.snapshot = await r.json();
  $("day-label").textContent = `Day ${state.snapshot.gameDay}`;
  $("day-pill").textContent = `Day ${state.snapshot.gameDay}`;
  // Re-render whichever view is active
  const active = document.querySelector(".view.active");
  if (!active) return;
  if (active.id === "view-crew") renderCrew();
  else if (active.id === "view-nutrition") renderNutrition();
  else if (active.id === "view-galaxy") renderGalaxy();
}

async function renderTickMarks() {
  const r = await fetch("/history/timeline-ticks");
  const ticks = await r.json();
  document.getElementById("tick-marks")?.remove();
  const bar = $("slider-bar");
  const wrap = document.createElement("div");
  wrap.id = "tick-marks";
  bar.appendChild(wrap);
  const slider = $("day-slider");
  const min = Number(slider.min);
  const max = Number(slider.max);
  const span = Math.max(1, max - min);
  for (const t of ticks) {
    const left = ((t.day - min) / span) * 100;
    const el = document.createElement("div");
    el.className = `tick type-${t.type}`;
    el.style.left = `${left}%`;
    el.title = `Day ${t.day}: ${t.text || `event type ${t.type}`}`;
    wrap.appendChild(el);
  }
}

// ===========================================================================
//  CREW VIEW
// ===========================================================================

document.querySelectorAll(".crew-table th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortAsc = !state.sortAsc;
    else { state.sortKey = k; state.sortAsc = true; }
    renderCrew();
  });
});
$("needs-attention").addEventListener("change", (e) => {
  state.needsAttentionOnly = e.target.checked;
  renderCrew();
});

function renderCrew() {
  if (!state.snapshot) return;
  const crew = state.snapshot.crew || [];

  // Highlight the active sort header
  document.querySelectorAll(".crew-table th").forEach((th) => {
    th.classList.toggle("sort-active", th.dataset.sort === state.sortKey);
    th.classList.toggle("asc", state.sortAsc);
  });

  let rows = crew.slice();

  if (state.needsAttentionOnly) {
    rows = rows.filter(needsAttention);
  }

  rows.sort((a, b) => {
    const av = a[state.sortKey] ?? "";
    const bv = b[state.sortKey] ?? "";
    if (typeof av === "number" && typeof bv === "number") {
      return state.sortAsc ? av - bv : bv - av;
    }
    return state.sortAsc
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  $("crew-count").textContent = `${rows.length} / ${crew.length} crew`;
  $("crew-body").innerHTML = rows.map(crewRow).join("");

  // Tooltip handlers on condition icons
  document.querySelectorAll(".cond[data-tip]").forEach((el) => {
    el.addEventListener("mouseenter", (ev) => showTooltip(ev, el.dataset.tip));
    el.addEventListener("mouseleave", hideTooltip);
    el.addEventListener("mousemove", (ev) => moveTooltip(ev));
  });
}

function needsAttention(c) {
  return ["mood","health","food","rest","comfort"]
    .some((k) => severity(k, c[k]) === "extreme")
    || severity("mood", c.mood) === "major" && (c.food ?? 100) < 30;
}

function crewRow(c) {
  const attn = needsAttention(c) ? " attention" : "";
  const conditions = conditionStrip(c.conditions || []);
  const topSkills = topSkillsCell(c.skills || []);
  return `<tr class="${attn.trim()}">
    <td class="name">${esc(c.name || c.cid)}</td>
    ${statCell("mood", c.mood, c.mood_long)}
    ${statCell("health", c.health, c.health_long)}
    ${statCell("food", c.food, c.food_long)}
    ${statCell("rest", c.rest, c.rest_long)}
    ${statCell("comfort", c.comfort, c.comfort_long)}
    ${statCell("oxygen", c.oxygen, null)}
    <td>${conditions}</td>
    <td>${topSkills}</td>
    <td class="muted">${esc(c.task || "")}</td>
  </tr>`;
}

function statCell(key, val, longVal) {
  if (val == null) return `<td class="muted">–</td>`;
  const sev = severity(key, val);
  const tr = trend(val, longVal);
  const arrow = tr ? `<span class="trend ${tr}">${tr === "up" ? "▲" : "▼"}</span>` : "";
  return `<td><span class="stat"><span class="swatch s-${sev}"></span><span class="val">${Math.round(val)}</span>${arrow}</span></td>`;
}

// PSI-inspired condition strip: each crew has a fixed 12 slots that never
// collapse, so columns line up across rows. Slots with no condition show as
// an empty circle outline.
const STRIP_SLOTS = 12;
function conditionStrip(conditions) {
  const slots = [];
  for (let i = 0; i < STRIP_SLOTS; i++) {
    const cond = conditions[i];
    if (!cond) {
      slots.push(`<span class="cond empty"></span>`);
      continue;
    }
    const moodSum = (cond.moodAccumulators || []).reduce((s, n) => s + n, 0);
    const sev = conditionSeverity(moodSum);
    const tip = `<strong>Condition #${cond.id}</strong> (level ${cond.level})<br>` +
                `mood: ${moodSum >= 0 ? "+" : ""}${moodSum}` +
                (cond.rateAccumulators?.length
                  ? `<br>rate: ${cond.rateAccumulators.join(", ")}` : "");
    slots.push(`<span class="cond active s-${sev}" data-tip="${esc(tip).replace(/"/g, "&quot;")}"></span>`);
  }
  return `<span class="cond-strip">${slots.join("")}</span>`;
}

function topSkillsCell(skills) {
  const top = skills
    .filter((s) => s.level > 0)
    .sort((a, b) => b.level - a.level || b.maxLevelNormal - a.maxLevelNormal)
    .slice(0, 3);
  if (top.length === 0) return `<span class="muted">–</span>`;
  return `<span class="skills-cell">${top.map(skillChip).join("")}</span>`;
}

function skillChip(s) {
  // Passion flames: 1 flame for mxn 1-4, 2 flames for mxn 5+.
  const flames = s.maxLevelNormal >= 5 ? "▲▲" : s.maxLevelNormal >= 1 ? "▲" : "";
  return `<span class="skill-chip" title="Skill #${s.sk} · level ${s.level} (max ${s.maxLevelNormal})">
    <span class="sk-lvl">${s.level}</span>
    <span class="passion">${flames}</span>
  </span>`;
}

// ===========================================================================
//  NUTRITION VIEW
// ===========================================================================

$("hunger-only").addEventListener("change", (e) => {
  state.hungerOnly = e.target.checked;
  renderNutrition();
});

function renderNutrition() {
  if (!state.snapshot) return;
  const crew = state.snapshot.crew || [];
  let rows = crew.slice();
  if (state.hungerOnly) {
    rows = rows.filter((c) => (c.food ?? 100) < 50 || (c.food_long ?? 100) < 30);
  }

  $("nutrition-grid").innerHTML = rows.map(nutRow).join("");

  // Storage panel — group by elementaryId; we don't have a name table yet so
  // we show "Item #ID".
  const storage = (state.snapshot.storage || []).slice().sort((a, b) => b.count - a.count);
  $("storage-list").innerHTML = storage
    .filter((s) => s.count > 0)
    .map((s) => `<div class="storage-item"><span>Item #${esc(s.elementary_id)}</span><span>${formatNum(s.count)}</span></div>`)
    .join("") || `<div class="muted">No storage observations yet.</div>`;
}

function nutRow(c) {
  const distress = (c.food ?? 100) < 30 || (c.food_long ?? 100) < 20;
  return `<div class="nut-row ${distress ? "distress" : ""}">
    <div class="nut-name">
      ${esc(c.name || c.cid)}
      <span class="sub">food ${Math.round(c.food ?? 0)} · long ${Math.round(c.food_long ?? 0)}</span>
    </div>
    ${nutBarBlock("Stomach", c.nutrition?.stomach)}
    ${nutBarBlock("Belly", c.nutrition?.belly)}
  </div>`;
}

function nutBarBlock(label, n) {
  const parts = ["protein", "carbs", "fat", "vitamins", "toxins"];
  const vals = parts.map((k) => Math.max(0, n?.[k] ?? 0));
  const total = vals.reduce((s, v) => s + v, 0);
  // If empty, draw a faint placeholder bar.
  if (total <= 0) {
    return `<div class="nut-bar-block">
      <div class="nut-bar-label"><span>${label}</span><span>empty</span></div>
      <div class="nut-bar"></div>
    </div>`;
  }
  // Scale each segment as percent of total (so the bar always fills).
  const segs = parts
    .map((k, i) => ({ k, v: vals[i] }))
    .filter((s) => s.v > 0)
    .map((s) => `<div class="seg ${s.k}" style="width:${(s.v / total) * 100}%" title="${s.k}: ${s.v.toFixed(2)}"></div>`)
    .join("");
  return `<div class="nut-bar-block">
    <div class="nut-bar-label"><span>${label}</span><span>${total.toFixed(1)}</span></div>
    <div class="nut-bar">${segs}</div>
  </div>`;
}

function formatNum(n) {
  if (n == null) return "–";
  return Math.round(n * 10) / 10;
}

// ===========================================================================
//  GALAXY VIEW
// ===========================================================================

function starColor(starClass) {
  switch ((starClass || "").toUpperCase()) {
    case "O": return "#9bb0ff";
    case "B": return "#aabfff";
    case "A": return "#cad7ff";
    case "F": return "#f8f7ff";
    case "G": return "#fff4ea";
    case "K": return "#ffd2a1";
    case "M": return "#ffcc6f";
    default:  return "#dee2ff";
  }
}

function renderGalaxy() {
  const svg = $("galaxy-svg");
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!state.snapshot) return;
  const bodies = state.snapshot.bodies || [];
  const ships = state.snapshot.ships || [];

  if (bodies.length === 0) return;

  // World-space bounds
  const xs = bodies.map((b) => b.x);
  const ys = bodies.map((b) => b.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const padX = Math.max(2000, (maxX - minX) * 0.08);
  const padY = Math.max(2000, (maxY - minY) * 0.08);
  const baseW = maxX - minX + padX * 2;
  const baseH = maxY - minY + padY * 2;
  const baseX = minX - padX;
  const baseY = minY - padY;

  // Pan + zoom via viewBox manipulation.
  const g = state.galaxy;
  const w = baseW / g.scale;
  const h = baseH / g.scale;
  svg.setAttribute("viewBox", `${baseX + g.tx} ${baseY + g.ty} ${w} ${h}`);

  // Group bodies by system to draw system labels.
  const bySystem = new Map();
  for (const b of bodies) {
    const key = b.system_id || "_";
    if (!bySystem.has(key)) bySystem.set(key, { name: b.system_name, bodies: [] });
    bySystem.get(key).bodies.push(b);
  }
  for (const [, sys] of bySystem) {
    if (!sys.name || sys.bodies.length === 0) continue;
    const sxs = sys.bodies.map((b) => b.x);
    const sys_x = sxs.reduce((a, b) => a + b, 0) / sxs.length;
    const sys_y = Math.min(...sys.bodies.map((b) => b.y)) - 1500;
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", sys_x); t.setAttribute("y", sys_y);
    t.setAttribute("class", "system-label");
    t.setAttribute("font-size", 1200);
    t.textContent = sys.name;
    svg.appendChild(t);
  }

  // Ship trajectories (background).
  for (const ship of ships) {
    if (!ship.path || ship.path.length < 2) continue;
    const d = ship.path
      .filter((p) => p.x != null && p.y != null)
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
      .join(" ");
    if (!d) continue;
    const pathEl = document.createElementNS(SVG_NS, "path");
    pathEl.setAttribute("d", d);
    pathEl.setAttribute("class", "ship-path");
    svg.appendChild(pathEl);
  }

  // Bodies.
  for (const b of bodies) {
    const node = drawBody(b);
    svg.appendChild(node);
  }

  // Ships (markers).
  for (const ship of ships) {
    const node = drawShip(ship);
    if (node) svg.appendChild(node);
  }
}

function bodyRadius(b) {
  switch (b.type) {
    case "Star": return 1400;
    case "Planet": return 700;
    case "Moon": return 320;
    case "AsteroidField": return 200;
    default: return 500;
  }
}

function drawBody(b) {
  const g = document.createElementNS(SVG_NS, "g");
  let cls = "body";
  if (b.type === "Star") cls += " star";
  else if (b.type === "Planet") cls += " planet";
  else if (b.type === "Moon") cls += " moon";
  else if (b.type === "AsteroidField") cls += " asteroid-field";
  if (!b.present) cls += " faded";
  g.setAttribute("class", cls);

  if (b.type === "AsteroidField") {
    // Draw a scatter of small dots.
    for (let i = 0; i < 8; i++) {
      const r = bodyRadius(b);
      const dx = (Math.sin(i * 7 + Number(b.body_id)) * r);
      const dy = (Math.cos(i * 11 + Number(b.body_id)) * r);
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", b.x + dx);
      c.setAttribute("cy", b.y + dy);
      c.setAttribute("r", 70);
      c.setAttribute("fill", "#a89a82");
      g.appendChild(c);
    }
  } else {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", b.x);
    c.setAttribute("cy", b.y);
    c.setAttribute("r", bodyRadius(b));
    if (b.type === "Star") {
      c.setAttribute("fill", starColor(b.star_class));
      c.setAttribute("filter", "url(#glow)");
    } else if (b.type === "Planet") {
      c.setAttribute("fill", "#6e8bff");
    } else if (b.type === "Moon") {
      c.setAttribute("fill", "#a8b0c4");
    }
    g.appendChild(c);

    if (b.type === "Star" && b.system_name) {
      // System name as label on star
    }
  }

  // Hover tooltip
  g.addEventListener("mouseenter", (ev) => showTooltip(ev, bodyTooltip(b)));
  g.addEventListener("mousemove", (ev) => moveTooltip(ev));
  g.addEventListener("mouseleave", hideTooltip);

  return g;
}

function drawShip(ship) {
  const last = ship.path?.[ship.path.length - 1];
  if (!last || last.x == null || last.y == null) return null;
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "ship" + (ship.present ? "" : " faded"));
  const tri = document.createElementNS(SVG_NS, "polygon");
  const r = 400;
  tri.setAttribute("points", `${last.x},${last.y - r} ${last.x - r},${last.y + r * 0.7} ${last.x + r},${last.y + r * 0.7}`);
  tri.setAttribute("fill", factionColor(ship.faction_id));
  tri.setAttribute("stroke", "#000");
  tri.setAttribute("stroke-width", 40);
  g.appendChild(tri);
  g.addEventListener("mouseenter", (ev) => showTooltip(ev, shipTooltip(ship)));
  g.addEventListener("mousemove", (ev) => moveTooltip(ev));
  g.addEventListener("mouseleave", hideTooltip);
  return g;
}

function factionColor(factionId) {
  // Cheap palette derived from factionId hash.
  const palette = ["#ff7755", "#ffaa55", "#55c8a8", "#88aaff", "#c66bff", "#ffd166", "#f06292"];
  if (factionId == null) return "#ff7755";
  let h = 0;
  for (const ch of String(factionId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function bodyTooltip(b) {
  const lines = [
    `<strong>${esc(b.type)}${b.star_class ? ` (${esc(b.star_class)})` : ""}</strong>`,
    b.system_name ? `system: ${esc(b.system_name)}` : null,
    `id ${esc(b.body_id)}`,
  ].filter(Boolean);
  if (!b.present) lines.push(`<em>last seen day ${b.lastSeenDay}</em>`);
  if (b.visited) lines.push("visited");
  if (b.saved) lines.push("saved");
  return lines.join("<br>");
}

function shipTooltip(s) {
  const lines = [
    `<strong>${esc(s.name || "Unknown ship")}</strong>`,
    s.faction_id ? `faction ${esc(s.faction_id)}` : null,
    `${s.path?.length || 0} observation${(s.path?.length || 0) === 1 ? "" : "s"}`,
  ].filter(Boolean);
  if (!s.present) lines.push(`<em>last seen day ${s.lastSeenDay}</em>`);
  return lines.join("<br>");
}

// Tooltip
const tooltip = $("tooltip");
function showTooltip(ev, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  moveTooltip(ev);
}
function moveTooltip(ev) {
  const wrap = $("galaxy-canvas-wrap") || document.body;
  const rect = wrap.getBoundingClientRect();
  let x = ev.clientX - rect.left + 12;
  let y = ev.clientY - rect.top + 12;
  if (x + tooltip.offsetWidth > rect.width) x = rect.width - tooltip.offsetWidth - 8;
  if (y + tooltip.offsetHeight > rect.height) y = rect.height - tooltip.offsetHeight - 8;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}
function hideTooltip() {
  tooltip.hidden = true;
}

// ----- Galaxy pan + zoom -----
const svg = $("galaxy-svg");
svg.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2;
  state.galaxy.scale *= factor;
  state.galaxy.scale = Math.max(0.5, Math.min(60, state.galaxy.scale));
  renderGalaxy();
}, { passive: false });

svg.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  state.galaxy.drag = { x: ev.clientX, y: ev.clientY, tx0: state.galaxy.tx, ty0: state.galaxy.ty };
  svg.classList.add("dragging");
});
window.addEventListener("mousemove", (ev) => {
  if (!state.galaxy.drag) return;
  const rect = svg.getBoundingClientRect();
  if (!state.snapshot?.bodies?.length) return;
  const xs = state.snapshot.bodies.map((b) => b.x);
  const ys = state.snapshot.bodies.map((b) => b.y);
  const baseW = (Math.max(...xs) - Math.min(...xs)) || 1;
  const baseH = (Math.max(...ys) - Math.min(...ys)) || 1;
  const dx = (ev.clientX - state.galaxy.drag.x) * baseW / rect.width / state.galaxy.scale;
  const dy = (ev.clientY - state.galaxy.drag.y) * baseH / rect.height / state.galaxy.scale;
  state.galaxy.tx = state.galaxy.drag.tx0 - dx;
  state.galaxy.ty = state.galaxy.drag.ty0 - dy;
  renderGalaxy();
});
window.addEventListener("mouseup", () => {
  state.galaxy.drag = null;
  svg.classList.remove("dragging");
});

// ===========================================================================
//  Slider / playback
// ===========================================================================

$("day-slider").addEventListener("input", () => {
  state.currentDay = Number($("day-slider").value);
  loadSnapshot(state.currentDay);
});

$("play-btn").addEventListener("click", () => {
  state.playing = !state.playing;
  $("play-btn").innerHTML = state.playing ? "&#10074;&#10074;" : "&#9654;";
  if (state.playing) {
    state.playTimer = setInterval(() => {
      const slider = $("day-slider");
      const next = Number(slider.value) + 1;
      if (next > Number(slider.max)) {
        clearInterval(state.playTimer);
        state.playing = false;
        $("play-btn").innerHTML = "&#9654;";
        return;
      }
      slider.value = next;
      state.currentDay = next;
      loadSnapshot(next);
    }, 1000);
  } else if (state.playTimer) {
    clearInterval(state.playTimer);
  }
});

// ===========================================================================
//  Utilities
// ===========================================================================

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ===========================================================================
//  Live updates via SSE
// ===========================================================================

function startSSE() {
  const es = new EventSource("/events");
  es.addEventListener("hello", () => $("live").classList.remove("off"));
  es.addEventListener("snapshot", async () => {
    await loadDays();
    await renderTickMarks();
  });
  es.onerror = () => $("live").classList.add("off");
}

loadDays().then(startSSE);
