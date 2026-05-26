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
  galaxy: {
    scale: 1, tx: 0, ty: 0, drag: null, focusSystem: null,
    // Player ship galaxy path (cached: fetched once per page load / SSE push).
    shipPath: null,
    // viewBox center the renderer should produce on the next paint, plus the
    // currently-animating-toward viewBox for the camera-follow animation.
    cameraTarget: null,
    cameraAnim: null,
    // setTimeout id for the "slider idle → auto-zoom into current system".
    autoZoomTimer: null,
  },
};

// In-game skill order (12 visible + 2 hidden), with sk numeric ids from the
// save file. Maintenance/Logistics (12/13) are not in the standard panel.
const SKILL_COLUMNS = [
  { sk: 2,  name: "Mining",      abbr: "Min" },
  { sk: 4,  name: "Construct",   abbr: "Con" },
  { sk: 5,  name: "Industry",    abbr: "Ind" },
  { sk: 3,  name: "Botany",      abbr: "Bot" },
  { sk: 6,  name: "Medical",     abbr: "Med" },
  { sk: 16, name: "Research",    abbr: "Res" },
  { sk: 10, name: "Weapons",     abbr: "Wep" },
  { sk: 14, name: "Navigation",  abbr: "Nav" },
  { sk: 7,  name: "Gunner",      abbr: "Gun" },
  { sk: 8,  name: "Shielding",   abbr: "Shi" },
  { sk: 9,  name: "Operations",  abbr: "Ops" },
  { sk: 22, name: "Piloting",    abbr: "Pil" },
  { sk: 12, name: "Maintenance", abbr: "Mai", extra: true },
  { sk: 13, name: "Logistics",   abbr: "Log", extra: true },
];

const ATTR_COLUMNS = [
  { key: "bravery",      name: "Bravery",      abbr: "Bra" },
  { key: "zest",         name: "Zest",         abbr: "Zes" },
  { key: "intelligence", name: "Intelligence", abbr: "Int" },
  { key: "perception",   name: "Perception",   abbr: "Per" },
];

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
    if (btn.dataset.view === "status") renderStatus();
    else if (btn.dataset.view === "skills") renderSkills();
    else if (btn.dataset.view === "nutrition") renderNutrition();
    else if (btn.dataset.view === "storage") renderStorage();
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
  const raw = await r.json();
  state.snapshot = raw;
  // Mirror into SH.tree (object-keyed-by-id shape) so the framework layer is
  // always populated alongside the legacy state.snapshot. Tabs migrate one
  // at a time; until they do, both representations coexist.
  SH.replaceTree(SH.normalizeSnapshot(raw));
  $("day-label").textContent = `Day ${state.snapshot.gameDay}`;
  $("day-pill").textContent = `Day ${state.snapshot.gameDay}`;
  // Re-render whichever view is active
  const active = document.querySelector(".view.active");
  if (!active) return;
  if (active.id === "view-status") renderStatus();
  else if (active.id === "view-skills") renderSkills();
  else if (active.id === "view-nutrition") renderNutrition();
  else if (active.id === "view-storage") renderStorage();
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
//  STATUS VIEW (mood/vitals/conditions)
// ===========================================================================

document.querySelectorAll("#view-status .crew-table th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortAsc = !state.sortAsc;
    else { state.sortKey = k; state.sortAsc = true; }
    renderStatus();
  });
});
$("needs-attention").addEventListener("change", (e) => {
  state.needsAttentionOnly = e.target.checked;
  renderStatus();
});

// Stat keys that get bound to live patches. The Conditions column stays
// imperative for now — it's a fixed-width icon strip rebuilt on each
// structural render.
const STATUS_LIVE_KEYS = ["mood", "health", "food", "rest", "comfort", "oxygen", "temperature"];

function renderStatus() {
  if (!state.snapshot) return;
  const crewArr = state.snapshot.crew || [];

  // Highlight the active sort header
  document.querySelectorAll("#view-status .crew-table th").forEach((th) => {
    th.classList.toggle("sort-active", th.dataset.sort === state.sortKey);
    th.classList.toggle("asc", state.sortAsc);
  });

  let rows = crewArr.slice();

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

  $("crew-count").textContent = `${rows.length} / ${crewArr.length} crew`;

  // Tear down old bindings from the previous render: every node under
  // status-body that has bindings registered. We just clear by iterating
  // the table body; SH.unbindCell tolerates nodes with no bindings.
  const body = $("status-body");
  body.querySelectorAll(".stat-bar, .stat-bar .fill, .stat-bar .over-fill, .stat-bar .val")
      .forEach((el) => SH.unbindCell(el));

  // Structural render: build the rows in one innerHTML pass (cheap, ~6 rows),
  // then walk back over them to register surgical bindings on each cell.
  body.innerHTML = rows.map(statusRow).join("");

  for (const c of rows) {
    if (c.cid == null) continue;
    const tr = body.querySelector(`tr[data-cid="${c.cid}"]`);
    if (!tr) continue;
    for (const key of STATUS_LIVE_KEYS) {
      const bar = tr.querySelector(`.stat-bar[data-stat="${key}"]`);
      if (!bar) continue;
      bindStatCell(`/crew/${c.cid}/${key}`, bar, key, c[`${key}_long`]);
    }
  }

  // Tooltip handlers on condition icons
  document.querySelectorAll("#status-body .cond[data-tip]").forEach((el) => {
    el.addEventListener("mouseenter", (ev) => showTooltip(ev, el.dataset.tip));
    el.addEventListener("mouseleave", hideTooltip);
    el.addEventListener("mousemove", (ev) => moveTooltip(ev));
  });
}

// Bind a stat-bar wrapper to a path. The renderFn recomputes severity class,
// fill width(s), and the displayed integer in-place — no innerHTML on the
// wrapper or its children, so no orphaned bindings.
function bindStatCell(path, barEl, key, longVal) {
  const fill = barEl.querySelector(".fill");
  const overFill = barEl.querySelector(".over-fill");
  const val = barEl.querySelector(".val");
  SH.bindCell(path, barEl, (node, v) => {
    if (v == null || Number.isNaN(v)) return;
    const sev = severity(key, v);
    // Replace just the s-* token; preserve the rest of the class list
    // (especially the "over" modifier and any future siblings).
    node.classList.remove("s-extreme", "s-major", "s-minor", "s-neutral", "s-content", "s-happy");
    node.classList.add(`s-${sev}`);
    let basePct, overPct = 0;
    if (key === "mood") {
      basePct = Math.max(0, Math.min(100, (v + 100) / 2));
    } else {
      basePct = Math.max(0, Math.min(100, v));
      // Overflow: show as a stripe overlay INSIDE the bar (0..100% width),
      // so it never bleeds onto neighbouring table cells. Cap at v=200.
      if (v > 100) overPct = Math.min(100, ((v - 100) / 100) * 100);
    }
    if (overPct > 0) node.classList.add("over"); else node.classList.remove("over");
    if (fill) fill.style.width = `${basePct}%`;
    if (overFill) overFill.style.width = `${overPct}%`;
    if (val) val.textContent = Math.round(v);
    const tip = longVal != null
      ? `${Math.round(v)} (long-term ${Math.round(longVal)})`
      : `${Math.round(v)}`;
    node.setAttribute("title", tip);
  });
}

function needsAttention(c) {
  return ["mood","health","food","rest","comfort"]
    .some((k) => severity(k, c[k]) === "extreme")
    || severity("mood", c.mood) === "major" && (c.food ?? 100) < 30;
}

function statusRow(c) {
  const attn = needsAttention(c) ? " attention" : "";
  const conditions = conditionStrip(c.conditions || []);
  const task = c.task ? `<span class="sub">${esc(c.task)}</span>` : "";
  const cidAttr = c.cid != null ? ` data-cid="${esc(c.cid)}"` : "";
  return `<tr class="${attn.trim()}"${cidAttr}>
    <td class="name">${esc(c.name || c.cid)}${task}</td>
    ${statCell("mood", c.mood, c.mood_long)}
    ${statCell("health", c.health, c.health_long)}
    ${statCell("food", c.food, c.food_long)}
    ${statCell("rest", c.rest, c.rest_long)}
    ${statCell("comfort", c.comfort, c.comfort_long)}
    ${statCell("oxygen", c.oxygen, null)}
    ${statCell("temperature", c.temperature, null)}
    <td>${conditions}</td>
  </tr>`;
}

function statCell(key, val, longVal) {
  if (val == null) return `<td class="muted">–</td>`;
  return `<td>${statBar(key, val, longVal)}</td>`;
}

