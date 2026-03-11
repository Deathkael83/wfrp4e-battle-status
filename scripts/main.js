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
    return { sceneId, tokenId };
  }

  // Fallback: risolvi dal combat SOLO se il token actor è univoco per uuid
  if (combat && actor) {
    const matches = combat.combatants.filter((c) =>
      sameTokenActor(getTokenActorFromCombatant(c), actor)
    );

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

function sameTokenActor(actorA, actorB) {
  if (!actorA || !actorB) return false;
  if (!actorA.uuid || !actorB.uuid) return false;
  return actorA.uuid === actorB.uuid;
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

function getCombatTokenIdsForActor(actor, combat) {
  if (!actor || !combat) return [];

  return combat.combatants
    .filter((c) => sameTokenActor(getTokenActorFromCombatant(c), actor))
    .map((c) => c.token?.id ?? c.tokenId)
    .filter(Boolean);
}

function getCombatantByTokenId(combat, tokenId) {
  if (!combat || !tokenId) return null;
  return combat.combatants.find((c) => (c.token?.id ?? c.tokenId) === tokenId) || null;
}

function getTokenActorFromCombatant(combatant) {
  return combatant?.token?.actor || null;
}

function getTokenDocFromCombatant(combatant) {
  return combatant?.token || null;
}

function getCombatantsForActor(actor, combat) {
  if (!actor || !combat) return [];

  return combat.combatants.filter((c) => {
    const tokenActor = getTokenActorFromCombatant(c);

    if (tokenActor?.uuid && actor?.uuid && tokenActor.uuid === actor.uuid) return true;
    if (c.actor?.uuid && actor?.uuid && c.actor.uuid === actor.uuid) return true;

    return c.actor?.id === actor.id;
  });
}

async function handleTokenDisengageCleanup(tokenId, combat, pairs) {
  if (!tokenId || !combat) return pairs;

  const updated = duplicate(pairs || {});
  let changed = false;

  for (const [key, info] of Object.entries(updated)) {
    if (!info) continue;

    if (info.aToken === tokenId || info.bToken === tokenId) {
      delete updated[key];
      changed = true;
    }
  }

  const combatant = getCombatantByTokenId(combat, tokenId);
  const tokenActor = getTokenActorFromCombatant(combatant);

  if (tokenActor?.hasCondition?.("engaged")) {
    await removeEngagedSilently(tokenActor);
  }

  // Punto chiave: persisti subito il nuovo stato dei pair
  // così eventuali hook annidati non leggono più la flag vecchia
  if (changed) {
    await saveEngagementPairs(combat, updated);
  }

  await normalizeEngagementState(combat, updated);
  return duplicate((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
}

function clearEngagementBadge(token) {
  const badge = token?.getChildByName("engagedBadge");
  if (badge) {
	  
	if (token._engagedBadge) {
        token._engagedBadge.removeAllListeners();
      }
	  
    if (token._engagedBadgeOver) badge.off("pointerover", token._engagedBadgeOver);
    if (token._engagedBadgeOut) badge.off("pointerout", token._engagedBadgeOut);

    token.removeChild(badge);
    badge.destroy();
  }

  const tooltip = token?.getChildByName("engagedTooltip");
  if (tooltip) {
    token.removeChild(tooltip);
    tooltip.destroy({ children: true });
  }

  delete token._engagedBadge;
  delete token._engagedBadgeOver;
  delete token._engagedBadgeOut;
}

function clearAllEngagementUI() {
  if (!canvas?.ready) return;

  for (const token of canvas.tokens.placeables) {
    clearEngagementBadge(token);
  }
}

async function saveEngagementPairs(combat, pairs) {
  if (!combat) return;

  const hasPairs = pairs && Object.keys(pairs).length > 0;

  if (!hasPairs) {
    await combat.unsetFlag(MODULE_ID, "engagedPairs");
    clearAllEngagementUI();
    return;
  }

  await combat.setFlag(MODULE_ID, "engagedPairs", pairs);
  await refreshEngagementUI(combat);
}

async function normalizeEngagementState(combat, pairs) {
  if (!combat) return;

  const normalized = {};
  const activeTokenIds = new Set();

  for (const [key, info] of Object.entries(pairs || {})) {
    if (!info?.aToken || !info?.bToken) continue;

    const aCombatant = getCombatantByTokenId(combat, info.aToken);
    const bCombatant = getCombatantByTokenId(combat, info.bToken);

    if (!aCombatant || !bCombatant) continue;

    const aTokenActor = getTokenActorFromCombatant(aCombatant);
    const bTokenActor = getTokenActorFromCombatant(bCombatant);

    if (!aTokenActor || !bTokenActor) continue;
    if (actorIsUnconscious(aTokenActor) || actorIsUnconscious(bTokenActor)) continue;
    if (aTokenActor.hasCondition?.("dead") || bTokenActor.hasCondition?.("dead")) continue;

    normalized[key] = info;
    activeTokenIds.add(info.aToken);
    activeTokenIds.add(info.bToken);
  }

  for (const c of combat.combatants) {
    const tokenId = c.token?.id ?? c.tokenId;
    const tokenActor = getTokenActorFromCombatant(c);

    if (!tokenId || !tokenActor) continue;

    const shouldBeEngaged = activeTokenIds.has(tokenId);
    const hasEngaged = tokenActor.hasCondition?.("engaged") ?? false;

    if (shouldBeEngaged && !hasEngaged) {
      await tokenActor.addCondition("engaged");
    } else if (!shouldBeEngaged && hasEngaged) {
      await removeEngagedSilently(tokenActor);
    }
  }

  await saveEngagementPairs(combat, normalized);
}

function showEngagementTooltip(token, text) {
  const existing = token.getChildByName("engagedTooltip");
  if (existing) {
    token.removeChild(existing);
    existing.destroy({ children: true });
  }

  const label = new PIXI.Text(text, new PIXI.TextStyle({
    fontSize: 14,
    fill: "#ffffff",
    stroke: "#000000",
    strokeThickness: 3,
    wordWrap: true,
    wordWrapWidth: 220
  }));

  const paddingX = 8;
  const paddingY = 6;
  const width = label.width + paddingX * 2;
  const height = label.height + paddingY * 2;

  const bg = new PIXI.Graphics();
  bg.beginFill(0x000000, 0.85);
  bg.lineStyle(1, 0xffffff, 0.7);
  bg.drawRoundedRect(0, 0, width, height, 6);
  bg.endFill();

  label.x = paddingX;
  label.y = paddingY;

  const container = new PIXI.Container();
  container.name = "engagedTooltip";
  container.zIndex = 1000;

  container.addChild(bg);
  container.addChild(label);

  container.x = Math.max(0, token.w - width);
  container.y = -(height + 6);

  token.addChild(container);
  token.sortableChildren = true;
}

function hideEngagementTooltip(token) {
  const tooltip = token?.getChildByName("engagedTooltip");
  if (!tooltip) return;

  token.removeChild(tooltip);
  tooltip.destroy({ children: true });
}

function renderEngagementBadge(token, count, tooltipText) {
  clearEngagementBadge(token);

  if (!count) return;

  const text = new PIXI.Text(`⚔${count}`, new PIXI.TextStyle({
    fontSize: 16,
    fontWeight: "bold",
    fill: "#ffffff",
    stroke: "#000000",
    strokeThickness: 4
  }));

  text.name = "engagedBadge";
  text.anchor.set(1, 0);
  text.x = token.w - 4;
  text.y = 4;
  text.eventMode = "static";
  text.cursor = "help";
  text.hitArea = new PIXI.Rectangle(-10, -10, 40, 40);

  if (tooltipText) {
    const onOver = () => showEngagementTooltip(token, tooltipText);
    const onOut = () => hideEngagementTooltip(token);

    text.on("pointerover", onOver);
    text.on("pointerout", onOut);

    token._engagedBadgeOver = onOver;
    token._engagedBadgeOut = onOut;
  }

  token.addChild(text);
  token.sortableChildren = true;
  token._engagedBadge = text;
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
    const engagedSet = engagementMap.get(token.id);

    if (!engagedSet || !engagedSet.size) {
      clearEngagementBadge(token);
      continue;
    }

    const count = engagedSet.size;

    const tooltip = buildEngagementTooltip(sceneId, token.id, engagementMap);
    renderEngagementBadge(token, count, tooltip);
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

function resolveTokenDocFromEffect(effect, combat) {
  const actor = effect?.parent;
  if (!actor || !combat) return null;

  // Caso corretto: synthetic actor legato a token
  if (actor.isToken && actor.token) {
    return actor.token;
  }

  // Caso corretto: parent diretto TokenDocument
  if (actor.parent?.documentName === "Token") {
    return actor.parent;
  }

  // Caso corretto: uuid con Scene.Token
  const candidateUuids = [effect?.uuid, actor?.uuid].filter(Boolean);

  for (const uuid of candidateUuids) {
    const match = uuid.match(/Scene\.([^.]+)\.Token\.([^.]+)/);
    if (!match) continue;

    const [, sceneId, tokenId] = match;
    const scene = game.scenes.get(sceneId);
    const tokenDoc = scene?.tokens?.get(tokenId);
    if (tokenDoc) return tokenDoc;
  }

  // Nessun fallback actor-based: meglio non fare cleanup
  // piuttosto che farlo sul token sbagliato.
  return null;
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

function effectMatchesCondition(effect, key, localizedKey) {
  const effectId =
    effect?.getFlag?.("wfrp4e", "conditionId") ||
    effect?.statusId ||
    effect?.name ||
    effect?.label;

  if (!effectId) return false;

  const localized = game.i18n.localize(localizedKey);

  return (
    effectId === key ||
    effectId === key.charAt(0).toUpperCase() + key.slice(1) ||
    effectId === localized
  );
}

async function removeEngagedSilently(actor) {
  if (!actor?.hasCondition?.("engaged")) return;

  const key = actor.uuid ?? actor.id;
  _suppressEngagedEffectHook.add(key);

  try {
    await actor.removeCondition("engaged");
  } finally {
    setTimeout(() => _suppressEngagedEffectHook.delete(key), 0);
  }
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

  if (attackerTokenRef.tokenId === defenderTokenRef.tokenId) return;

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

  await normalizeEngagementState(combat, pairs);

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
  if (!me || ![3, 4].includes(me.role)) return;

  const newRound = changed.round;
  if (!newRound || newRound < 1) return;

  const previousRound = newRound - 1;

  if (newRound === 1) {
    await saveEngagementPairs(combat, {});
    debugLog("Reset engagedPairs at combat start");

    for (const c of combat.combatants) {
      const tokenActor = getTokenActorFromCombatant(c);
      if (!tokenActor) continue;

      try {
        if (tokenActor.hasCondition?.("engaged")) {
          await removeEngagedSilently(tokenActor);

          const tokenName = c.token?.name || c.name || tokenActor.name;
          gmChat(tf("wfrp4e_battle_status.Chat.EngagedRemovedStartCombat", { token: tokenName }));
        }
      } catch (e) {
        debugLog("Error removing engaged at combat start", e);
      }
    }
    return;
  }

  const pairs = duplicate((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
  const stillPairs = {};

  for (const [key, info] of Object.entries(pairs)) {
    if (!info || typeof info.lastRound !== "number") continue;
    if (info.lastRound !== previousRound) continue;
    stillPairs[key] = info;
  }

  await normalizeEngagementState(combat, stillPairs);

  debugLog("Updated engagedPairs end of round", { newRound, stillPairs });

  const activeTokenIds = new Set();
  for (const info of Object.values(stillPairs)) {
    if (!info) continue;
    if (info.aToken) activeTokenIds.add(info.aToken);
    if (info.bToken) activeTokenIds.add(info.bToken);
  }

  for (const c of combat.combatants) {
    const tokenId = c.token?.id ?? c.tokenId;
    const tokenActor = getTokenActorFromCombatant(c);
    if (!tokenId || !tokenActor) continue;

    if (!activeTokenIds.has(tokenId)) {
      const tokenName = c.token?.name || c.name || tokenActor.name;
      gmChat(
        tf("wfrp4e_battle_status.Chat.EngagedRemovedNoLongerEngaged", {
          token: tokenName,
          round: previousRound
        })
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Unconscious cleanup helper
// - remove all pairs involving actor
// - remove engaged from actor
// - remove engaged from partners if they are no longer paired with anyone
// ---------------------------------------------------------------------------
async function handleActorUnconsciousCleanup(combatant, combat, pairs) {
  const tokenId = combatant?.token?.id ?? combatant?.tokenId;
  if (!tokenId) return pairs;

  return await handleTokenDisengageCleanup(tokenId, combat, pairs);
}

async function handleManualEngagedRemovalByToken(tokenDoc, combat) {
  if (!tokenDoc?.id || !combat) return;

  let pairs = duplicate((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
  if (!Object.keys(pairs).length) return;

  await handleTokenDisengageCleanup(tokenDoc.id, combat, pairs);
}

async function handleManualEngagedRemovalByEffect(effect) {
  const actor = effect?.parent;
  if (!actor) return;

  const combat = getCurrentCombat();
  if (!combat) return;

  const tokenDoc = resolveTokenDocFromEffect(effect, combat);

  if (!tokenDoc?.id) {
    debugLog("Cannot resolve exact token for manual engaged removal; skipping cleanup", {
      actor: actor.name,
      actorUuid: actor.uuid,
      effectUuid: effect?.uuid
    });
    return;
  }

  await handleManualEngagedRemovalByToken(tokenDoc, combat);
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

  const unconsciousCombatants = combat.combatants.filter((c) => {
    const tokenActor = getTokenActorFromCombatant(c);
    return tokenActor && actorIsUnconscious(tokenActor);
  });

  if (!unconsciousCombatants.length) return;

  debugLog("Unconscious cleanup on turn change", {
    unconscious: unconsciousCombatants.map((c) => c.token?.name || c.name || getTokenActorFromCombatant(c)?.name)
  });

  for (const c of unconsciousCombatants) {
    pairs = await handleActorUnconsciousCleanup(c, combat, pairs);
  }

  await saveEngagementPairs(combat, pairs);
}

// ---------------------------------------------------------------------------
// INIT (settings only)
// ---------------------------------------------------------------------------

const _suppressEngagedEffectHook = new Set();

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

Hooks.on("deleteActiveEffect", async (effect) => {
  try {
    if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;

    const parent = effect?.parent;
    if (!parent?.hasCondition) return;

    const suppressKey = parent.uuid ?? parent.id;
    if (_suppressEngagedEffectHook.has(suppressKey)) return;

    if (!effectMatchesCondition(effect, "engaged", "WFRP4E.ConditionName.Engaged")) return;

    await handleManualEngagedRemovalByEffect(effect);

    debugLog("Engaged removed manually via ActiveEffect", {
      actor: parent.name,
      actorUuid: parent.uuid
    });
  } catch (err) {
    debugLog("Error handling deleteActiveEffect for Engaged", err);
  }
});

Hooks.on("createActiveEffect", async (effect) => {
  try {
    if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;

    const actor = effect?.parent;
    if (!actor?.hasCondition) return;

    const isUnconscious = effectMatchesCondition(effect, "unconscious", "WFRP4E.ConditionName.Unconscious");
    const isDead = effectMatchesCondition(effect, "dead", "WFRP4E.ConditionName.Dead");

    if (!isUnconscious && !isDead) return;

    const combat = getCurrentCombat();
    if (!combat) return;

    let pairs = duplicate((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
    if (!Object.keys(pairs).length) return;

    const tokenDoc = resolveTokenDocFromEffect(effect, combat);

    if (!tokenDoc?.id) {
      debugLog("Cannot resolve exact token for unconscious/dead cleanup; skipping cleanup", {
        actor: actor.name,
        actorUuid: actor.uuid,
        effectUuid: effect?.uuid,
        unconscious: isUnconscious,
        dead: isDead
      });
      return;
    }

    pairs = await handleTokenDisengageCleanup(tokenDoc.id, combat, pairs);

    debugLog("Engagement cleanup triggered by unconscious/dead", {
      actor: actor.name,
      actorUuid: actor.uuid,
      effectUuid: effect?.uuid,
      tokenId: tokenDoc.id,
      unconscious: isUnconscious,
      dead: isDead
    });
  } catch (err) {
    debugLog("Error handling createActiveEffect for unconscious/dead", err);
  }
});

  // 3) Combat end: remove engaged from all combatants
Hooks.on("preDeleteCombat", async (combat) => {
  if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;

  const me = game.users.current;
  if (!me || ![3, 4].includes(me.role)) return;

  debugLog("Combat ending, cleaning engagement state");

  try {
    for (const c of combat.combatants) {
      const tokenActor = getTokenActorFromCombatant(c);
      if (!tokenActor) continue;

      if (tokenActor.hasCondition?.("engaged")) {
        await removeEngagedSilently(tokenActor);
      }
    }

    await saveEngagementPairs(combat, {});
    clearAllEngagementUI();
  } catch (err) {
    debugLog("Error during preDeleteCombat cleanup", err);
  }
});
  
  Hooks.on("canvasReady", async () => {
    const combat = game.combat;

    if (!combat) {
      clearAllEngagementUI();
      return;
    }

    await refreshEngagementUI(combat);
  });
});
