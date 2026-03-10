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

function makePairKey(aTokenId, bTokenId) {
  const ids = [aTokenId, bTokenId].sort();
  return `${ids[0]}-${ids[1]}`;
}

function getTokenRefFromTest(test, actor, combat) {
  if (!test) return null;

  const ctx = test.context || test.data?.context || test._context || {};
  const speaker = ctx.speaker || test.speaker || test.data?.speaker || {};

  const sceneId = speaker.scene || canvas.scene?.id || combat?.scene?.id || null;
  const tokenId = speaker.token || null;

  if (sceneId && tokenId) {
    return {
      sceneId,
      tokenId
    };
  }

  // Fallback: try to resolve from combat by actor, only if unique
  if (combat && actor) {
    const matches = combat.combatants.filter((c) => c.actor && c.actor.id === actor.id);
    if (matches.length === 1) {
      const combatant = matches[0];
      const resolvedSceneId = combat.scene?.id || canvas.scene?.id || sceneId || null;
      const resolvedTokenId = combatant.token?.id || combatant.tokenId || null;

      if (resolvedSceneId && resolvedTokenId) {
        return {
          sceneId: resolvedSceneId,
          tokenId: resolvedTokenId
        };
      }
    }
  }

  return null;
}

function getActiveTokenIdsFromPairs(pairs, round) {
  const activeTokenIds = new Set();

  for (const info of Object.values(pairs)) {
    if (!info || typeof info.lastRound !== "number") continue;
    if (info.lastRound !== round) continue;

    if (info.aToken) activeTokenIds.add(info.aToken);
    if (info.bToken) activeTokenIds.add(info.bToken);
  }

  return activeTokenIds;
}

function buildEngagementMap(pairs) {
  const map = new Map();

  for (const info of Object.values(pairs)) {
    if (!info) continue;

    const aToken = info.aToken;
    const bToken = info.bToken;

    if (!aToken || !bToken) continue;

    if (!map.has(aToken)) map.set(aToken, new Set());
    if (!map.has(bToken)) map.set(bToken, new Set());

    map.get(aToken).add(bToken);
    map.get(bToken).add(aToken);
  }

  return map;
}

function getSceneTokenName(sceneId, tokenId) {
  const scene = game.scenes.get(sceneId) || canvas.scene;
  const tokenDoc = scene?.tokens?.get(tokenId);
  return tokenDoc?.name || tokenId;
}

function clearEngagementBadge(token) {
  const existing = token?.mesh?.getChildByName("engagedBadge");
  if (existing) {
    token.mesh.removeChild(existing);
    existing.destroy();
  }

  if (token?.mesh?.off) {
    token.mesh.off("pointerover", token._engagedPointerOver);
    token.mesh.off("pointerout", token._engagedPointerOut);
  }

  delete token._engagedPointerOver;
  delete token._engagedPointerOut;
  delete token._engagedTooltipText;

  if (token?.mesh) {
    token.mesh.eventMode = "auto";
    token.mesh.cursor = null;
  }

  const html = token?.hud?.element?.[0];
  if (html) html.removeAttribute("title");
}

function renderEngagementBadge(token, count) {
  clearEngagementBadge(token);

  if (!count) return;

  const style = new PIXI.TextStyle({
    fontSize: 16,
    fontWeight: "bold",
    fill: "#ffffff",
    stroke: "#000000",
    strokeThickness: 4
  });

  const text = new PIXI.Text(`⚔${count}`, style);
  text.name = "engagedBadge";
  text.anchor.set(1, 0);
  text.x = token.w - text.width - 2;
  text.y = 6;

  token.mesh.addChild(text);
}

function attachEngagementTooltip(token, text) {
  if (!token?.mesh || !text) return;

  token._engagedTooltipText = text;

  token.mesh.eventMode = "static";
  token.mesh.cursor = "pointer";

  token._engagedPointerOver = () => {
    if (!token._engagedTooltipText) return;
    token.mesh.tooltip = token._engagedTooltipText;
  };

  token._engagedPointerOut = () => {
    token.mesh.tooltip = null;
  };

  token.mesh.on("pointerover", token._engagedPointerOver);
  token.mesh.on("pointerout", token._engagedPointerOut);
}

function buildEngagementTooltip(sceneId, tokenId, engagementMap) {
  const engagedSet = engagementMap.get(tokenId);
  if (!engagedSet || !engagedSet.size) return null;

  const names = Array.from(engagedSet).map((otherTokenId) => getSceneTokenName(sceneId, otherTokenId));

  return `${t("wfrp4e_battle_status.UI.EngagedList")} (${names.length}): ${names.join(", ")}`;
}

