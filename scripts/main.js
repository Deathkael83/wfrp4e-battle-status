// scripts/main.js
import { MODULE_ID, registerSettings } from "./settings.js";

/**
 * WFRP4e Combat State
 * - Tracks melee engagements via wfrp4e:opposedTestResult
 * - Applies/removes the "engaged" condition based on round activity
 * - Cleans up on unconscious targets and combat end
 */

// ---------------------------------------------------------------------------
// i18n helpers
// ---------------------------------------------------------------------------
function t(key) {
  try {
    return game.i18n.localize(key);
  } catch {
    return key;
  }
}

function tf(key, data = {}) {
  try {
    return game.i18n.format(key, data);
  } catch {
    return key;
  }
}

function systemAlias() {
  const key = "wfrp4e_battle_status.UI.SystemAlias";
  const val = t(key);
  return val && val !== key ? val : "System";
}

// ---------------------------------------------------------------------------
// Debug (controlled by settings)
// ---------------------------------------------------------------------------
function debugLog(...args) {
  try {
    if (!game.settings.get(MODULE_ID, "enableDebugLog")) return;
  } catch {
    return;
  }
  console.debug(`[${MODULE_ID}]`, ...args);
}

// ---------------------------------------------------------------------------
// GM/Assistant GM chat helper (controlled by settings)
// ---------------------------------------------------------------------------
function gmChat(htmlMsg) {
  let enabled = true;
  try {
    enabled = game.settings.get(MODULE_ID, "enableChatMessages");
  } catch {
    enabled = true;
  }
  if (!enabled) return;

  const recipients = game.users
    .filter((u) => [3, 4].includes(u.role)) // Assistant GM (3) + GM (4)
    .map((u) => u.id);

  if (!recipients.length) return;

  ChatMessage.create({
    user: game.user.id,
    speaker: { alias: systemAlias() },
    content: `<span style="color:#052e9c">${htmlMsg}</span>`,
    whisper: recipients
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getCurrentCombat() {
  return game.combat ?? null;
}

function getCurrentRound() {
  const combat = getCurrentCombat();
  return combat ? combat.round || 0 : 0;
}

function makePairKey(aId, bId) {
  const ids = [aId, bId].sort();
  return `${ids[0]}-${ids[1]}`;
}

function isActorValidForEngaged(actor) {
  return actor && actor.system && actor.type !== "vehicle";
}

function passesCombatantRequirement(attacker, defender, combat) {
  const requirement = game.settings.get(MODULE_ID, "combatantRequirement");

  if (requirement === "none") return true;
  if (!combat) return false;

  const combatantIds = new Set(
    combat.combatants
      .filter(c => c.actor)
      .map(c => c.actor.id)
  );

  const attackerIsCombatant = combatantIds.has(attacker.id);
  const defenderIsCombatant = combatantIds.has(defender.id);

  if (requirement === "both") return attackerIsCombatant && defenderIsCombatant;
  if (requirement === "either") return attackerIsCombatant || defenderIsCombatant;

  return false;
}

// ---------------------------------------------------------------------------
// Detect melee opposed tests
// ---------------------------------------------------------------------------
function isMeleeOpposed(opposedTest) {
  if (!opposedTest) return false;

  const attackerTest = opposedTest.attackerTest;
  if (!attackerTest) return false;

  const weapon = attackerTest.weapon || attackerTest.item;
  const attackType =
    attackerTest.preData?.attackType ||
    weapon?.system?.attackType ||
    attackerTest.context?.attackType;

  return attackType === "melee" || attackType === "meleeweapon";
}

// ---------------------------------------------------------------------------
// Token/name extraction (best-effort)
// ---------------------------------------------------------------------------
function getTokenNameFromTest(test, actor, combat) {
  if (!actor) return t("wfrp4e_battle_status.UI.Unknown");
  if (!test) return actor.name;

  const ctx = test.context || test.data?.context || test._context || {};
  const speaker = ctx.speaker || test.speaker || test.data?.speaker || {};

  if (ctx.speakerData?.alias) return ctx.speakerData.alias;
  if (ctx.speakerData?.token?.name) return ctx.speakerData.token.name;
  if (ctx.token?.name) return ctx.token.name;

  if (speaker.alias) return speaker.alias;

  if (speaker.scene && speaker.token) {
    const scene = game.scenes.get(speaker.scene) || combat?.scene || canvas.scene;
    const tokenDoc = scene?.tokens?.get(speaker.token);
    if (tokenDoc) return tokenDoc.name;
  }

  if (combat) {
    const c = combat.combatants.find((c) => c.actor && c.actor.id === actor.id);
    if (c) return c.token?.name || c.name || actor.name;
  }

  return actor.name;
}

// ---------------------------------------------------------------------------
// Unconscious detection
// ---------------------------------------------------------------------------
function actorIsUnconscious(actor) {
  if (!actor?.hasCondition) return false;

  const baseKey = "unconscious";
  if (actor.hasCondition(baseKey)) return true;

  // Localized system key fallback (best-effort)
  let localized = null;
  try {
    localized = game.i18n?.localize?.("WFRP4E.ConditionName.Unconscious");
  } catch {
    localized = null;
  }
  if (localized && actor.hasCondition(localized)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Apply/track engagement pair
// ---------------------------------------------------------------------------
async function markEngagedPairActors(attackerTest, defenderTest) {
  const combat = getCurrentCombat();
  if (!combat) return;

  const attackerActor = attackerTest?.actor;
  const defenderActor = defenderTest?.actor;

  if (!attackerActor || !defenderActor) return;
  if (!isActorValidForEngaged(attackerActor) || !isActorValidForEngaged(defenderActor)) return;

  const currentRound = getCurrentRound();
  const pairs = duplicate((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
  const key = makePairKey(attackerActor.id, defenderActor.id);

  pairs[key] = {
    a: attackerActor.id,
    b: defenderActor.id,
    lastRound: currentRound
  };

  await combat.setFlag(MODULE_ID, "engagedPairs", pairs);

  await attackerActor.addCondition("engaged");
  await defenderActor.addCondition("engaged");

  const attackerName = getTokenNameFromTest(attackerTest, attackerActor, combat);
  const defenderName = getTokenNameFromTest(defenderTest, defenderActor, combat);

  gmChat(
    tf("wfrp4e_battle_status.Chat.EngagedAppliedPair", {
      attacker: attackerName,
      defender: defenderName,
      round: currentRound
    })
  );

  debugLog("Engaged applied", { attacker: attackerName, defender: defenderName, round: currentRound });
}

// ---------------------------------------------------------------------------
// Round change cleanup (no activity last round)
// ---------------------------------------------------------------------------
async function handleRoundChange(combat, changed) {
  if (!("round" in changed)) return;

  const me = game.users.current;
  if (!me || ![3, 4].includes(me.role)) return; // GM/Assistant only

  const newRound = changed.round;
  if (!newRound || newRound < 1) return;

  const previousRound = newRound - 1;

  // Round 1: reset everything
  if (newRound === 1) {
    await combat.setFlag(MODULE_ID, "engagedPairs", {});
    debugLog("Reset engagedPairs at combat start");

    for (const c of combat.combatants) {
      const actor = c.actor;
      if (!actor) continue;
      try {
        if (actor.hasCondition?.("engaged")) {
          await actor.removeCondition("engaged");
          const tokenName = c.token?.name || c.name || actor.name;
          gmChat(tf("wfrp4e_battle_status.Chat.EngagedRemovedStartCombat", { token: tokenName }));
        }
      } catch (e) {
        debugLog("Error removing engaged at combat start", e);
      }
    }
    return;
  }

  const pairs = duplicate((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});

  // Keep only pairs active in the previous round
  const stillPairs = {};
  const activeActorIds = new Set();

  for (const [key, info] of Object.entries(pairs)) {
    if (!info || typeof info.lastRound !== "number") continue;
    if (info.lastRound !== previousRound) continue;

    stillPairs[key] = info;
    activeActorIds.add(info.a);
    activeActorIds.add(info.b);
  }

  await combat.setFlag(MODULE_ID, "engagedPairs", stillPairs);
  debugLog("Updated engagedPairs end of round", { newRound, stillPairs });

  // Remove engaged from anyone not in an active pair
  for (const c of combat.combatants) {
    const actor = c.actor;
    if (!actor) continue;

    const tokenName = c.token?.name || c.name || actor.name;

    try {
      if (actor.hasCondition?.("engaged") && !activeActorIds.has(actor.id)) {
        await actor.removeCondition("engaged");
        gmChat(
          tf("wfrp4e_battle_status.Chat.EngagedRemovedNoLongerEngaged", {
            token: tokenName,
            round: previousRound
          })
        );
        debugLog("Removed engaged due to end of engagement", { actor: tokenName, id: actor.id });
      }
    } catch (e) {
      debugLog("Error removing engaged on round change", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Unconscious cleanup helper
// - remove all pairs involving actor
// - remove engaged from actor
// - remove engaged from partners if they are no longer paired with anyone
// ---------------------------------------------------------------------------
async function handleActorUnconsciousCleanup(actor, combat, pairs) {
  const actorId = actor.id;
  const partnerIds = new Set();

  for (const [key, info] of Object.entries(pairs)) {
    if (!info) continue;
    if (info.a === actorId || info.b === actorId) {
      const otherId = info.a === actorId ? info.b : info.a;
      partnerIds.add(otherId);
      delete pairs[key];
    }
  }

  if (actor.hasCondition?.("engaged")) {
    await actor.removeCondition("engaged");
    const combatant = combat.combatants.find((c) => c.actor && c.actor.id === actorId);
    const tokenName = combatant?.token?.name || combatant?.name || actor.name;

    gmChat(tf("wfrp4e_battle_status.Chat.EngagedRemovedUnconscious", { token: tokenName }));
    debugLog("Removed engaged due to unconscious (turn change)", { actor: tokenName, id: actorId });
  }

  for (const partnerId of partnerIds) {
    const stillInPair = Object.values(pairs).some(
      (info) => info && (info.a === partnerId || info.b === partnerId)
    );
    if (stillInPair) continue;

    const combatant = combat.combatants.find((c) => c.actor && c.actor.id === partnerId);
    const partnerActor = combatant?.actor || game.actors.get(partnerId);
    if (!partnerActor) continue;

    if (partnerActor.hasCondition?.("engaged")) {
      await partnerActor.removeCondition("engaged");
      const tokenName = combatant?.token?.name || combatant?.name || partnerActor.name;

      gmChat(tf("wfrp4e_battle_status.Chat.EngagedRemovedUnconsciousOpponent", { token: tokenName }));
      debugLog("Removed engaged from partner of unconscious", { actor: tokenName, id: partnerId });
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Turn change cleanup (unconscious)
// ---------------------------------------------------------------------------
async function handleTurnChange(combat, changed) {
  if (!("turn" in changed)) return;

  const me = game.users.current;
  if (!me || ![3, 4].includes(me.role)) return;

  let pairs = duplicate((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
  if (!Object.keys(pairs).length) return;

  const unconsciousCombatants = combat.combatants.filter((c) => c.actor && actorIsUnconscious(c.actor));
  if (!unconsciousCombatants.length) return;

  debugLog("Unconscious cleanup on turn change", {
    unconscious: unconsciousCombatants.map((c) => c.token?.name || c.name || c.actor.name)
  });

  for (const c of unconsciousCombatants) {
    pairs = await handleActorUnconsciousCleanup(c.actor, combat, pairs);
  }

  await combat.setFlag(MODULE_ID, "engagedPairs", pairs);
}

// ---------------------------------------------------------------------------
// INIT (settings only)
// ---------------------------------------------------------------------------
Hooks.once("init", () => {
  registerSettings();
});

// ---------------------------------------------------------------------------
// READY (hooks)
// ---------------------------------------------------------------------------
Hooks.once("ready", () => {
  const me = game.users.current;
  if (!me || ![3, 4].includes(me.role)) return; // GM/Assistant only

  debugLog("Initialized.");

  // 1) Opposed tests: apply engagement on melee
  Hooks.on("wfrp4e:opposedTestResult", async (opposedTest) => {
    try {

      // 1) MASTER TOGGLE
      if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;

      // 2) REQUIRE ACTIVE COMBAT
      const combat = getCurrentCombat();

      if (game.settings.get(MODULE_ID, "requireActiveCombat")) {
        if (!combat) return;

        const started = (typeof combat.started === "boolean")
          ? combat.started
          : ((combat.round ?? 0) > 0);

        if (!started) return;
      }

      if (!isMeleeOpposed(opposedTest)) return;

      const attackerTest = opposedTest.attackerTest;
      const defenderTest = opposedTest.defenderTest;
      if (!attackerTest || !defenderTest) return;

      const attackerActor = attackerTest.actor;
      const defenderActor = defenderTest.actor;
      if (!attackerActor || !defenderActor) return;

      // 3) COMBATANT REQUIREMENT
      // Later: eligibility may still allow non-combatants
      if (!passesCombatantRequirement(attackerActor, defenderActor, combat)) return;

      // Apply Engaged
      await markEngagedPairActors(attackerTest, defenderTest);

    } catch (err) {
      debugLog("Error in opposedTestResult", err);
    }
  });


  // 2) updateCombat: round change + turn change
  Hooks.on("updateCombat", async (combat, changed) => {
    try {
      
      // MASTER TOGGLE
      if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;
      
      if (combat.id !== getCurrentCombat()?.id) return;
      await handleRoundChange(combat, changed);
      await handleTurnChange(combat, changed);
    } catch (err) {
      debugLog("Error in updateCombat", err);
    }
  });

  // 3) Combat end: remove engaged from all combatants
  Hooks.on("deleteCombat", async (combat) => {

    // MASTER TOGGLE
    if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;
    
    const me2 = game.users.current;
    if (!me2 || ![3, 4].includes(me2.role)) return;

    debugLog("Combat ended, cleaning up Engaged.");

    for (const c of combat.combatants) {
      const actor = c.actor;
      if (!actor) continue;
      try {
        if (actor.hasCondition?.("engaged")) {
          await actor.removeCondition("engaged");
          const tokenName = c.token?.name || c.name || actor.name;
          gmChat(tf("wfrp4e_battle_status.Chat.EngagedRemovedEndCombat", { token: tokenName }));
        }
      } catch (e) {
        debugLog("Error removing engaged at combat end", e);
      }
    }

    try {
      await combat.unsetFlag(MODULE_ID, "engagedPairs");
    } catch (e) {
      debugLog("Error unsetting engagedPairs at combat end", e);
    }
  });
});