// Horizontal stat bar with value overlay. Used in Status tab vitals and the
// Nutrition tab Health column.
//
// The skeleton always includes a .fill, .over-fill, and .val span so that
// bindCell renderers can drive them surgically — even if the current value
// puts over-fill at 0% width.
function statBar(key, val, longVal) {
  const sev = severity(key, val);
  const tr = trend(val, longVal);
  const arrow = tr ? `<span class="trend ${tr}">${tr === "up" ? "▲" : "▼"}</span>` : "";
  let basePct, overPct = 0;
  if (key === "mood") {
    basePct = Math.max(0, Math.min(100, (val + 100) / 2));
  } else {
    basePct = Math.max(0, Math.min(100, val));
    // Overflow rendered as an inside-the-bar stripe overlay (0..100% width
    // of the bar), scaled against a v=200 ceiling. Never bleeds out.
    if (val > 100) overPct = Math.min(100, ((val - 100) / 100) * 100);
  }
  const overflowAttr = overPct > 0 ? " over" : "";
  const tip = longVal != null
    ? `${Math.round(val)} (long-term ${Math.round(longVal)})`
    : `${Math.round(val)}`;
  return `<span class="stat-bar s-${sev}${overflowAttr}" data-stat="${key}" title="${tip}">`
       + `<span class="fill" style="width:${basePct}%"></span>`
       + `<span class="over-fill" style="width:${overPct}%"></span>`
       + `<span class="val">${Math.round(val)}</span>`
       + arrow
       + `</span>`;
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
    const label = cond.name || `Condition #${cond.id}`;
    const tip = `<strong>${label}</strong> (level ${cond.level})<br>` +
                `mood: ${moodSum >= 0 ? "+" : ""}${moodSum}` +
                (cond.rateAccumulators?.length
                  ? `<br>rate: ${cond.rateAccumulators.join(", ")}` : "");
    slots.push(`<span class="cond active s-${sev}" data-tip="${esc(tip).replace(/"/g, "&quot;")}"></span>`);
  }
  return `<span class="cond-strip">${slots.join("")}</span>`;
}

// ===========================================================================
//  SKILLS VIEW (traits + attributes + 14 skill columns, multi-sort)
// ===========================================================================

// Module-level sort state. Each entry: { key, direction }
// key ∈ { 'name', 'bravery', 'zest', 'intelligence', 'perception', <sk:number> }
let skillSort = [];

function renderSkills() {
  if (!state.snapshot) return;
  const crew = state.snapshot.crew || [];

  // Build header row from spec.
  const head = $("skills-head");
  const headCells = [];
  headCells.push(skillHeaderCell("name", "Name", false));
  headCells.push(`<th class="traits-col">Traits</th>`);
  for (const a of ATTR_COLUMNS) {
    headCells.push(skillHeaderCell(a.key, a.name, false, a.name, "attr-col"));
  }
  for (const c of SKILL_COLUMNS) {
    const cls = "skill-col" + (c.extra ? " skill-extra" : "");
    headCells.push(skillHeaderCell(c.sk, c.name, true, c.name, cls));
  }
  head.innerHTML = headCells.join("");

  // Wire header click handlers (rebuilt each render).
  head.querySelectorAll("th[data-sort-key]").forEach((th) => {
    th.addEventListener("click", (ev) => {
      const raw = th.dataset.sortKey;
      const key = /^\d+$/.test(raw) ? Number(raw) : raw;
      toggleSkillSort(key, ev.shiftKey);
      renderSkills();
    });
  });

  // Reset link.
  const reset = $("skills-reset");
  reset.hidden = skillSort.length === 0;
  reset.onclick = (ev) => {
    ev.preventDefault();
    skillSort = [];
    renderSkills();
  };

  const rows = sortCrewForSkills(crew);
  $("skills-count").textContent = `${rows.length} crew`;
  $("skills-body").innerHTML = rows.map(skillRow).join("");
}

function skillHeaderCell(key, label, isSkill, fullName, extraCls) {
  const idx = skillSort.findIndex((s) => s.key === key);
  let indicator = "";
  if (idx >= 0) {
    const dir = skillSort[idx].direction;
    const arrow = dir === "desc" ? "▼" : "▲";
    const sup = skillSort.length > 1 ? `<sup>${idx + 1}</sup>` : "";
    indicator = `<span class="sort-ind">${arrow}${sup}</span>`;
  }
  const cls = (extraCls || "") + (idx >= 0 ? " sort-active" : "");
  const title = fullName ? ` title="${esc(fullName)}"` : "";
  return `<th class="${cls}" data-sort-key="${key}"${title}>${esc(label)}${indicator}</th>`;
}

function toggleSkillSort(key, additive) {
  const idx = skillSort.findIndex((s) => s.key === key);
  if (!additive) {
    if (idx === -1) {
      skillSort = [{ key, direction: "desc" }];
    } else if (skillSort.length === 1) {
      // Cycle: desc → asc → remove
      const cur = skillSort[0];
      if (cur.direction === "desc") skillSort = [{ key, direction: "asc" }];
      else skillSort = [];
    } else {
      // Multiple sorts active, plain-click on one resets to single desc.
      skillSort = [{ key, direction: "desc" }];
    }
    return;
  }
  // Shift-click: add tiebreaker, or cycle the existing tiebreaker.
  if (idx === -1) {
    skillSort.push({ key, direction: "desc" });
  } else {
    const cur = skillSort[idx];
    if (cur.direction === "desc") cur.direction = "asc";
    else skillSort.splice(idx, 1);
  }
}

function getSortValue(c, key) {
  if (key === "name") return (c.name || c.cid || "").toString().toLowerCase();
  if (typeof key === "string") {
    // attribute: lookup by name (capitalized)
    const want = key.charAt(0).toUpperCase() + key.slice(1);
    const a = (c.attributes || []).find((x) => x.name === want);
    return a?.points ?? 0;
  }
  // numeric: skill sk id
  const s = (c.skills || []).find((x) => x.sk === key);
  return s?.level ?? 0;
}

function sortCrewForSkills(crew) {
  if (skillSort.length === 0) return crew;
  return [...crew].sort((a, b) => {
    for (const { key, direction } of skillSort) {
      const av = getSortValue(a, key);
      const bv = getSortValue(b, key);
      if (av < bv) return direction === "desc" ? 1 : -1;
      if (av > bv) return direction === "desc" ? -1 : 1;
    }
    return 0;
  });
}

function skillRow(c) {
  const tds = [];
  tds.push(`<td class="name">${esc(c.name || c.cid)}</td>`);
  tds.push(`<td class="traits-col">${traitsCell(c.traits || [])}</td>`);
  for (const a of ATTR_COLUMNS) {
    const want = a.key.charAt(0).toUpperCase() + a.key.slice(1);
    const attr = (c.attributes || []).find((x) => x.name === want);
    const pts = attr?.points ?? 0;
    const clamp = Math.min(7, Math.max(0, pts));
    tds.push(`<td class="attr-col attr-${clamp}">${pts}</td>`);
  }
  const skillsBySk = new Map();
  for (const s of c.skills || []) skillsBySk.set(s.sk, s);
  for (const col of SKILL_COLUMNS) {
    const cls = "skill-col" + (col.extra ? " skill-extra" : "");
    tds.push(`<td class="${cls}">${skillTallyCell(skillsBySk.get(col.sk), col.name)}</td>`);
  }
  return `<tr>${tds.join("")}</tr>`;
}

function traitsCell(traits) {
  if (!traits || traits.length === 0) return `<span class="muted">–</span>`;
  return traits
    .map((t) => `<span class="trait-chip" title="${esc(t.name || ("#" + t.id))}">${esc(t.name || ("#" + t.id))}</span>`)
    .join(" ");
}

// Exp required to reach the NEXT level from the named level (level N → N+1).
// Values verified from save data + community wiki; if any are off, the user
// will tell us.
const SKILL_EXP_THRESHOLDS = {
  0: 100, 1: 200, 2: 500, 3: 1000, 4: 2000, 5: 5400, 6: 11000, 7: 22000, 8: 45000,
};

function expThreshold(level) {
  if (level in SKILL_EXP_THRESHOLDS) return SKILL_EXP_THRESHOLDS[level];
  // Fallback for any level outside the table — geometric extrapolation.
  return Math.round(100 * Math.pow(2.2, level));
}