async function refreshEngagementUI(combat) {
  if (!canvas?.ready || !combat) return;

  const pairs = duplicate((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
  const engagementMap = buildEngagementMap(pairs);
  const sceneId = canvas.scene?.id;

  for (const token of canvas.tokens.placeables) {
    clearEngagementBadge(token);

    const engagedSet = engagementMap.get(token.id);
    const count = engagedSet ? engagedSet.size : 0;

    if (!count) continue;

    renderEngagementBadge(token, count);

    const tooltip = buildEngagementTooltip(sceneId, token.id, engagementMap);
    if (tooltip) attachEngagementTooltip(token, tooltip);
  }
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
async function markEngagedPairTokens(attackerTest, defenderTest) {
  const combat = getCurrentCombat();
  if (!combat) return;

  const attackerActor = attackerTest?.actor;
  const defenderActor = defenderTest?.actor;

  if (!attackerActor || !defenderActor) return;
  if (!isActorValidForEngaged(attackerActor) || !isActorValidForEngaged(defenderActor)) return;

  const attackerTokenRef = getTokenRefFromTest(attackerTest, attackerActor, combat);
  const defenderTokenRef = getTokenRefFromTest(defenderTest, defenderActor, combat);

  if (!attackerTokenRef || !defenderTokenRef) {
    debugLog("Unable to resolve token references for engagement pair", {
      attacker: attackerActor.name,
      defender: defenderActor.name
    });
    return;
  }

  if (attackerTokenRef.sceneId !== defenderTokenRef.sceneId) {
    debugLog("Skipping engagement pair across different scenes", {
      attacker: attackerTokenRef,
      defender: defenderTokenRef
    });
    return;
  }

  const currentRound = getCurrentRound();
  const pairs = duplicate((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
  const key = makePairKey(attackerTokenRef.tokenId, defenderTokenRef.tokenId);

  pairs[key] = {
    sceneId: attackerTokenRef.sceneId,
    aToken: attackerTokenRef.tokenId,
    bToken: defenderTokenRef.tokenId,
    aActor: attackerActor.id,
    bActor: defenderActor.id,
    lastRound: currentRound
  };

  await combat.setFlag(MODULE_ID, "engagedPairs", pairs);

  await attackerActor.addCondition("engaged");
  await defenderActor.addCondition("engaged");

  await refreshEngagementUI(combat);

  const attackerName = getTokenNameFromTest(attackerTest, attackerActor, combat);
  const defenderName = getTokenNameFromTest(defenderTest, defenderActor, combat);

  gmChat(
    tf("wfrp4e_battle_status.Chat.EngagedAppliedPair", {
      attacker: attackerName,
      defender: defenderName,
      round: currentRound
    })
  );

  debugLog("Engaged applied", {
    attacker: attackerName,
    defender: defenderName,
    round: currentRound,
    pair: pairs[key]
  });
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
		  
		  await refreshEngagementUI(combat);
		  
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
  const activeTokenIds = new Set();

  for (const [key, info] of Object.entries(pairs)) {
    if (!info || typeof info.lastRound !== "number") continue;
    if (info.lastRound !== previousRound) continue;

    stillPairs[key] = info;
    activeTokenIds.add(info.aToken);
    activeTokenIds.add(info.bToken);
  }

  await combat.setFlag(MODULE_ID, "engagedPairs", stillPairs);

  debugLog("Updated engagedPairs end of round", { newRound, stillPairs });

  // Remove engaged from anyone not in an active pair
  for (const c of combat.combatants) {
    const actor = c.actor;
    if (!actor) continue;

    const tokenName = c.token?.name || c.name || actor.name;

    try {
      const tokenId = c.token?.id ?? c.tokenId;
	  if (
        tokenId &&
        actor.hasCondition?.("engaged") &&
        !activeTokenIds.has(tokenId)
        ) {
        await actor.removeCondition("engaged");
		
		await refreshEngagementUI(combat);
        
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

    if (info.aActor === actorId || info.bActor === actorId) {
      const otherId = info.aActor === actorId ? info.bActor : info.aActor;
      partnerIds.add(otherId);
      delete pairs[key];
    }
  }

  if (actor.hasCondition?.("engaged")) {
    await actor.removeCondition("engaged");

    const combatant = combat.combatants.find((c) => c.actor?.id === actorId);
    const tokenName = combatant?.token?.name || combatant?.name || actor.name;

    gmChat(tf("wfrp4e_battle_status.Chat.EngagedRemovedUnconscious", { token: tokenName }));
    debugLog("Removed engaged due to unconscious (turn change)", { actor: tokenName, id: actorId });
  }

  for (const partnerId of partnerIds) {

    const stillInPair = Object.values(pairs).some(
      (info) => info && (info.aActor === partnerId || info.bActor === partnerId)
    );

    if (stillInPair) continue;

    const combatant = combat.combatants.find((c) => c.actor?.id === partnerId);
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
  await refreshEngagementUI(combat);
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
      await markEngagedPairTokens(attackerTest, defenderTest);

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
	  
	  if (canvas?.ready) {
		  for (const token of canvas.tokens.placeables) {
			  clearEngagementBadge(token);
			  }
			  }
    } catch (e) {
      debugLog("Error unsetting engagedPairs at combat end", e);
    }
  });
});
