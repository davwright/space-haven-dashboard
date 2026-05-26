"use strict";

// =============================================================================
//  map-galaxy widget — sixth migration target.
//
//  STATUS: placeholder fallback.
//
//  The legacy renderGalaxy in app.js is ~500 LOC of SVG + pan/zoom/camera-
//  follow logic that's tightly coupled to fixed DOM ids (#galaxy-svg,
//  #galaxy-canvas-wrap, #galaxy-overlay, #galaxy-back) and binds wheel/drag
//  listeners at module init. A safe refactor to make those parameterised is
//  larger than the rest of this migration combined and risks breaking the
//  shipping Map tab.
//
//  TODO: refactor renderGalaxy to accept a host element so the widget can
//  render its own independent SVG instance. Until then, this widget shows a
//  placeholder + a button that jumps to the legacy Map tab — preserving the
//  workspace slot in the Navigation default layout without doubling up the
//  pan/zoom logic.
// =============================================================================

(function () {
  function render(container /*, ctx */) {
    container.classList.add("widget-map-galaxy");
    container.innerHTML = `
      <div class="mg-placeholder">
        <div class="mg-icon">🌌</div>
        <div class="mg-title">Galaxy Map</div>
        <p class="mg-msg">
          The full galaxy/system view lives on the legacy Map tab for now —
          its pan/zoom and camera-follow logic isn't yet parameterised for the
          docking host. (See TODO in widget-map-galaxy.js.)
        </p>
        <button class="mg-open" type="button">Open Map tab</button>
      </div>
    `;
    const btn = container.querySelector(".mg-open");
    if (btn) {
      btn.addEventListener("click", () => {
        // Trigger the same view-switch handler the header nav uses.
        const navBtn = document.querySelector('header nav button[data-view="galaxy"]');
        if (navBtn) navBtn.click();
      });
    }
  }

  function update(/*container, ctx*/) {
    // Placeholder is static — no repaint needed on snapshot updates.
  }

  function dispose(/*container*/) {
    // No listeners to tear down beyond the button, which goes with innerHTML.
  }

  SH.registerWidget({
    id: "map-galaxy",
    name: "Galaxy Map",
    category: "Navigation",
    description: "Galaxy and system view with travel history and fog of war",
    icon: "🌌",
    render,
    update,
    dispose,
  });
})();