// Vertical tally-bar skill cell. Slot count = maxLevelNormal + passionExtra
// (mxp from the save is the *extra* slots beyond mxn, not an absolute ceiling).
// The bar at index `lvl` is the in-progress slot — rendered as a partial fill
// driven by `exp / threshold`.
function skillTallyCell(s, name) {
  const lvl = s?.level ?? 0;
  const mxn = s?.maxLevelNormal ?? 0;
  const passionExtra = s?.maxLevelPassion ?? 0;
  const exp = s?.exp ?? 0;
  const totalSlots = Math.max(mxn + passionExtra, lvl, 1);
  const thr = expThreshold(lvl);
  const frac = thr > 0 ? Math.max(0, Math.min(1, exp / thr)) : 0;

  const bars = [];
  for (let i = 0; i < totalSlots; i++) {
    const isPassionSlot = i >= mxn;
    let cls = "bar";
    if (i < lvl) {
      cls += isPassionSlot ? " filled passion" : " filled";
    } else if (i === lvl && lvl < (mxn + passionExtra) && exp > 0) {
      // In-progress slot: partial fill from the bottom up.
      cls += isPassionSlot ? " partial passion" : " partial";
    } else if (isPassionSlot) {
      cls += " passion";
    } else {
      cls += " empty";
    }
    const style = (i === lvl && cls.includes("partial")) ? ` style="--frac: ${frac.toFixed(3)};"` : "";
    bars.push(`<span class="${cls}"${style}></span>`);
  }

  const ceil = mxn + passionExtra;
  const pct = (frac * 100).toFixed(1);
  const passionStr = passionExtra > 0 ? ` (+${passionExtra} passion → ${ceil})` : "";
  const title = `${name} · level ${lvl} / max ${mxn}${passionStr} · exp ${exp} / ${thr} (${pct}%)`;
  const zeroCls = lvl === 0 ? " zero" : "";
  return `<span class="skill-cell${zeroCls}" title="${esc(title)}"><span class="lvl">${lvl}</span><span class="bars">${bars.join("")}</span></span>`;
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

  const legendWrap = $("nut-legend-wrap");
  if (legendWrap) legendWrap.innerHTML = nutLegendBlock();
  renderFoodStorage();
  renderRecipes();
  renderCrops();
  renderFertilitySupply();
  $("nutrition-grid").innerHTML = rows.map(nutRow).join("");
}

// Renders the small fertility-supply summary (compost / fertilizer / bio
// matter / corpses) into the Crops panel header. Backend may not yet expose
// these counts — if absent, the line stays empty.
const FERTILITY_NAME_HINTS = ["compost", "fertilizer", "bio matter", "biomatter", "corpse"];
function renderFertilitySupply() {
  const el = $("fertility-supply");
  if (!el) return;
  const fertility = state.snapshot.fertility;
  let parts = [];
  if (fertility && typeof fertility === "object") {
    for (const [k, v] of Object.entries(fertility)) {
      if (v == null || v === 0) continue;
      parts.push(`${esc(k)} ${formatNum(v)}`);
    }
  } else {
    // Best-effort fallback from storage counts.
    const storage = state.snapshot.storage || [];
    for (const s of storage) {
      const name = (s.name || "").toLowerCase();
      if (!FERTILITY_NAME_HINTS.some((h) => name.includes(h))) continue;
      if (!(s.count > 0)) continue;
      parts.push(`${esc(s.name)} ${formatNum(s.count)}`);
    }
  }
  el.textContent = parts.length ? "Fertility: " + parts.join(" · ") : "";
}

// Food items in storage. Prefers backend flag `food_usage_type === 'Food'`
// if present; otherwise falls back to a name heuristic. Backend extension
// pending — once present this picks it up automatically.
const FOOD_NAME_HINTS = [
  "food", "algae", "water", "vegetable", "fruit", "meat", "ice",
  "nuts", "seeds", "bio matter", "root", "iv fluid",
];
function isFoodItem(s) {
  if (s.food_usage_type === "Food") return true;
  if (s.food_usage_type) return false; // backend supplied a type and it's not Food
  const name = (s.name || "").toLowerCase();
  return FOOD_NAME_HINTS.some((h) => name.includes(h));
}

// Icon index from /library/icons, populated on first load. Each entry is
// { aid, w, h, atlas } for an element id we have a sprite for. We use the
// keys as a "has-icon" set; the PNG is served at /icons/<id>.png.
let iconIndex = null;
async function ensureIconIndex() {
  if (iconIndex) return iconIndex;
  try {
    const r = await fetch("/library/icons");
    iconIndex = await r.json();
  } catch {
    iconIndex = {};
  }
  return iconIndex;
}

// Helper to render an icon for an element id; falls back to nothing when the
// extractor didn't manage to crop that sprite.
function iconImg(elementId, alt) {
  if (!iconIndex || !iconIndex[elementId]) return "";
  return `<img class="item-icon" src="/icons/${elementId}.png" alt="${esc(alt || "")}" loading="lazy">`;
}

function renderFoodStorage() {
  const body = $("food-storage-body");
  if (!body) return;
  const storage = state.snapshot.storage || [];
  const foods = storage.filter((s) => s.count > 0 && isFoodItem(s));
  foods.sort((a, b) => b.count - a.count);
  if (foods.length === 0) {
    body.innerHTML = `<div class="muted">No food in storage.</div>`;
    return;
  }
  body.innerHTML = foods
    .map((s) => `<div class="food-item">`
       + iconImg(s.elementary_id, s.name)
       + `<span class="food-name">${esc(s.name || `Item #${s.elementary_id}`)}</span>`
       + `<span class="food-count">${formatNum(s.count)}</span>`
       + `</div>`)
    .join("");
}

// Stage names in order — total growth (0..1) split into four equal quarters.
const CROP_STAGES = ["Seedling", "Growing", "Maturing", "Mature"];
// STAGE_TIME = 1300 ticks per stage in the parser (parse-save.js). At default
// game speed ~1 tick/sec, that's ~22 min per stage. Total growth 0..1 spans
// all four stages, so a full crop cycle is ~88 min.
const STAGE_MINUTES = 22;

function bedETA(growth, stage) {
  if (stage === "Mature") return "fully grown";
  const idx = CROP_STAGES.indexOf(stage);
  if (idx < 0) return "";
  const stageStart = idx * 0.25;
  const intoStage = Math.max(0, growth - stageStart);
  const remainingFrac = Math.max(0, 0.25 - intoStage);
  // remainingFrac is fraction of total growth; convert to minutes via stage.
  const minutes = Math.max(1, Math.round((remainingFrac / 0.25) * STAGE_MINUTES));
  const next = CROP_STAGES[idx + 1] || "Mature";
  return `~${minutes}m to ${next}`;
}

function stageSeverityClass(stage) {
  switch (stage) {
    case "Seedling":  return "seedling";
    case "Growing":   return "growing";
    case "Maturing":  return "maturing";
    case "Mature":    return "mature";
    default:          return "growing";
  }
}

