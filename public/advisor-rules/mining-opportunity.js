"use strict";

// Rule: mining-opportunity
//
// Fires when there are minable asteroids/bodies (bodies with "Resource" in
// their `stuff` list) in the player's current system.
//
// TODO: detect starfighter launch policy. The motivating example is "you
// have asteroids AND your starfighter is set to StayDocked." We don't have
// launch-policy data in the state tree yet (state.ships entries don't carry
// a launch_policy field today). Once the backend exposes it, gate the
// insight on `starfighter.launch_policy === "StayDocked"` and bump severity
// to "warning". For now the rule just notes the opportunity when minable
// bodies are present, which is still useful.

SH.advisor.registerRule({
  id: "mining-opportunity",
  name: "Mining opportunity",
  category: "Resources",
  description: "Minable resources in current system",
  watch: ["/bodies", "/playerSystemId", "/ships"],
  evaluate(state) {
    const sys = state.playerSystemId;
    if (sys == null) return [];
    const bodies = state.bodies || {};
    const list = Array.isArray(bodies) ? bodies : Object.values(bodies);
    const minable = list.filter(b =>
      String(b.system_id) === String(sys) &&
      Array.isArray(b.stuff) && b.stuff.includes("Resource")
    );
    if (minable.length === 0) return [];
    return [{
      id: `mining-opportunity-${sys}`,
      severity: "info",
      icon: "*",
      title: `${minable.length} minable site${minable.length > 1 ? "s" : ""} in current system`,
      body: `Resources are available nearby. Consider sending a mining detail.`,
      data: { systemId: sys, bodyIds: minable.map(b => b.body_id) },
    }];
  },
});
