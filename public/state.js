"use strict";

// =============================================================================
//  Space Haven Dashboard — browser-side state framework.
//
//  Phase-0 primitives for the "stream from running game" architecture
//  (see docs/live-streaming-design.md). The Status tab uses them today;
//  other tabs migrate incrementally.
//
//  Public surface (everything hangs off window.SH):
//    SH.tree            canonical client state (entity collections keyed by id)
//    SH.bindings        Map<path, Set<{node, renderFn}>>
//    SH.applyOp(op)     RFC 6902 op, applied synchronously
//    SH.applyOps(ops)   batch entry — buffers into rAF
//    SH.bindCell(path, node, renderFn)
//    SH.unbindCell(node)
//    SH.replaceTree(newTree)
//    SH.normalizeSnapshot(rawSnapshot)
//
//  renderFn signature: renderFn(node, newValue, oldValue, fullPath)
//  renderFn MUST do surgical updates only (textContent, classList, style…).
//  Never set innerHTML inside renderFn — that orphans descendant bindings.
// =============================================================================

(function () {
  const SH = {};

  // ---- Canonical state ----
  SH.tree = {};

  // path (string) -> Set<{ node, renderFn }>
  SH.bindings = new Map();
  // node -> Set<path>  (reverse index, for SH.unbindCell)
  const nodeIndex = new WeakMap();

  // ---- rAF batch buffer ----
  let pendingOps = [];
  let rafScheduled = false;

  // Renderer mode tracking for the UI badge.
  // 'snapshot' = only replaceTree calls have happened. 'live' = an applyOps
  // (incremental patch) has been applied at least once.
  SH.rendererMode = "snapshot";
  SH.onRendererModeChange = null; // optional callback(mode)

  // Subscribers fired after every replaceTree and after each applyOps flush.
  // Widgets register here so they can refresh themselves on snapshot/patch.
  const treeReplacedSubs = new Set();
  SH.onTreeReplaced = function onTreeReplaced(fn) {
    if (typeof fn !== "function") return () => {};
    treeReplacedSubs.add(fn);
    return () => treeReplacedSubs.delete(fn);
  };
  function fireTreeReplaced() {
    for (const fn of treeReplacedSubs) {
      try { fn(); } catch (e) { console.error("onTreeReplaced subscriber failed", e); }
    }
  }

  // -------------------------------------------------------------------------
  //  Path parsing
  // -------------------------------------------------------------------------

  // RFC 6901 token decode: '~1' -> '/', '~0' -> '~'.
  function decodeToken(t) {
    return t.replace(/~1/g, "/").replace(/~0/g, "~");
  }
  function splitPath(path) {
    if (path === "" || path === "/") return [];
    if (path[0] !== "/") throw new Error(`bad path: ${path}`);
    return path.slice(1).split("/").map(decodeToken);
  }

  // Walk the tree by path tokens, returning { parent, key } so the caller
  // can mutate. For a root path, parent is null.
  function resolveParent(tokens) {
    if (tokens.length === 0) return { parent: null, key: null };
    let cur = SH.tree;
    for (let i = 0; i < tokens.length - 1; i++) {
      const k = tokens[i];
      if (cur == null || typeof cur !== "object") {
        throw new Error(`path traverses non-object at /${tokens.slice(0, i + 1).join("/")}`);
      }
      cur = cur[k];
    }
    return { parent: cur, key: tokens[tokens.length - 1] };
  }

  function getByPath(path) {
    const tokens = splitPath(path);
    if (tokens.length === 0) return SH.tree;
    let cur = SH.tree;
    for (const k of tokens) {
      if (cur == null) return undefined;
      cur = cur[k];
    }
    return cur;
  }

  // -------------------------------------------------------------------------
  //  Bindings
  // -------------------------------------------------------------------------

  SH.bindCell = function bindCell(path, node, renderFn) {
    if (!SH.bindings.has(path)) SH.bindings.set(path, new Set());
    const entry = { node, renderFn };
    SH.bindings.get(path).add(entry);
    let paths = nodeIndex.get(node);
    if (!paths) {
      paths = new Set();
      nodeIndex.set(node, paths);
    }
    paths.add(path);
    // Fire once with the current value so the binding renders immediately.
    const val = getByPath(path);
    try {
      renderFn(node, val, undefined, path);
    } catch (e) {
      console.error("bindCell initial render failed for", path, e);
    }
  };

  SH.unbindCell = function unbindCell(node) {
    const paths = nodeIndex.get(node);
    if (!paths) return;
    for (const path of paths) {
      const set = SH.bindings.get(path);
      if (!set) continue;
      for (const entry of set) {
        if (entry.node === node) set.delete(entry);
      }
      if (set.size === 0) SH.bindings.delete(path);
    }
    nodeIndex.delete(node);
  };

  // Collect bindings whose path is either (a) the changed path, (b) a prefix
  // of it (ancestor binding wants to see subtree change), or (c) a descendant
  // of it (the whole subtree just changed under them).
  function collectAffectedBindings(changedPath) {
    const affected = [];
    const prefix = changedPath === "/" ? "/" : changedPath + "/";
    for (const [path, entries] of SH.bindings) {
      if (
        path === changedPath ||
        changedPath.startsWith(path + "/") ||  // ancestor
        path.startsWith(prefix)                // descendant
      ) {
        for (const entry of entries) affected.push({ path, entry });
      }
    }
    return affected;
  }

  // -------------------------------------------------------------------------
  //  applyOp (RFC 6902: add, replace, remove)
  // -------------------------------------------------------------------------

  function mutate(op) {
    const tokens = splitPath(op.path);
    if (tokens.length === 0) {
      // Root replace; we don't expect this in the flow but support it.
      if (op.op === "add" || op.op === "replace") SH.tree = op.value;
      return;
    }
    const { parent, key } = resolveParent(tokens);
    if (parent == null || typeof parent !== "object") {
      throw new Error(`applyOp: parent missing for ${op.path}`);
    }
    if (op.op === "remove") {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
      return;
    }
    if (op.op === "add" || op.op === "replace") {
      if (Array.isArray(parent) && key === "-") parent.push(op.value);
      else if (Array.isArray(parent)) parent.splice(Number(key), 0, op.value);
      else parent[key] = op.value;
      return;
    }
    // 'move' / 'copy' / 'test' are intentionally unimplemented.
    throw new Error(`applyOp: unsupported op '${op.op}'`);
  }

  // Apply a single op synchronously and fire all affected bindings immediately.
  SH.applyOp = function applyOp(op) {
    const affected = collectAffectedBindings(op.path);
    // Capture old values BEFORE mutation, indexed by the bound path.
    const oldByPath = new Map();
    for (const { path } of affected) {
      if (!oldByPath.has(path)) oldByPath.set(path, getByPath(path));
    }
    mutate(op);
    fireBindings(affected, oldByPath);
  };

  function fireBindings(affected, oldByPath) {
    // Dedupe by node so multiple writes to the same node touch the DOM once.
    const seenNodes = new WeakSet();
    for (const { path, entry } of affected) {
      if (seenNodes.has(entry.node)) continue;
      seenNodes.add(entry.node);
      const newVal = getByPath(path);
      try {
        entry.renderFn(entry.node, newVal, oldByPath.get(path), path);
      } catch (e) {
        console.error("renderFn failed for", path, e);
      }
    }
  }

  // -------------------------------------------------------------------------
  //  applyOps — batched, rAF-flushed
  // -------------------------------------------------------------------------

  SH.applyOps = function applyOps(ops) {
    if (!Array.isArray(ops) || ops.length === 0) return;
    pendingOps.push(...ops);
    // First incremental op switches the UI badge to "live patches" mode.
    if (SH.rendererMode !== "live") {
      SH.rendererMode = "live";
      if (typeof SH.onRendererModeChange === "function") {
        try { SH.onRendererModeChange(SH.rendererMode); } catch {}
      }
    }
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(flush);
    }
  };

  function flush() {
    rafScheduled = false;
    const ops = pendingOps;
    pendingOps = [];
    // Pass 1: gather affected bindings + old values across all ops, then
    // mutate the tree.
    const affectedByPath = new Map(); // path -> Set<entry>
    const oldByPath = new Map();
    for (const op of ops) {
      const aff = collectAffectedBindings(op.path);
      for (const { path, entry } of aff) {
        if (!affectedByPath.has(path)) affectedByPath.set(path, new Set());
        affectedByPath.get(path).add(entry);
        if (!oldByPath.has(path)) oldByPath.set(path, getByPath(path));
      }
      try {
        mutate(op);
      } catch (e) {
        console.error("applyOps: mutate failed", op, e);
      }
    }
    // Pass 2: fire renderFns, deduped by node.
    const list = [];
    for (const [path, entries] of affectedByPath) {
      for (const entry of entries) list.push({ path, entry });
    }
    fireBindings(list, oldByPath);
    fireTreeReplaced();
  }

  // -------------------------------------------------------------------------
  //  replaceTree — cold-start path
  // -------------------------------------------------------------------------

  SH.replaceTree = function replaceTree(newTree) {
    SH.tree = newTree || {};
    // Clear bindings; callers re-register during their next structural render.
    SH.bindings.clear();
    // Reset renderer mode — a fresh tree means we're back to "snapshot" until
    // the next incremental patch arrives.
    if (SH.rendererMode !== "snapshot") {
      SH.rendererMode = "snapshot";
      if (typeof SH.onRendererModeChange === "function") {
        try { SH.onRendererModeChange(SH.rendererMode); } catch {}
      }
    }
    fireTreeReplaced();
  };

  // -------------------------------------------------------------------------
  //  normalizeSnapshot
  //
  //  Backend currently returns entity collections as arrays. The streaming
  //  protocol requires objects keyed by stable id. We transform at the
  //  browser boundary so the rest of the code is forward-compatible.
  //
  //  crew    -> keyed by c.cid (== entId from the save)
  //  storage -> keyed by s.elementary_id
  //  bodies  -> keyed by b.body_id
  //  ships   -> keyed by s.ship_id
  // -------------------------------------------------------------------------

  function indexBy(arr, key) {
    const out = {};
    if (!Array.isArray(arr)) return out;
    for (const item of arr) {
      const k = item == null ? null : item[key];
      if (k == null) continue;
      out[String(k)] = item;
    }
    return out;
  }

  SH.normalizeSnapshot = function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== "object") return raw;
    // Shallow copy so we don't clobber state.snapshot consumers that still
    // expect arrays. Those consumers will be migrated in later phases.
    const out = { ...raw };
    if (Array.isArray(raw.crew))    out.crew    = indexBy(raw.crew,    "cid");
    if (Array.isArray(raw.storage)) out.storage = indexBy(raw.storage, "elementary_id");
    if (Array.isArray(raw.bodies))  out.bodies  = indexBy(raw.bodies,  "body_id");
    if (Array.isArray(raw.ships))   out.ships   = indexBy(raw.ships,   "ship_id");
    return out;
  };

  window.SH = SH;
})();
