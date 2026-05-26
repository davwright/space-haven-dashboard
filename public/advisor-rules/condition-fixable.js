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

  // Medical knowledge required: the ship's computer can only give
  // nutritional advice when someone on board has Medical >= 3.
  // capability-gating-design.md → "Example: nutritional advice gated
  // by Medical skill" — at level 3+ we fire generic advice; at level 5+
  // we add the specific food name. Lower Medical = no insight at all.
  requires: [
    { type: "skill", skill: "Medical", level: 3 },
  ],
  featureRequires: {
    "specific-remedy": [
      { type: "skill", skill: "Medical", level: 5 },
    ],
  },

  evaluate(state, ctx) {
    const specific = ctx ? ctx.featureMet("specific-remedy") : true;
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
        // With Medical >= 5 we name the food + recommend drafting. Below
        // that (Medical 3-4), we keep the advice generic: "this condition
        // has a fixable cause; consult a medic." The remedy DATA is the
        // same — only the body text changes.
        const body = specific
          ? `You have ${stocked.count} × ${stocked.name} in storage. Drafting ${c.name} to eat would clear it faster.`
          : `${c.name}'s condition has a nutritional cause. A medic with deeper training (Medical ≥ 5) could recommend a specific food from current stocks.`;
        out.push({
          id: `condition-fixable-${c.cid}-${cond.id}`,
          severity: cond.level >= 2 ? "warning" : "info",
          icon: "*",
          title: `${c.name}: ${condName}`,
          body,
          data: { cid: c.cid, conditionId: cond.id, elementId: stocked.elementary_id },
        });
      }
    }
    return out;
  },
});
