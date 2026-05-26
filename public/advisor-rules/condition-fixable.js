"use strict";

// Rule: condition-fixable
//
// Crew has a deficiency/condition with an obvious in-storage remedy.
// Drafting them to eat the matching food clears it faster than waiting
// for the normal schedule.

SH.advisor.registerRule({
  id: "condition-fixable",
  name: "Crew condition has a remedy",
  category: "Crew",
  description: "Vitamin/protein deficiencies when matching food is in storage",
  watch: ["/crew", "/storage"],
  evaluate(state) {
    const crew = Array.isArray(state.crew) ? state.crew : Object.values(state.crew || {});
    const storage = Array.isArray(state.storage) ? state.storage : Object.values(state.storage || {});
    const out = [];
    // Maps condition name fragment → food name fragments that help.
    const remedies = [
      { condition: "Vitamin",      foods: ["Fruits", "Vegetables", "Root vegetables"] },
      { condition: "Protein",      foods: ["Artificial meat", "Nuts and seeds", "Bio Matter"] },
      { condition: "Fatty acid",   foods: ["Nuts and seeds", "Artificial meat"] },
      { condition: "Carbohydrate", foods: ["Root vegetables", "Fruits", "Grains"] },
      { condition: "starv",        foods: ["Processed Food", "Algae", "Root vegetables", "Fruits"] },
    ];
    for (const c of crew) {
      if (!c || !c.conditions) continue;
      for (const cond of c.conditions) {
        const condName = cond.name || "";
        const remedy = remedies.find(r => condName.toLowerCase().includes(r.condition.toLowerCase()));
        if (!remedy) continue;
        const stocked = storage.find(s =>
          (s.count || 0) > 0 &&
          remedy.foods.some(f => (s.name || "").toLowerCase().includes(f.toLowerCase()))
        );
        if (!stocked) continue;
        out.push({
          id: `condition-fixable-${c.cid}-${cond.id}`,
          severity: cond.level >= 2 ? "warning" : "info",
          icon: "*",
          title: `${c.name}: ${condName}`,
          body: `You have ${stocked.count} × ${stocked.name} in storage. Drafting ${c.name} to eat would clear it faster.`,
          data: { cid: c.cid, conditionId: cond.id, elementId: stocked.elementary_id },
        });
      }
    }
    return out;
  },
});