function renderCrops() {
  const body = $("crops-body");
  if (!body) return;
  const beds = state.snapshot.growBeds || [];
  if (beds.length === 0) {
    body.innerHTML = `<div class="muted">No grow beds.</div>`;
    return;
  }

  // Group beds by plant_id; fall back to crops.byElement names if a bed lacks
  // its plant_name (defensive — current backend always supplies one).
  const byElementMeta = state.snapshot.crops?.byElement || {};
  const groups = new Map();
  for (const bed of beds) {
    const key = String(bed.plant_id);
    if (!groups.has(key)) {
      groups.set(key, {
        plant_id: bed.plant_id,
        name: bed.plant_name || byElementMeta[key]?.name || `Item #${key}`,
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

    // Tick labels at stage boundaries (25/50/75%).
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

// Recipe filter state.
let recipeFilter = "makeable";

// Load /library/recipes once and cache on state. The list never changes for a
// given game version, so a single fetch per page load is fine.
async function ensureRecipes() {
  if (Array.isArray(state.recipes)) return state.recipes;
  try {
    const r = await fetch("/library/recipes");
    state.recipes = r.ok ? await r.json() : [];
  } catch {
    state.recipes = [];
  }
  return state.recipes;
}

function renderRecipes() {
  const body = $("recipes-body");
  if (!body) return;
  // Wire the toggle buttons (idempotent).
  document.querySelectorAll("#recipes-panel .rt-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.recipeFilter === recipeFilter);
    btn.onclick = () => {
      recipeFilter = btn.dataset.recipeFilter;
      renderRecipes();
    };
  });

  if (!Array.isArray(state.recipes)) {
    body.innerHTML = `<div class="muted">Loading recipes…</div>`;
    ensureRecipes().then(renderRecipes);
    return;
  }

  // Storage lookup by element_id.
  const storage = state.snapshot?.storage || [];
  const onHand = new Map();
  for (const s of storage) onHand.set(Number(s.elementary_id), s.count);

  // Kitchen-only — the user said "kitchen recipe".
  const kitchen = state.recipes.filter((r) => r.facility_type === "Kitchen");

  let rows;
  if (recipeFilter === "makeable") {
    rows = kitchen
      .map((r) => {
        if (!r.inputs?.length) return null;
        let canMake = Infinity;
        for (const inp of r.inputs) {
          const have = onHand.get(Number(inp.element_id)) || 0;
          const need = inp.count || 1;
          canMake = Math.min(canMake, Math.floor(have / need));
        }
        return canMake > 0 && Number.isFinite(canMake) ? { r, canMake } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.canMake - a.canMake);
  } else {
    rows = kitchen.map((r) => ({ r, canMake: null }));
  }

  if (rows.length === 0) {
    body.innerHTML = `<div class="muted">${
      recipeFilter === "makeable"
        ? "No kitchen recipe is currently makeable."
        : "No kitchen recipes available."
    }</div>`;
    return;
  }

  body.innerHTML = rows.map(({ r, canMake }) => recipeCard(r, canMake)).join("");

  // Stretch: clicking an ingredient name scrolls to the matching storage item
  // (only useful when the Storage tab is rendered; harmless otherwise).
  body.querySelectorAll(".rc-elem[data-elementary-id]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      const id = el.dataset.elementaryId;
      const target = document.querySelector(`#storage-list .storage-item[data-elementary-id="${id}"]`);
      if (target) {
        // Switch to storage tab and scroll.
        document.querySelector('header nav button[data-view="storage"]').click();
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("highlight");
        setTimeout(() => target.classList.remove("highlight"), 1500);
      }
    });
  });
}

function recipeCard(r, canMake) {
  const elem = (e) => `<a class="rc-elem" href="#" data-elementary-id="${esc(e.element_id)}">`
    + iconImg(e.element_id, e.name)
    + `${esc(e.name)}×${e.count}</a>`;
  const ins = (r.inputs || []).map(elem).join(", ") || "—";
  const outs = (r.outputs || []).map(elem).join(", ") || "—";
  const badge = canMake != null
    ? `<span class="rc-badge">×${canMake}</span>`
    : "";
  const fac = r.facility_type ? `<span class="rc-facility">${esc(r.facility_type)}</span>` : "";
  // Recipe ratio bar (backend pending). When `state.snapshot.recipeRatios`
  // ships, each entry is { element_id: weight }. Map onto input list and
  // render a segmented bar coloured by ingredient hash.
  const ratios = state.snapshot?.recipeRatios?.[String(r.recipe_pid ?? r.pid ?? r.id)] || null;
  let ratioRow = "";
  if (ratios && r.inputs?.length) {
    const total = Object.values(ratios).reduce((s, v) => s + (Number(v) || 0), 0);
    if (total > 0) {
      const segs = r.inputs.map((inp) => {
        const w = Number(ratios[String(inp.element_id)] || 0);
        if (!(w > 0)) return "";
        const pct = (w / total) * 100;
        return `<div class="rc-ratio-seg" style="width:${pct.toFixed(1)}%; background:${factionColor(inp.element_id)}" title="${esc(inp.name)} ${(w * 100).toFixed(0)}%"></div>`;
      }).join("");
      ratioRow = `<div class="rc-ratio-bar">${segs}</div>`;
    }
  }
  return `<div class="recipe-card">
    <div class="rc-head">
      <span class="rc-name">${esc(r.name)}</span>
      ${fac}
      ${badge}
    </div>
    <div class="rc-body">
      <span class="rc-inputs">${ins}</span>
      <span class="rc-arrow">→</span>
      <span class="rc-outputs">${outs}</span>
    </div>
    ${ratioRow}
  </div>`;
}

// ===========================================================================
//  STORAGE VIEW
// ===========================================================================

// In-game storage filter tab order. Anything not in this list falls into
// "Other" at the bottom (e.g. null main_cat_name from the backend).
const STORAGE_CATEGORY_ORDER = [
  "Food", "Resources", "Construction", "Fabric", "Raw Materials", "Gas / Energy",
];

function renderStorage() {
  if (!state.snapshot) return;
  const storage = (state.snapshot.storage || []).filter((s) => s.count > 0);
  $("storage-count").textContent = `${storage.length} items · ${formatNum(storage.reduce((sum, s) => sum + s.count, 0))} total units`;
  if (storage.length === 0) {
    $("storage-list").innerHTML = `<div class="muted">No storage observations yet.</div>`;
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

  // Render in the fixed order, then any extras (e.g. "Other") at the end.
  const orderedKeys = [
    ...STORAGE_CATEGORY_ORDER.filter((k) => buckets.get(k)?.length),
    ...[...buckets.keys()].filter((k) => !STORAGE_CATEGORY_ORDER.includes(k) && buckets.get(k).length),
  ];

  const html = orderedKeys.map((cat) => {
    const items = buckets.get(cat).slice().sort((a, b) =>
      (a.name || "").localeCompare(b.name || "")
    );
    const total = items.reduce((sum, s) => sum + s.count, 0);
    const rows = items
      .map((s) => `<div class="storage-item" data-elementary-id="${esc(s.elementary_id)}">`
        + iconImg(s.elementary_id, s.name)
        + `<span>${esc(s.name || `Item #${s.elementary_id}`)}</span>`
        + `<span>${formatNum(s.count)}</span>`
        + `</div>`)
      .join("");
    return `<div class="storage-category">
      <h3 class="storage-category-head"><span>${esc(cat)}</span><span class="muted">${formatNum(total)} units</span></h3>
      <div class="storage-category-items">${rows}</div>
    </div>`;
  }).join("");

  $("storage-list").innerHTML = html;
}

function nutRow(c) {
  const distress = (c.food ?? 100) < 30 || (c.food_long ?? 100) < 20;
  const healthBar = c.health != null
    ? statBar("health", c.health, c.health_long)
    : `<span class="muted">–</span>`;
  return `<div class="nut-row ${distress ? "distress" : ""}">
    <div class="nut-name">
      ${esc(c.name || c.cid)}
      <span class="sub">food ${Math.round(c.food ?? 0)} · long ${Math.round(c.food_long ?? 0)}</span>
    </div>
    <div class="nut-health">${healthBar}</div>
    <div class="nut-stack">
      ${nutBarBlock("Stomach", c.nutrition?.stomach)}
      ${nutBarBlock("Belly", c.nutrition?.belly)}
    </div>
  </div>`;
}

// Bars are scaled to a fixed reference so the empty space on the right shows
// what's missing. Each segment width = (value / NUT_MAX) * 100%.
const NUT_MAX = 100;

// Chemistry-style nutrient glyphs. Each returns a 16x16 inline SVG that
// inherits `color` via `currentColor`, so the existing --protein / --carbs /
// etc. CSS variables tint it. Used in nutrient bar segment labels and the
// legend at the top of the Nutrition tab.
function nutIcon(kind) {
  const open = `<svg class="nut-icon" viewBox="0 0 16 16" aria-hidden="true">`;
  const close = `</svg>`;
  switch (kind) {
    case "carbs": // glucose — hollow hexagonal ring (monosaccharide)
      return open
        + `<polygon points="8,2 14,5 14,11 8,14 2,11 2,5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`
        + close;
    case "sucrose": // disaccharide — two fused hexagonal rings
      return `<svg class="nut-icon" viewBox="0 0 22 16" aria-hidden="true">`
        + `<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">`
          + `<polygon points="6,2 11,4.5 11,11.5 6,14 1,11.5 1,4.5"/>`
          + `<polygon points="16,2 21,4.5 21,11.5 16,14 11,11.5 11,4.5"/>`
        + `</g>`
        + close;
    case "protein": // amino-acid backbone (zigzag with end marks)
      return open
        + `<polyline points="2,12 6,8 10,12 14,8" stroke="currentColor" stroke-width="1.5" fill="none"/>`
        + `<circle cx="2" cy="12" r="1.5" fill="currentColor"/>`
        + `<circle cx="14" cy="8" r="1.5" fill="currentColor"/>`
        + close;
    case "fat": // saturated fatty acid chain (3-ply zigzag)
      return open
        + `<polyline points="1,8 3,5 5,8 7,5 9,8 11,5 13,8 15,5" stroke="currentColor" stroke-width="1.2" fill="none"/>`
        + close;
    case "vitamins": // multi-ring molecule (five-circle cluster)
      return open
        + `<g stroke="currentColor" stroke-width="1" fill="none">`
          + `<circle cx="8" cy="8" r="2"/>`
          + `<circle cx="3" cy="8" r="2"/>`
          + `<circle cx="13" cy="8" r="2"/>`
          + `<circle cx="8" cy="3" r="2"/>`
          + `<circle cx="8" cy="13" r="2"/>`
        + `</g>`
        + close;
    case "toxins": // biohazard tri-foil
      return open
        + `<g fill="currentColor">`
          + `<circle cx="8" cy="8" r="1.6"/>`
          + `<circle cx="8" cy="3.5" r="2.2"/>`
          + `<circle cx="4" cy="11" r="2.2"/>`
          + `<circle cx="12" cy="11" r="2.2"/>`
        + `</g>`
        + `<circle cx="8" cy="8" r="1.1" fill="#0e1117"/>`
        + close;
    default:
      return "";
  }
}

const NUT_PARTS = ["protein", "carbs", "fat", "vitamins", "toxins"];
const NUT_LABELS = {
  protein: "Protein", carbs: "Carbs", fat: "Fat", vitamins: "Vitamins", toxins: "Toxins",
};

function nutLegendBlock() {
  return `<div class="nut-legend">`
    + NUT_PARTS.map((k) =>
        `<span class="nut-legend-item ${k}">${nutIcon(k)}<span>${NUT_LABELS[k]}</span></span>`
      ).join("")
    + `</div>`;
}

function nutBarBlock(label, n) {
  const vals = NUT_PARTS.map((k) => Math.max(0, n?.[k] ?? 0));
  const total = vals.reduce((s, v) => s + v, 0);
  const segs = NUT_PARTS
    .map((k, i) => ({ k, v: vals[i] }))
    .filter((s) => s.v > 0)
    .map((s) => `<div class="seg ${s.k}" style="width:${(s.v / NUT_MAX) * 100}%" title="${NUT_LABELS[s.k]}: ${s.v.toFixed(2)}">${nutIcon(s.k)}</div>`)
    .join("");
  return `<div class="nut-bar-block">
    <div class="nut-bar-label"><span>${label}</span><span>${total.toFixed(1)} / ${NUT_MAX}</span></div>
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

// Two-mode galaxy: top-level "galaxy" view (one icon per system, with name in
// screen-space text) and "system" view (zoomed into one system, planets and
// moons on orbit rings around the star). Click a system to drill in, ESC or
// back button to return.
//
// SVG strategy: a single <svg> in world-space, but the system name labels and
// the player-ship marker are kept in a second overlay <svg> that uses screen
// pixels — that way labels don't shrink to nothing when zoomed out.

function renderGalaxy() {
  if (state.galaxy.focusSystem) renderSystemView();
  else renderGalaxyMap();
}

// One-shot fetch of the player ship's per-snapshot galaxy positions. Cached
// for the page lifetime and refreshed by the SSE snapshot handler.
async function ensureShipPath() {
  if (state.galaxy.shipPath != null) return state.galaxy.shipPath;
  try {
    const r = await fetch("/history/player-path");
    state.galaxy.shipPath = r.ok ? await r.json() : [];
  } catch {
    state.galaxy.shipPath = [];
  }
  return state.galaxy.shipPath;
}

function renderGalaxyMap() {
  const svg = $("galaxy-svg");
  const overlay = ensureOverlay();
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
  ensureBackBtn(false);
  if (!state.snapshot) return;
  // Kick off the path fetch on first render. Returns immediately if cached.
  if (state.galaxy.shipPath == null) {
    ensureShipPath().then(() => {
      if (!state.galaxy.focusSystem) renderGalaxyMap();
    });
  }
  const bodies = state.snapshot.bodies || [];
  const ships = state.snapshot.ships || [];
  if (bodies.length === 0) return;

  // Aggregate bodies by system_id, then keep systems that are visited OR have
  // at least one scannable body that has been observed (scanned-but-not-
  // visited). Anything else stays in fog of war.
  const allSystems = aggregateSystems(bodies);
  const systems = allSystems.filter((s) => s.visited || s.scanned);
  if (systems.length === 0) return;

  // Player ship trail + current position from the cached path.
  const pathPoints = (state.galaxy.shipPath || []).filter((p) => p.x != null && p.y != null);
  const currentPathIdx = currentPathIndex(pathPoints, state.currentDay);
  const currentPoint = pathPoints[currentPathIdx] || null;
  const currentSystemId = currentPoint?.system_id != null ? String(currentPoint.system_id) : null;

  // World-space bounds: union of visited system centers and the ship trail
  // (so the trail's far extents stay in view at default zoom).
  const xs = systems.map((s) => s.x);
  const ys = systems.map((s) => s.y);
  for (const p of pathPoints) { xs.push(p.x); ys.push(p.y); }
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const padX = Math.max(20000, (maxX - minX) * 0.08);
  const padY = Math.max(20000, (maxY - minY) * 0.08);
  const baseW = Math.max(40000, maxX - minX + padX * 2);
  const baseH = Math.max(40000, maxY - minY + padY * 2);
  const baseX = minX - padX;
  const baseY = minY - padY;

  // Pan + zoom via viewBox.
  const g = state.galaxy;
  const w = baseW / g.scale;
  const h = baseH / g.scale;
  svg.setAttribute("viewBox", `${baseX + g.tx} ${baseY + g.ty} ${w} ${h}`);

  ensureDefs(svg);
  drawGrid(svg, baseX, baseY, baseW, baseH);

  // Star-jump edges (drawn behind systems but in front of grid). Only show
  // edges where at least one endpoint is in a system that's been observed —
  // hides the deep-fog edges entirely.
  const visibleSystemIds = new Set(systems.map((s) => String(s.system_id)));
  const bodyById = new Map(bodies.map((b) => [String(b.body_id), b]));
  drawJumpEdges(svg, state.snapshot.jumpEdges || [], visibleSystemIds, bodyById);

  // Player ship trail (drawn behind systems, in front of grid).
  drawPlayerShipTrail(svg, pathPoints, currentPathIdx);

  // Ship trajectories (galaxy-wide, very faint).
  for (const ship of ships) drawShipPath(svg, ship);

  // System markers — only visited systems are rendered. The system containing
  // the player ship at this slider day is marked with isCurrent.
  for (const sys of systems) {
    const isCurrent = currentSystemId != null && String(sys.system_id) === currentSystemId;
    drawSystemMarker(svg, sys, isCurrent);
  }

  // AI ship markers — always visible, on top.
  for (const ship of ships) {
    const node = drawShipWorld(ship);
    if (node) svg.appendChild(node);
  }

  // Player ship marker at its current-snapshot position (head of trail).
  if (currentPoint) drawPlayerShipMarker(svg, currentPoint);

  // Screen-space label overlay: system names in fixed pixel size.
  renderSystemLabels(overlay, systems, svg);

  // Remember the world-space "viewBox base" so camera animation can convert
  // between absolute world center and tx/ty deltas.
  state.galaxy._base = { baseX, baseY, baseW, baseH };
}

// Index of the last path point whose game_day is ≤ the slider day. Returns
// the final index when the slider is past the last snapshot.
function currentPathIndex(pathPoints, day) {
  if (!pathPoints.length) return -1;
  let idx = -1;
  for (let i = 0; i < pathPoints.length; i++) {
    if (pathPoints[i].game_day <= day) idx = i;
    else break;
  }
  return idx < 0 ? 0 : idx;
}

function drawJumpEdges(svg, edges, visibleSystemIds, bodyById) {
  for (const e of edges) {
    const fromVisible = visibleSystemIds.has(String(e.from_system_id));
    const toVisible = visibleSystemIds.has(String(e.to_system_id));
    if (!fromVisible && !toVisible) continue;
    const from = bodyById.get(String(e.from_body_id));
    const to = bodyById.get(String(e.to_body_id));
    if (!from || !to || from.x == null || to.x == null) continue;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", from.x);
    line.setAttribute("y1", from.y);
    line.setAttribute("x2", to.x);
    line.setAttribute("y2", to.y);
    let cls = "jump-edge";
    if (e.intra) cls += " intra";
    line.setAttribute("class", cls);
    svg.appendChild(line);
  }
}

function drawPlayerShipTrail(svg, pathPoints, currentIdx) {
  if (pathPoints.length < 2) return;
  // Truncate at the current slider day so the line reveals as time advances.
  const upto = pathPoints.slice(0, currentIdx + 1);
  if (upto.length < 2) return;

  // Linear gradient: oldest end transparent, newest end bright cyan.
  // SVG linearGradient uses bounding-box coords by default — switch to user-
  // space so the gradient aligns with the actual point endpoints.
  const defs = svg.querySelector("defs") || (() => {
    const d = document.createElementNS(SVG_NS, "defs");
    svg.appendChild(d);
    return d;
  })();
  // Remove old gradient if present (we redraw every render).
  const oldGrad = defs.querySelector("#ship-trail-grad");
  if (oldGrad) oldGrad.remove();
  const grad = document.createElementNS(SVG_NS, "linearGradient");
  grad.setAttribute("id", "ship-trail-grad");
  grad.setAttribute("gradientUnits", "userSpaceOnUse");
  grad.setAttribute("x1", upto[0].x);
  grad.setAttribute("y1", upto[0].y);
  grad.setAttribute("x2", upto[upto.length - 1].x);
  grad.setAttribute("y2", upto[upto.length - 1].y);
  grad.innerHTML = `
    <stop offset="0%" stop-color="#4cc9ff" stop-opacity="0"/>
    <stop offset="100%" stop-color="#4cc9ff" stop-opacity="0.95"/>
  `;
  defs.appendChild(grad);

  const poly = document.createElementNS(SVG_NS, "polyline");
  poly.setAttribute("class", "ship-trail");
  poly.setAttribute("points", upto.map((p) => `${p.x},${p.y}`).join(" "));
  poly.setAttribute("stroke", "url(#ship-trail-grad)");
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke-width", 400);
  svg.appendChild(poly);
}

function drawPlayerShipMarker(svg, p) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "player-ship");
  const r = 2600;
  // Crosshair-style marker so it reads as "this is me" against the star icons.
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("cx", p.x);
  ring.setAttribute("cy", p.y);
  ring.setAttribute("r", r);
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "#4cc9ff");
  ring.setAttribute("stroke-width", 250);
  g.appendChild(ring);
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", p.x);
  dot.setAttribute("cy", p.y);
  dot.setAttribute("r", r * 0.35);
  dot.setAttribute("fill", "#4cc9ff");
  g.appendChild(dot);
  svg.appendChild(g);
}

// Reduce each system's bodies to a single representative position (the star,
// or fallback to centroid).
function aggregateSystems(bodies) {
  const bySystem = new Map();
  for (const b of bodies) {
    const key = b.system_id || `_${b.body_id}`;
    if (!bySystem.has(key)) {
      bySystem.set(key, {
        system_id: key,
        name: b.system_name || "Unknown",
        bodies: [],
        star: null,
        visited: false,
        scanned: false,
        anyPresent: false,
        lastSeenDay: 0,
      });
    }
    const sys = bySystem.get(key);
    sys.bodies.push(b);
    if (b.type === "Star") sys.star = b;
    if (b.visited) sys.visited = true;
    // "Scanned" = any body in the system is marked scannable in the latest
    // observation (the player has observed it from afar via long-range scan).
    if (b.scannable) sys.scanned = true;
    if (b.present) sys.anyPresent = true;
    if (b.lastSeenDay > sys.lastSeenDay) sys.lastSeenDay = b.lastSeenDay;
  }
  const out = [];
  for (const sys of bySystem.values()) {
    if (sys.star) {
      sys.x = sys.star.x;
      sys.y = sys.star.y;
      sys.star_class = sys.star.star_class;
    } else {
      sys.x = sys.bodies.reduce((s, b) => s + b.x, 0) / sys.bodies.length;
      sys.y = sys.bodies.reduce((s, b) => s + b.y, 0) / sys.bodies.length;
      sys.star_class = null;
    }
    out.push(sys);
  }
  return out;
}

function drawSystemMarker(svg, sys, isCurrent) {
  const g = document.createElementNS(SVG_NS, "g");
  const scannedOnly = !sys.visited && sys.scanned;
  let cls = "system";
  if (sys.visited) cls += " visited";
  if (scannedOnly) cls += " scanned-only";
  if (isCurrent) cls += " current-system";
  g.setAttribute("class", cls);
  g.setAttribute("data-system-id", sys.system_id);

  // Outer glow halo (large faint circle).
  const halo = document.createElementNS(SVG_NS, "circle");
  halo.setAttribute("cx", sys.x);
  halo.setAttribute("cy", sys.y);
  halo.setAttribute("r", isCurrent ? 6000 : 4500);
  halo.setAttribute("fill", starColor(sys.star_class));
  halo.setAttribute("opacity", isCurrent ? 0.28 : (scannedOnly ? 0.08 : 0.15));
  halo.setAttribute("filter", "url(#glow)");
  g.appendChild(halo);

  // Star core. Current system gets a slightly larger radius.
  const star = document.createElementNS(SVG_NS, "circle");
  star.setAttribute("cx", sys.x);
  star.setAttribute("cy", sys.y);
  star.setAttribute("r", isCurrent ? 3000 : 2200);
  star.setAttribute("fill", starColor(sys.star_class));
  star.setAttribute("class", "system-star");
  if (scannedOnly) star.setAttribute("opacity", "0.5");
  g.appendChild(star);

  // Visited ring: thin outline. Brighter + thicker for the current system.
  // Skipped for scanned-only systems — those get an eye glyph instead.
  if (sys.visited) {
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("cx", sys.x);
    ring.setAttribute("cy", sys.y);
    ring.setAttribute("r", isCurrent ? 4200 : 3200);
    ring.setAttribute("class", "visited-ring");
    g.appendChild(ring);
  }

  // Hover + click handlers.
  g.addEventListener("mouseenter", (ev) => showTooltip(ev, systemTooltip(sys)));
  g.addEventListener("mousemove", (ev) => moveTooltip(ev));
  g.addEventListener("mouseleave", hideTooltip);
  g.addEventListener("click", (ev) => {
    ev.stopPropagation();
    state.galaxy.focusSystem = sys.system_id;
    hideTooltip();
    renderGalaxy();
  });
  svg.appendChild(g);
}

function renderSystemView() {
  const svg = $("galaxy-svg");
  const overlay = ensureOverlay();
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
  ensureBackBtn(true);
  if (!state.snapshot) return;
  const bodies = state.snapshot.bodies || [];
  const sysBodies = bodies.filter((b) => b.system_id === state.galaxy.focusSystem);
  if (sysBodies.length === 0) {
    state.galaxy.focusSystem = null;
    renderGalaxyMap();
    return;
  }

  const star = sysBodies.find((b) => b.type === "Star") || sysBodies[0];
  const cx = star.x;
  const cy = star.y;

  // Project relative coordinates from star, find max orbital radius for scaling.
  let maxR = 0;
  for (const b of sysBodies) {
    if (b === star) continue;
    const r = Math.hypot(b.x - cx, b.y - cy);
    if (r > maxR) maxR = r;
  }
  // Synthetic radius for stars with no detected bodies (defensive: shouldn't
  // happen for the player system, but external systems may have only a star).
  if (maxR <= 0) maxR = 5000;

  // ViewBox: a square around the star big enough to fit the outermost body.
  const view = maxR * 2.4;
  svg.setAttribute("viewBox", `${cx - view / 2} ${cy - view / 2} ${view} ${view}`);

  ensureDefs(svg);

  // Orbit rings: one per unique parent (centerId) body that has orbiters.
  const orbitersByParent = new Map();
  for (const b of sysBodies) {
    if (b === star) continue;
    const parentId = b.center_id;
    if (parentId == null) continue;
    if (!orbitersByParent.has(parentId)) orbitersByParent.set(parentId, []);
    orbitersByParent.get(parentId).push(b);
  }
  for (const [parentId, kids] of orbitersByParent) {
    const parent = sysBodies.find((b) => String(b.body_id) === String(parentId)) || star;
    // Group by approximate orbital radius so identical orbits share one ring.
    for (const kid of kids) {
      const r = Math.hypot(kid.x - parent.x, kid.y - parent.y);
      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("cx", parent.x);
      ring.setAttribute("cy", parent.y);
      ring.setAttribute("r", r);
      ring.setAttribute("class", "orbit-ring");
      svg.appendChild(ring);
    }
  }

  // Draw bodies. Star first (so planets render in front of glow).
  drawSystemBody(svg, star, view);
  for (const b of sysBodies) {
    if (b === star) continue;
    drawSystemBody(svg, b, view);
  }

  // Screen-space label: system name top-center.
  const label = document.createElementNS(SVG_NS, "div");
  label.className = "system-overlay-title";
  label.textContent = star.system_name || "Unknown system";
  overlay.appendChild(label);
}

// Map a Station:Flavor tag to a fill color. The flavors come from the save's
// stuff[] strings — Research / Supply / Repair / Trading etc.
const STATION_COLORS = {
  Research: "#4cc9ff",
  Supply: "#f1c40f",
  Repair: "#e67e22",
  Trading: "#27ae60",
  Farming: "#6dd47e",
  Leisure: "#c66bff",
  Prison: "#9b3a3a",
};

// Pick a representative glyph for a body's stuff[]. Returns null if no
// noteworthy tag is present.
function bodyStuffGlyph(b) {
  const stuff = b.stuff || [];
  if (stuff.includes("WarpGate")) return { glyph: "⊕", color: "#4cc9ff", label: "Warp Gate" };
  if (stuff.includes("Derelict")) return { glyph: "⚓", color: "#cfd8dc", label: "Derelict" };
  const station = stuff.find((s) => typeof s === "string" && s.startsWith("Station:"));
  if (station) {
    const flavor = station.slice("Station:".length);
    return { glyph: "⊞", color: STATION_COLORS[flavor] || "#aab0c4", label: `Station: ${flavor}` };
  }
  if (stuff.includes("HiddenShip") && b.visited) return { glyph: "👻", color: "#d6c5ff", label: "Hidden Ship" };
  // ScannableSector is handled as a pulsing cyan outline directly on the body.
  return null;
}

function drawSystemBody(svg, b, view) {
  // Body radius scaled to the system viewBox so things stay visible.
  const r = systemBodyRadius(b, view);
  const g = document.createElementNS(SVG_NS, "g");
  let cls = "body";
  if (b.type === "Star") cls += " star";
  else if (b.type === "Planet") cls += " planet";
  else if (b.type === "Moon") cls += " moon";
  else if (b.type === "AsteroidField") cls += " asteroid-field";
  if (!b.present) cls += " faded";
  if (b.visited) cls += " visited";
  const stuff = b.stuff || [];
  const isScannable = stuff.includes("ScannableSector");
  if (isScannable) cls += " scannable";
  g.setAttribute("class", cls);

  if (b.type === "AsteroidField") {
    for (let i = 0; i < 10; i++) {
      const dx = Math.sin(i * 7 + Number(b.body_id)) * r;
      const dy = Math.cos(i * 11 + Number(b.body_id)) * r;
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", b.x + dx);
      c.setAttribute("cy", b.y + dy);
      c.setAttribute("r", r * 0.18);
      c.setAttribute("fill", "#a89a82");
      g.appendChild(c);
    }
  } else {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", b.x);
    c.setAttribute("cy", b.y);
    c.setAttribute("r", r);
    if (b.type === "Star") {
      c.setAttribute("fill", starColor(b.star_class));
      c.setAttribute("filter", "url(#glow)");
    } else if (b.type === "Planet") {
      c.setAttribute("fill", "#6e8bff");
    } else if (b.type === "Moon") {
      c.setAttribute("fill", "#a8b0c4");
    }
    g.appendChild(c);

    // Visited bodies get a brighter outline. Already styled via CSS class.
    if (b.visited) {
      const outline = document.createElementNS(SVG_NS, "circle");
      outline.setAttribute("cx", b.x);
      outline.setAttribute("cy", b.y);
      outline.setAttribute("r", r * 1.15);
      outline.setAttribute("class", "body-visited-outline");
      g.appendChild(outline);
    }

    // Scannable: pulsing cyan outline ring.
    if (isScannable) {
      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("cx", b.x);
      ring.setAttribute("cy", b.y);
      ring.setAttribute("r", r * 1.35);
      ring.setAttribute("class", "body-scannable-ring");
      g.appendChild(ring);
    }
  }

  // Stuff glyph (Derelict / WarpGate / Station:X / HiddenShip / ...). Drawn in
  // the upper-right corner of the body so it doesn't cover the body itself.
  const glyph = bodyStuffGlyph(b);
  if (glyph) {
    const off = r * 0.8;
    const tx = document.createElementNS(SVG_NS, "text");
    tx.setAttribute("x", b.x + off);
    tx.setAttribute("y", b.y - off);
    tx.setAttribute("class", "body-glyph");
    tx.setAttribute("fill", glyph.color);
    tx.setAttribute("font-size", Math.max(400, r * 1.0));
    tx.setAttribute("text-anchor", "middle");
    tx.setAttribute("dominant-baseline", "middle");
    tx.textContent = glyph.glyph;
    g.appendChild(tx);
  }

  // Body name label below the body.
  if (b.name && b.type !== "Star") {
    const lbl = document.createElementNS(SVG_NS, "text");
    lbl.setAttribute("x", b.x);
    lbl.setAttribute("y", b.y + r * 1.8);
    lbl.setAttribute("class", "body-name-label");
    lbl.setAttribute("text-anchor", "middle");
    lbl.setAttribute("font-size", Math.max(280, r * 0.55));
    lbl.textContent = b.name;
    g.appendChild(lbl);
  }

  g.addEventListener("mouseenter", (ev) => showTooltip(ev, bodyTooltip(b)));
  g.addEventListener("mousemove", (ev) => moveTooltip(ev));
  g.addEventListener("mouseleave", hideTooltip);
  svg.appendChild(g);
}

function systemBodyRadius(b, view) {
  // Sizes proportional to the system viewBox so bodies are visible regardless
  // of how spread out the system is. Asteroid fields use the returned r as
  // the scatter radius, not a draw radius.
  const base = view * 0.025;
  switch (b.type) {
    case "Star": return base * 1.7;
    case "Planet": return base * 0.9;
    case "Moon": return base * 0.45;
    case "AsteroidField": return base * 0.7;
    default: return base * 0.6;
  }
}

// Defs are idempotent — only inserted once.
function ensureDefs(svg) {
  if (svg.querySelector("defs")) return;
  const defs = document.createElementNS(SVG_NS, "defs");
  defs.innerHTML = `
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="800" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  `;
  svg.appendChild(defs);
}

// Subtle grid in galaxy view so the eye gets a sense of scale.
function drawGrid(svg, baseX, baseY, baseW, baseH) {
  const step = 100000;
  const x0 = Math.floor(baseX / step) * step;
  const y0 = Math.floor(baseY / step) * step;
  for (let x = x0; x <= baseX + baseW; x += step) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", x); line.setAttribute("y1", baseY);
    line.setAttribute("x2", x); line.setAttribute("y2", baseY + baseH);
    line.setAttribute("class", "grid-line");
    svg.appendChild(line);
  }
  for (let y = y0; y <= baseY + baseH; y += step) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", baseX); line.setAttribute("y1", y);
    line.setAttribute("x2", baseX + baseW); line.setAttribute("y2", y);
    line.setAttribute("class", "grid-line");
    svg.appendChild(line);
  }
}

function drawShipPath(svg, ship) {
  if (!ship.path || ship.path.length < 2) return;
  const d = ship.path
    .filter((p) => p.x != null && p.y != null)
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");
  if (!d) return;
  const pathEl = document.createElementNS(SVG_NS, "path");
  pathEl.setAttribute("d", d);
  pathEl.setAttribute("class", "ship-path");
  svg.appendChild(pathEl);
}

function drawShipWorld(ship) {
  const last = ship.path?.[ship.path.length - 1];
  if (!last || last.x == null || last.y == null) return null;
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "ship" + (ship.present ? "" : " faded"));
  const tri = document.createElementNS(SVG_NS, "polygon");
  const r = 2400;
  tri.setAttribute("points", `${last.x},${last.y - r} ${last.x - r * 0.85},${last.y + r * 0.7} ${last.x + r * 0.85},${last.y + r * 0.7}`);
  tri.setAttribute("fill", factionColor(ship.faction_id));
  tri.setAttribute("stroke", "#fff");
  tri.setAttribute("stroke-width", 180);
  g.appendChild(tri);
  g.addEventListener("mouseenter", (ev) => showTooltip(ev, shipTooltip(ship)));
  g.addEventListener("mousemove", (ev) => moveTooltip(ev));
  g.addEventListener("mouseleave", hideTooltip);
  return g;
}

// Screen-space label overlay. Reads the SVG viewBox + bounding rect so labels
// land directly under each system marker in pixel space.
function renderSystemLabels(overlay, systems, svg) {
  const vb = svg.viewBox.baseVal;
  const rect = svg.getBoundingClientRect();
  const wrapRect = $("galaxy-canvas-wrap").getBoundingClientRect();
  if (!vb.width || !vb.height || !rect.width) return;
  // Same fit math as preserveAspectRatio="xMidYMid meet": find the scale that
  // makes the viewBox fit inside the SVG client rect, then center it.
  const scale = Math.min(rect.width / vb.width, rect.height / vb.height);
  const drawnW = vb.width * scale;
  const drawnH = vb.height * scale;
  const offX = rect.left - wrapRect.left + (rect.width - drawnW) / 2;
  const offY = rect.top - wrapRect.top + (rect.height - drawnH) / 2;
  for (const sys of systems) {
    const sx = offX + (sys.x - vb.x) * scale;
    const sy = offY + (sys.y - vb.y) * scale;
    const scannedOnly = !sys.visited && sys.scanned;
    const label = document.createElement("div");
    let cls = "system-label-overlay";
    if (!sys.anyPresent) cls += " faded";
    if (scannedOnly) cls += " scanned-only";
    label.className = cls;
    label.style.left = sx + "px";
    label.style.top = (sy + 18) + "px";
    // Scanned-but-not-visited: prepend the "observed-from-afar" eye glyph.
    label.textContent = (scannedOnly ? "👁 " : "") + sys.name;
    overlay.appendChild(label);
  }
}

function ensureOverlay() {
  let overlay = document.getElementById("galaxy-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "galaxy-overlay";
    $("galaxy-canvas-wrap").appendChild(overlay);
  }
  return overlay;
}

function ensureBackBtn(visible) {
  let btn = document.getElementById("galaxy-back");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "galaxy-back";
    btn.textContent = "← Galaxy";
    btn.addEventListener("click", () => {
      state.galaxy.focusSystem = null;
      renderGalaxy();
    });
    $("galaxy-canvas-wrap").appendChild(btn);
  }
  btn.style.display = visible ? "" : "none";
}

function systemTooltip(sys) {
  const visibleBodies = sys.bodies.filter((b) => b.present);
  const lines = [
    `<strong>${esc(sys.name)}</strong>`,
    sys.star_class ? `star class: ${esc(sys.star_class)}` : null,
    `bodies: ${visibleBodies.length}/${sys.bodies.length} visible`,
    sys.visited ? "<em>visited</em>" : null,
    sys.anyPresent ? null : `<em>last seen day ${sys.lastSeenDay}</em>`,
    `<span class="hint">click to enter system</span>`,
  ].filter(Boolean);
  return lines.join("<br>");
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
  const stuff = b.stuff || [];
  const lines = [
    `<strong>${esc(b.name || b.type)}</strong>`,
    `type: ${esc(b.type)}${b.star_class ? ` (${esc(b.star_class)})` : ""}`,
    b.system_name ? `system: ${esc(b.system_name)}` : null,
  ].filter(Boolean);
  if (stuff.length) lines.push(`stuff: ${stuff.map(esc).join(", ")}`);
  if (b.scannable) lines.push("<em>scannable</em>");
  if (b.visited) lines.push("<em>visited</em>");
  if (b.saved) lines.push("<em>saved</em>");
  if (!b.present) lines.push(`<em>last seen day ${b.lastSeenDay}</em>`);
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
// Wheel zoom is centered on the cursor (not on 0,0): convert mouse to current
// world-space, scale, then shift translation so that world point still lives
// under the cursor after the zoom.
const svg = $("galaxy-svg");
svg.addEventListener("wheel", (ev) => {
  if (state.galaxy.focusSystem) return; // system view is auto-fit, no zoom
  ev.preventDefault();
  const vb = svg.viewBox.baseVal;
  const rect = svg.getBoundingClientRect();
  if (!vb.width || !rect.width) return;
  const cursorX = vb.x + (ev.clientX - rect.left) * (vb.width / rect.width);
  const cursorY = vb.y + (ev.clientY - rect.top) * (vb.height / rect.height);
  const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2;
  const prev = state.galaxy.scale;
  state.galaxy.scale = Math.max(0.5, Math.min(60, state.galaxy.scale * factor));
  const realFactor = state.galaxy.scale / prev;
  // The new viewBox width = vb.width / realFactor. Adjust tx, ty so cursor
  // world position stays put.
  const newW = vb.width / realFactor;
  const newH = vb.height / realFactor;
  const newX = cursorX - (ev.clientX - rect.left) * (newW / rect.width);
  const newY = cursorY - (ev.clientY - rect.top) * (newH / rect.height);
  // tx/ty are offsets from baseX/baseY; recompute by deriving baseX/baseY.
  // We know vb.x = baseX + tx (old). Easier: store tx as absolute delta from
  // baseX. We didn't track baseX globally, so recompute by re-running render
  // with adjusted scale + a translation correction relative to old viewBox.
  state.galaxy.tx += newX - vb.x;
  state.galaxy.ty += newY - vb.y;
  renderGalaxy();
}, { passive: false });

svg.addEventListener("mousedown", (ev) => {
  if (ev.button !== 0) return;
  if (state.galaxy.focusSystem) return; // no drag in system view
  state.galaxy.drag = { x: ev.clientX, y: ev.clientY, tx0: state.galaxy.tx, ty0: state.galaxy.ty, moved: false };
  svg.classList.add("dragging");
});
window.addEventListener("mousemove", (ev) => {
  if (!state.galaxy.drag) return;
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  if (!vb.width) return;
  const dx = (ev.clientX - state.galaxy.drag.x) * (vb.width / rect.width);
  const dy = (ev.clientY - state.galaxy.drag.y) * (vb.height / rect.height);
  if (Math.abs(ev.clientX - state.galaxy.drag.x) + Math.abs(ev.clientY - state.galaxy.drag.y) > 3) {
    state.galaxy.drag.moved = true;
  }
  state.galaxy.tx = state.galaxy.drag.tx0 - dx;
  state.galaxy.ty = state.galaxy.drag.ty0 - dy;
  renderGalaxy();
});
window.addEventListener("mouseup", () => {
  // Swallow a click that came after a drag so we don't accidentally enter a
  // system on pan-release.
  if (state.galaxy.drag?.moved) {
    setTimeout(() => { state.galaxy.drag = null; }, 0);
  } else {
    state.galaxy.drag = null;
  }
  svg.classList.remove("dragging");
});
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && state.galaxy.focusSystem) {
    state.galaxy.focusSystem = null;
    renderGalaxy();
  }
});

// ===========================================================================
//  Slider / playback
// ===========================================================================

$("day-slider").addEventListener("input", () => {
  state.currentDay = Number($("day-slider").value);
  // If the user starts scrubbing while we're zoomed into a system, pop back
  // to the galaxy map first so the camera follow + system highlight read.
  if (state.galaxy.focusSystem) {
    state.galaxy.focusSystem = null;
  }
  loadSnapshot(state.currentDay);
  scheduleCameraFollow();
  scheduleAutoZoom();
});

// ----- Camera follow + auto-zoom (galaxy view) -----

// Smooth-pan the SVG viewBox so the player ship at the slider's day is
// centered. Cancels any in-flight animation when called.
function scheduleCameraFollow() {
  const path = state.galaxy.shipPath || [];
  if (!path.length) return;
  const idx = currentPathIndex(path, state.currentDay);
  const target = path[idx];
  if (!target || target.x == null || target.y == null) return;
  animateCameraTo(target.x, target.y);
}

function animateCameraTo(worldX, worldY) {
  const base = state.galaxy._base;
  if (!base) return; // not yet rendered
  const g = state.galaxy;
  const vw = base.baseW / g.scale;
  const vh = base.baseH / g.scale;
  const startTx = g.tx;
  const startTy = g.ty;
  const endTx = worldX - vw / 2 - base.baseX;
  const endTy = worldY - vh / 2 - base.baseY;
  if (Math.hypot(endTx - startTx, endTy - startTy) < 1) return;
  const dur = 400;
  const t0 = performance.now();
  if (g.cameraAnim) cancelAnimationFrame(g.cameraAnim);
  function step(now) {
    const u = Math.min(1, (now - t0) / dur);
    // ease-out cubic
    const e = 1 - Math.pow(1 - u, 3);
    g.tx = startTx + (endTx - startTx) * e;
    g.ty = startTy + (endTy - startTy) * e;
    if (!state.galaxy.focusSystem) renderGalaxyMap();
    if (u < 1) g.cameraAnim = requestAnimationFrame(step);
    else g.cameraAnim = null;
  }
  g.cameraAnim = requestAnimationFrame(step);
}

// After ~700ms of no slider activity, auto-trigger the existing system-click
// behavior on the current system so the user lands on the orbital ring view.
function scheduleAutoZoom() {
  const g = state.galaxy;
  if (g.autoZoomTimer) clearTimeout(g.autoZoomTimer);
  g.autoZoomTimer = setTimeout(() => {
    g.autoZoomTimer = null;
    const path = g.shipPath || [];
    if (!path.length) return;
    const idx = currentPathIndex(path, state.currentDay);
    const sysId = path[idx]?.system_id;
    if (sysId == null) return;
    if (g.focusSystem) return; // user already drilled in manually
    g.focusSystem = String(sysId);
    renderGalaxy();
  }, 700);
}

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
    state.galaxy.shipPath = null; // invalidate cache; refetch on next render
    state.recipes = null;         // library may have been re-imported
    await loadDays();
    await ensureShipPath();
    await ensureRecipes();
    await renderTickMarks();
  });

  // Stub: incremental RFC-6902 patches from the streaming agent.
  // Wire is in place so the agent can start sending immediately; no UI work
  // is needed once the wire format matches what SH.applyOps expects.
  es.addEventListener("patch", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data && Array.isArray(data.ops)) SH.applyOps(data.ops);
    } catch (e) {
      console.error("patch event parse failed", e);
    }
  });

  // Java agent liveness: any heartbeat frame within the last 10s = green.
  // We don't trust the server-side `agent-status` event alone — if it's
  // missed (refresh, etc.) we'd be stuck on "offline" forever. Frames
  // self-heal that.
  let agentTimer = null;
  function markAgentOnline(label) {
    const el = $("agent");
    el.classList.remove("off");
    $("agent-label").textContent = label;
    if (agentTimer) clearTimeout(agentTimer);
    agentTimer = setTimeout(() => {
      el.classList.add("off");
      $("agent-label").textContent = "Agent: offline";
    }, 10_000);
  }
  es.addEventListener("agent-status", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data && data.connected) markAgentOnline("Agent: connected");
    } catch {}
  });
  es.addEventListener("agent-heartbeat", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const tick = data && Number.isFinite(data.tick) ? data.tick : null;
      markAgentOnline(tick != null ? `Agent: tick ${tick}` : "Agent: connected");
    } catch {}
  });

  es.onerror = () => $("live").classList.add("off");
}

// Renderer mode badge: snapshot (default) vs live patches. Switches when
// SH.applyOps is first called (i.e. an incremental patch arrives).
SH.onRendererModeChange = (mode) => {
  const el = $("renderer");
  const label = $("renderer-label");
  if (!el || !label) return;
  if (mode === "live") {
    el.classList.remove("off");
    label.textContent = "Renderer: live patches";
  } else {
    el.classList.add("off");
    label.textContent = "Renderer: snapshot mode";
  }
};

fetch("/version")
  .then((r) => r.json())
  .then((j) => { $("app-version").textContent = "v" + j.version; })
  .catch(() => { $("app-version").textContent = ""; });

loadDays()
  .then(ensureShipPath)
  .then(ensureRecipes)
  .then(ensureIconIndex)
  .then(startSSE)
  .then(bootDockingWhenReady);

// dockview-core arrives via an ESM module tag in index.html — that resolves
// after the rest of our plain scripts have already executed. We poll briefly
// then call bootDocking, also wiring the explicit dockview-ready event in case
// the module is still in-flight.
function bootDockingWhenReady() {
  if (typeof SH.bootDocking !== "function") return;
  if (window.Dockview && window.Dockview.createDockview) {
    SH.bootDocking();
    return;
  }
  let tries = 0;
  const tick = () => {
    if (window.Dockview && window.Dockview.createDockview) {
      SH.bootDocking();
      return;
    }
    if (++tries > 200) {
      console.error("dockview never loaded — workspace will not render");
      return;
    }
    setTimeout(tick, 25);
  };
  window.addEventListener("dockview-ready", () => SH.bootDocking(), { once: true });
  tick();
}
