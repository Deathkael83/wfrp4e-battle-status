import { MODULE_ID, registerSettings } from "./settings.js";

/**
 * WFRP4e Battle Status
 * - Tracks melee engagements via wfrp4e:opposedTestResult
 * - Applies/removes the "engaged" condition based on engagedPairs flag
 * - Cleans up on unconscious/dead/manual removal/combat end
 * - Shows engagement badges on tokens
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
// Debug
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
// GM/Assistant GM chat helper
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
    .filter((u) => [3, 4].includes(u.role))
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
// Core globals
// ---------------------------------------------------------------------------
const _suppressEngagedEffectHook = new Set();
let _engagementUpdateQueue = Promise.resolve();
const _manualDisengageTokenSuppress = new Set();

function queueEngagementUpdate(fn) {
  _engagementUpdateQueue = _engagementUpdateQueue
    .then(() => fn())
    .catch((err) => {
      debugLog("Queued engagement update error", err);
    });

  return _engagementUpdateQueue;
}

// ---------------------------------------------------------------------------
// Generic helpers
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

function duplicatePairs(pairs) {
  return foundry.utils.deepClone(pairs || {});
}

function getCombatantByTokenId(combat, tokenId) {
  if (!combat || !tokenId) return null;
  return combat.combatants.find((c) => (c.token?.id ?? c.tokenId) === tokenId) || null;
}

function getTokenActorFromCombatant(combatant) {
  return combatant?.token?.actor || combatant?.actor || null;
}

function getTokenDocFromCombatant(combatant) {
  return combatant?.token || null;
}

function getSceneTokenName(sceneId, tokenId) {
  const scene = game.scenes.get(sceneId) || canvas.scene;
  const tokenDoc = scene?.tokens?.get(tokenId);
  return tokenDoc?.name || tokenId;
}

function sameTokenActor(actorA, actorB) {
  if (!actorA || !actorB) return false;
  if (actorA.uuid && actorB.uuid) return actorA.uuid === actorB.uuid;
  if (actorA.id && actorB.id) return actorA.id === actorB.id;
  return false;
}

function getCombatantsForActor(actor, combat) {
  if (!actor || !combat) return [];

  return combat.combatants.filter((c) => {
    const tokenActor = getTokenActorFromCombatant(c);
    return sameTokenActor(tokenActor, actor) || (c.actor && actor && c.actor.id === actor.id);
  });
}

// ---------------------------------------------------------------------------
// Pair storage
// ---------------------------------------------------------------------------
async function loadEngagementPairs(combat) {
  if (!combat) return {};
  return duplicatePairs((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
}

async function setEngagementPairsFlag(combat, pairs) {
  if (!combat) return;

  const hasPairs = pairs && Object.keys(pairs).length > 0;

  if (!hasPairs) {
    await combat.unsetFlag(MODULE_ID, "engagedPairs");
    return;
  }

  await combat.setFlag(MODULE_ID, "engagedPairs", pairs);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function clearEngagementBadge(token) {
  const badge = token?.getChildByName("engagedBadge");
  if (badge) {
    if (token._engagedBadge) token._engagedBadge.removeAllListeners();
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
  for (const token of canvas.tokens.placeables) clearEngagementBadge(token);
}

function buildEngagementMap(pairs) {
  const map = new Map();

  for (const info of Object.values(pairs || {})) {
    if (!info?.aToken || !info?.bToken) continue;

    if (!map.has(info.aToken)) map.set(info.aToken, new Set());
    if (!map.has(info.bToken)) map.set(info.bToken, new Set());

    map.get(info.aToken).add(info.bToken);
    map.get(info.bToken).add(info.aToken);
  }

  return map;
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

async function refreshEngagementUI(combat, pairs = null) {
  if (!canvas?.ready || !combat) return;

  const usedPairs = pairs ?? await loadEngagementPairs(combat);
  const engagementMap = buildEngagementMap(usedPairs);
  const sceneId = canvas.scene?.id;

  for (const token of canvas.tokens.placeables) {
    const engagedSet = engagementMap.get(token.id);

    if (!engagedSet || !engagedSet.size) {
      clearEngagementBadge(token);
      continue;
    }

    renderEngagementBadge(
      token,
      engagedSet.size,
      buildEngagementTooltip(sceneId, token.id, engagementMap)
    );
  }
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------
function isActorValidForEngaged(actor) {
  return actor && actor.system && actor.type !== "vehicle";
}

function passesCombatantRequirement(attacker, defender, combat) {
  const requirement = game.settings.get(MODULE_ID, "combatantRequirement");

  if (requirement === "none") return true;
  if (!combat) return false;

  const combatantIds = new Set(
    combat.combatants
      .filter((c) => c.actor)
      .map((c) => c.actor.id)
  );

  const attackerIsCombatant = combatantIds.has(attacker.id);
  const defenderIsCombatant = combatantIds.has(defender.id);

  if (requirement === "both") return attackerIsCombatant && defenderIsCombatant;
  if (requirement === "either") return attackerIsCombatant || defenderIsCombatant;

  return false;
}

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

function actorIsUnconscious(actor) {
  if (!actor?.hasCondition) return false;

  if (actor.hasCondition("unconscious")) return true;

  let localized = null;
  try {
    localized = game.i18n.localize("WFRP4E.ConditionName.Unconscious");
  } catch {
    localized = null;
  }

  return !!(localized && actor.hasCondition(localized));
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
    const effects = Array.from(actor.effects || []).filter((effect) =>
      effectMatchesCondition(effect, "engaged", "WFRP4E.ConditionName.Engaged")
    );

    for (const effect of effects) {
      await effect.delete({ manual: false, isAuto: true });
    }
  } finally {
    setTimeout(() => _suppressEngagedEffectHook.delete(key), 0);
  }
}

async function addEngagedIfMissing(actor) {
  if (!actor?.addCondition) return;
  if (actor.hasCondition?.("engaged")) return;
  await actor.addCondition("engaged");
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------
function getTokenRefFromTest(test, actor, combat) {
  if (!test) return null;

  const ctx = test.context || test.data?.context || test._context || {};
  const speaker = ctx.speaker || test.speaker || test.data?.speaker || {};

  const sceneId = speaker.scene || canvas.scene?.id || combat?.scene?.id || null;
  const tokenId = speaker.token || null;

  if (sceneId && tokenId) {
    return { sceneId, tokenId };
  }

  if (combat && actor) {
    const matches = getCombatantsForActor(actor, combat);
    if (matches.length === 1) {
      const combatant = matches[0];
      const resolvedSceneId = combat.scene?.id || canvas.scene?.id || sceneId || null;
      const resolvedTokenId = combatant.token?.id || combatant.tokenId || null;

      if (resolvedSceneId && resolvedTokenId) {
        return { sceneId: resolvedSceneId, tokenId: resolvedTokenId };
      }
    }
  }

  return null;
}

function resolveTokenDocFromEffect(effect, combat) {
  const actor = effect?.parent;
  if (!actor || !combat) return null;

  if (actor.isToken && actor.token) {
    return actor.token;
  }

  if (actor.parent?.documentName === "Token") {
    return actor.parent;
  }

  const candidateUuids = [effect?.uuid, actor?.uuid].filter(Boolean);

  for (const uuid of candidateUuids) {
    const match = uuid.match(/Scene\.([^.]+)\.Token\.([^.]+)/);
    if (!match) continue;

    const [, sceneId, tokenId] = match;
    const scene = game.scenes.get(sceneId);
    const tokenDoc = scene?.tokens?.get(tokenId);
    if (tokenDoc) return tokenDoc;
  }

  const activeTokens = actor.getActiveTokens?.(true) || [];
  if (activeTokens.length === 1) {
    return activeTokens[0]?.document || activeTokens[0];
  }

  const matches = getCombatantsForActor(actor, combat);
  if (matches.length === 1) {
    return getTokenDocFromCombatant(matches[0]);
  }

  return null;
}

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
    const matches = getCombatantsForActor(actor, combat);
    if (matches.length === 1) {
      const c = matches[0];
      return c.token?.name || c.name || actor.name;
    }
  }

  return actor.name;
}

// ---------------------------------------------------------------------------
// Pair normalization + sync
// ---------------------------------------------------------------------------
function pruneEngagementPairs(combat, pairs) {
  const normalized = {};

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
  }

  return normalized;
}

async function syncEngagedConditions(combat, pairs) {
  const activeTokenIds = new Set();

  for (const info of Object.values(pairs || {})) {
    if (!info?.aToken || !info?.bToken) continue;
    activeTokenIds.add(info.aToken);
    activeTokenIds.add(info.bToken);
  }

  for (const c of combat.combatants) {
    const tokenId = c.token?.id ?? c.tokenId;
    const tokenActor = getTokenActorFromCombatant(c);
    if (!tokenId || !tokenActor) continue;

    const shouldBeEngaged = activeTokenIds.has(tokenId);
    const hasEngaged = tokenActor.hasCondition?.("engaged") ?? false;
    const suppressManualReadd = _manualDisengageTokenSuppress.has(tokenId);

    if (shouldBeEngaged && !hasEngaged) {
      if (suppressManualReadd) {
        debugLog("Skipping engaged re-add during manual disengage sync", {
          tokenId,
          tokenName: c.token?.name || c.name || tokenActor.name
        });
        continue;
      }

      await addEngagedIfMissing(tokenActor);
    } else if (!shouldBeEngaged && hasEngaged) {
      await removeEngagedSilently(tokenActor);
    }
  }
}

async function commitEngagementState(combat, pairs) {
  if (!combat) return {};

  const normalized = pruneEngagementPairs(combat, pairs);
  await setEngagementPairsFlag(combat, normalized);
  await syncEngagedConditions(combat, normalized);
  await refreshEngagementUI(combat, normalized);

  return normalized;
}

// ---------------------------------------------------------------------------
// Engagement mutation helpers
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

  const pairs = await loadEngagementPairs(combat);
  const key = makePairKey(attackerTokenRef.tokenId, defenderTokenRef.tokenId);

  pairs[key] = {
    sceneId: attackerTokenRef.sceneId,
    aToken: attackerTokenRef.tokenId,
    bToken: defenderTokenRef.tokenId,
    aActor: attackerActor.id,
    bActor: defenderActor.id,
    lastRound: getCurrentRound()
  };

  await commitEngagementState(combat, pairs);

  const attackerName = getTokenNameFromTest(attackerTest, attackerActor, combat);
  const defenderName = getTokenNameFromTest(defenderTest, defenderActor, combat);

  gmChat(
    tf("wfrp4e_battle_status.Chat.EngagedAppliedPair", {
      attacker: attackerName,
      defender: defenderName,
      round: getCurrentRound()
    })
  );

  debugLog("Engaged pair added", { key, attackerName, defenderName });
}

async function removePairsForTokenId(combat, tokenId) {
  if (!combat || !tokenId) return;

  let pairs = await loadEngagementPairs(combat);
  // Trova l'attore legato a questo ID per avere anche il suo ActorID
  const tokenDoc = canvas.scene.tokens.get(tokenId);
  const actorId = tokenDoc?.actorId;

  let deletedAny = false;
  const affectedTokenIds = new Set([tokenId]);

  for (const [key, info] of Object.entries(pairs)) {
    // Controlla se il tokenId O l'actorId corrispondono a aToken/aActor o bToken/bActor
    const matchesA = info.aToken === tokenId || (actorId && info.aActor === actorId);
    const matchesB = info.bToken === tokenId || (actorId && info.bActor === actorId);

    if (matchesA || matchesB) {
      if (info.aToken) affectedTokenIds.add(info.aToken);
      if (info.bToken) affectedTokenIds.add(info.bToken);
      
      delete pairs[key]; // Rimuove la coppia incriminata
      deletedAny = true;
      console.log(`WFRP4e Engagement: Rimossa coppia obsoleta ${key}`);
    }
  }

  if (deletedAny) {
    // Attiviamo la soppressione per tutti i token coinvolti nella pulizia
    for (const id of affectedTokenIds) {
      _manualDisengageTokenSuppress.add(id);
    }

    await commitEngagementState(combat, pairs);

    // Timeout generoso per permettere al DB di Foundry di aggiornarsi
    setTimeout(() => {
      for (const id of affectedTokenIds) {
        _manualDisengageTokenSuppress.delete(id);
      }
    }, 300);
  }
}

async function handleActorUnconsciousCleanup(combatant, combat) {
  const tokenId = combatant?.token?.id ?? combatant?.tokenId;
  if (!tokenId) return {};
  return await removePairsForTokenId(combat, tokenId);
}

async function handleManualEngagedRemovalByToken(tokenDoc, combat) {
  if (!tokenDoc?.id || !combat) return;
  await removePairsForTokenId(combat, tokenDoc.id);
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
// Round / turn cleanup
// ---------------------------------------------------------------------------
async function handleRoundChange(combat, changed) {
  if (!("round" in changed)) return;

  const me = game.users.current;
  if (!me || ![3, 4].includes(me.role)) return;

  const newRound = changed.round;
  if (!newRound || newRound < 1) return;

  if (newRound === 1) {
    for (const c of combat.combatants) {
      const tokenActor = getTokenActorFromCombatant(c);
      if (!tokenActor) continue;

      if (tokenActor.hasCondition?.("engaged")) {
        await removeEngagedSilently(tokenActor);
        const tokenName = c.token?.name || c.name || tokenActor.name;
        gmChat(tf("wfrp4e_battle_status.Chat.EngagedRemovedStartCombat", { token: tokenName }));
      }
    }

    await commitEngagementState(combat, {});
    debugLog("Reset engagement state at combat start");
    return;
  }

  const previousRound = newRound - 1;
  const pairs = await loadEngagementPairs(combat);
  const stillPairs = {};

  for (const [key, info] of Object.entries(pairs)) {
    if (!info || typeof info.lastRound !== "number") continue;
    if (info.lastRound !== previousRound) continue;
    stillPairs[key] = info;
  }

  await commitEngagementState(combat, stillPairs);

  const activeTokenIds = new Set();
  for (const info of Object.values(stillPairs)) {
    if (info?.aToken) activeTokenIds.add(info.aToken);
    if (info?.bToken) activeTokenIds.add(info.bToken);
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

async function handleTurnChange(combat, changed) {
  if (!("turn" in changed)) return;

  const me = game.users.current;
  if (!me || ![3, 4].includes(me.role)) return;

  const unconsciousCombatants = combat.combatants.filter((c) => {
    const tokenActor = getTokenActorFromCombatant(c);
    return tokenActor && actorIsUnconscious(tokenActor);
  });

  if (!unconsciousCombatants.length) return;

  debugLog("Unconscious cleanup on turn change", {
    unconscious: unconsciousCombatants.map((c) => c.token?.name || c.name || getTokenActorFromCombatant(c)?.name)
  });

  for (const c of unconsciousCombatants) {
    await handleActorUnconsciousCleanup(c, combat);
  }
}

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------
Hooks.once("init", () => {
  registerSettings();
});

// ---------------------------------------------------------------------------
// READY
// ---------------------------------------------------------------------------
Hooks.once("ready", () => {
  const me = game.users.current;
  if (!me || ![3, 4].includes(me.role)) return;

  debugLog("Initialized.");

  Hooks.on("wfrp4e:opposedTestResult", async (opposedTest) => {
    return queueEngagementUpdate(async () => {
      try {
        if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;

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

        if (!passesCombatantRequirement(attackerActor, defenderActor, combat)) return;

        await markEngagedPairTokens(attackerTest, defenderTest);
      } catch (err) {
        debugLog("Error in opposedTestResult", err);
      }
    });
  });

  Hooks.on("updateCombat", async (combat, changed) => {
    return queueEngagementUpdate(async () => {
      try {
        if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;
        if (combat.id !== getCurrentCombat()?.id) return;

        await handleRoundChange(combat, changed);
        await handleTurnChange(combat, changed);
      } catch (err) {
        debugLog("Error in updateCombat", err);
      }
    });
  });

Hooks.on("deleteActiveEffect", async (effect, options, userId) => {
  return queueEngagementUpdate(async () => {
    try {
      if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;

      const actor = effect?.parent;
      if (!actor?.hasCondition) return;

      const suppressKey = actor.uuid ?? actor.id;
      if (_suppressEngagedEffectHook.has(suppressKey)) return;

      if (!effectMatchesCondition(effect, "engaged", "WFRP4E.ConditionName.Engaged")) return;

      // Ignora rimozioni automatiche/scriptate del modulo o di altre automazioni
      if (options?.manual === false || options?.isAuto === true) {
        debugLog("Ignoring scripted/automatic engaged deletion", {
          actor: actor.name,
          actorUuid: actor.uuid,
          effectUuid: effect?.uuid,
          options,
          userId
        });
        return;
      }

      const combat = getCurrentCombat();
      if (!combat) return;

      const tokenDoc = resolveTokenDocFromEffect(effect, combat);
      if (!tokenDoc?.id) {
        debugLog("Cannot resolve exact token for engaged delete cleanup; skipping cleanup", {
          actor: actor.name,
          actorUuid: actor.uuid,
          effectUuid: effect?.uuid,
          options
        });
        return;
      }

      await removePairsForTokenId(combat, tokenDoc.id);

      debugLog("Engagement cleanup triggered by manual engaged delete", {
        actor: actor.name,
        actorUuid: actor.uuid,
        effectUuid: effect?.uuid,
        tokenId: tokenDoc.id,
        options,
        userId
      });
    } catch (err) {
      debugLog("Error handling deleteActiveEffect for Engaged", err);
    }
  });
});

  Hooks.on("createActiveEffect", async (effect) => {
    return queueEngagementUpdate(async () => {
      try {
        if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;

        const actor = effect?.parent;
        if (!actor?.hasCondition) return;

        const isUnconscious = effectMatchesCondition(effect, "unconscious", "WFRP4E.ConditionName.Unconscious");
        const isDead = effectMatchesCondition(effect, "dead", "WFRP4E.ConditionName.Dead");

        if (!isUnconscious && !isDead) return;

        const combat = getCurrentCombat();
        if (!combat) return;

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

        await removePairsForTokenId(combat, tokenDoc.id);

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
  });

  Hooks.on("preDeleteCombat", async (combat) => {
    return queueEngagementUpdate(async () => {
      try {
        if (!game.settings.get(MODULE_ID, "enableAutoEngaged")) return;

        const me = game.users.current;
        if (!me || ![3, 4].includes(me.role)) return;

        debugLog("Combat ending, cleaning engagement state");

        for (const c of combat.combatants) {
          const tokenActor = getTokenActorFromCombatant(c);
          if (!tokenActor) continue;

          if (tokenActor.hasCondition?.("engaged")) {
            await removeEngagedSilently(tokenActor);

            const tokenName = c.token?.name || c.name || tokenActor.name;
            gmChat(tf("wfrp4e_battle_status.Chat.EngagedRemovedEndCombat", { token: tokenName }));
          }
        }

        await commitEngagementState(combat, {});
        clearAllEngagementUI();
      } catch (err) {
        debugLog("Error during preDeleteCombat cleanup", err);
      }
    });
  });

  Hooks.on("canvasReady", async () => {
    const combat = getCurrentCombat();
    if (!combat) return;
    await refreshEngagementUI(combat);
  });
});