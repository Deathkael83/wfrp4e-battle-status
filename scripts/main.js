import { MODULE_ID, registerSettings } from "./settings.js";

/**
 * WFRP4e Battle Status
 * - Tracks melee engagements via wfrp4e:opposedTestResult
 * - Applies/removes the "engaged" condition based on engagedPairs flag
 * - Cleans up on unconscious/dead/manual removal/combat end
 * - Shows engagement badges on tokens
 *
 * Core rule:
 * - pair identity is TOKEN-BASED, never actor-based
 * - manual engaged removal resolves the exact token
 * - engagedPairs flag is the single source of truth
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

function summarizePairs(pairs) {
  const obj = pairs || {};
  return Object.fromEntries(
    Object.entries(obj).map(([key, info]) => [
      key,
      {
        aToken: info?.aToken ?? null,
        bToken: info?.bToken ?? null,
        aKey: info?.aKey ?? null,
        bKey: info?.bKey ?? null,
        lastRound: info?.lastRound ?? null
      }
    ])
  );
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
const _suppressEngagedEffectDeletes = new Set();
const _manualDisengageTokenSuppress = new Set();
const _pendingManualDisengageTokenKeys = new Set();

let _engagementUpdateQueue = Promise.resolve();
let _manualDisengageFlushTimer = null;

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

function duplicatePairs(pairs) {
  return foundry.utils.deepClone(pairs || {});
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

function getSceneTokenName(sceneId, tokenId) {
  const scene = game.scenes.get(sceneId) || canvas.scene;
  const tokenDoc = scene?.tokens?.get(tokenId);
  return tokenDoc?.name || tokenId;
}

function sameTokenActor(actorA, actorB) {
  if (!actorA || !actorB) return false;
  if (!actorA.uuid || !actorB.uuid) return false;
  return actorA.uuid === actorB.uuid;
}

function getPersistentTokenKey(tokenDoc) {
  if (!tokenDoc?.uuid) return null;
  return tokenDoc.uuid.replace(/\./g, "-");
}

function makePairKeyFromKeys(aKey, bKey) {
  const ids = [aKey, bKey].sort();
  return `${ids[0]}--${ids[1]}`;
}

function getCombatantsForActor(actor, combat) {
  if (!actor || !combat) return [];

  return combat.combatants.filter((c) => {
    const tokenActor = getTokenActorFromCombatant(c);
    return sameTokenActor(tokenActor, actor);
  });
}

function getCombatantByTokenKey(combat, tokenKey) {
  if (!combat || !tokenKey) return null;

  return combat.combatants.find((c) => {
    const tokenDoc = getTokenDocFromCombatant(c);
    return getPersistentTokenKey(tokenDoc) === tokenKey;
  }) || null;
}

// ---------------------------------------------------------------------------
// Pair storage
// ---------------------------------------------------------------------------
async function loadEngagementPairs(combat) {
  if (!combat) return {};
  const loaded = duplicatePairs((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
  debugLog("loadEngagementPairs", summarizePairs(loaded));
  return loaded;
}

async function setEngagementPairsFlag(combat, pairs) {
  if (!combat) return;

  const hasPairs = pairs && Object.keys(pairs).length > 0;

  debugLog("setEngagementPairsFlag", {
    hasPairs,
    pairs: summarizePairs(pairs)
  });

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
  if (!actor?.effects?.size && !actor?.effects?.length) return;

  const effects = Array.from(actor.effects || []).filter((effect) =>
    effectMatchesCondition(effect, "engaged", "WFRP4E.ConditionName.Engaged")
  );

  if (!effects.length) return;

  debugLog("removeEngagedSilently:start", {
    actorName: actor.name,
    actorUuid: actor.uuid,
    effects: effects.map((e) => ({ uuid: e.uuid, name: e.name, label: e.label }))
  });

  try {
    for (const effect of effects) {
      if (effect?.uuid) _suppressEngagedEffectDeletes.add(effect.uuid);
      await effect.delete({ manual: false, isAuto: true });
    }
  } finally {
    setTimeout(() => {
      for (const effect of effects) {
        if (effect?.uuid) _suppressEngagedEffectDeletes.delete(effect.uuid);
      }
    }, 0);
  }

  debugLog("removeEngagedSilently:end", {
    actorName: actor.name,
    actorUuid: actor.uuid
  });
}

async function addEngagedIfMissing(actor) {
  if (!actor?.addCondition) return;
  if (actor.hasCondition?.("engaged")) return;

  debugLog("addEngagedIfMissing", {
    actorName: actor.name,
    actorUuid: actor.uuid
  });

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
    const scene = game.scenes.get(sceneId) || canvas.scene;
    const tokenDoc = scene?.tokens?.get(tokenId) || null;
    const tokenKey = getPersistentTokenKey(tokenDoc);

    const result = tokenKey ? { sceneId, tokenId, tokenKey } : null;
    debugLog("getTokenRefFromTest:speaker", {
      actorName: actor?.name,
      sceneId,
      tokenId,
      tokenKey,
      result
    });
    return result;
  }

  if (combat && actor) {
    const matches = getCombatantsForActor(actor, combat);
    if (matches.length === 1) {
      const combatant = matches[0];
      const tokenDoc = getTokenDocFromCombatant(combatant);
      const resolvedSceneId = combat.scene?.id || canvas.scene?.id || null;
      const resolvedTokenId = tokenDoc?.id ?? combatant.tokenId ?? null;
      const tokenKey = getPersistentTokenKey(tokenDoc);

      const result = (resolvedSceneId && resolvedTokenId && tokenKey)
        ? { sceneId: resolvedSceneId, tokenId: resolvedTokenId, tokenKey }
        : null;

      debugLog("getTokenRefFromTest:fallback", {
        actorName: actor?.name,
        actorUuid: actor?.uuid,
        matches: matches.map((m) => ({
          tokenId: m.token?.id ?? m.tokenId,
          tokenName: m.token?.name ?? m.name,
          tokenKey: getPersistentTokenKey(getTokenDocFromCombatant(m))
        })),
        result
      });

      return result;
    }
  }

  debugLog("getTokenRefFromTest:unresolved", {
    actorName: actor?.name,
    actorUuid: actor?.uuid
  });

  return null;
}

function resolveTokenDocFromEffect(effect, combat) {
  const actor = effect?.parent;
  if (!actor || !combat) {
    debugLog("resolveTokenDocFromEffect:no-actor-or-combat", {
      effectUuid: effect?.uuid,
      actorUuid: actor?.uuid
    });
    return null;
  }

  if (actor.isToken && actor.token) {
    debugLog("resolveTokenDocFromEffect:actor-is-token", {
      effectUuid: effect?.uuid,
      actorUuid: actor?.uuid,
      tokenId: actor.token.id,
      tokenName: actor.token.name,
      tokenKey: getPersistentTokenKey(actor.token)
    });
    return actor.token;
  }

  if (actor.parent?.documentName === "Token") {
    debugLog("resolveTokenDocFromEffect:token-parent", {
      effectUuid: effect?.uuid,
      actorUuid: actor?.uuid,
      tokenId: actor.parent.id,
      tokenName: actor.parent.name,
      tokenKey: getPersistentTokenKey(actor.parent)
    });
    return actor.parent;
  }

  const candidateUuids = [effect?.uuid, actor?.uuid].filter(Boolean);

  for (const uuid of candidateUuids) {
    const match = uuid.match(/Scene\.([^.]+)\.Token\.([^.]+)/);
    if (!match) continue;

    const [, sceneId, tokenId] = match;
    const scene = game.scenes.get(sceneId);
    const tokenDoc = scene?.tokens?.get(tokenId);

    if (tokenDoc) {
      debugLog("resolveTokenDocFromEffect:uuid-match", {
        effectUuid: effect?.uuid,
        actorUuid: actor?.uuid,
        sourceUuid: uuid,
        tokenId,
        tokenName: tokenDoc.name,
        tokenKey: getPersistentTokenKey(tokenDoc)
      });
      return tokenDoc;
    }
  }

  const activeTokens = actor.getActiveTokens?.(true) || [];
  if (activeTokens.length === 1) {
    const tokenDoc = activeTokens[0]?.document || activeTokens[0];
    debugLog("resolveTokenDocFromEffect:active-token", {
      effectUuid: effect?.uuid,
      actorUuid: actor?.uuid,
      tokenId: tokenDoc?.id,
      tokenName: tokenDoc?.name,
      tokenKey: getPersistentTokenKey(tokenDoc)
    });
    return tokenDoc;
  }

  const matches = getCombatantsForActor(actor, combat);
  if (matches.length === 1) {
    const tokenDoc = getTokenDocFromCombatant(matches[0]);
    debugLog("resolveTokenDocFromEffect:combat-match", {
      effectUuid: effect?.uuid,
      actorUuid: actor?.uuid,
      tokenId: tokenDoc?.id,
      tokenName: tokenDoc?.name,
      tokenKey: getPersistentTokenKey(tokenDoc)
    });
    return tokenDoc;
  }

  debugLog("resolveTokenDocFromEffect:unresolved", {
    effectUuid: effect?.uuid,
    actorUuid: actor?.uuid,
    activeTokens: activeTokens.map((t) => ({
      tokenId: t?.document?.id ?? t?.id,
      tokenName: t?.document?.name ?? t?.name,
      tokenKey: getPersistentTokenKey(t?.document || t)
    })),
    matches: matches.map((m) => ({
      tokenId: m.token?.id ?? m.tokenId,
      tokenName: m.token?.name ?? m.name,
      tokenKey: getPersistentTokenKey(getTokenDocFromCombatant(m))
    }))
  });

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
    if (!info?.aToken || !info?.bToken || !info?.aKey || !info?.bKey) {
      debugLog("pruneEngagementPairs:skip-missing-fields", { key, info });
      continue;
    }

    const aCombatant = getCombatantByTokenKey(combat, info.aKey);
    const bCombatant = getCombatantByTokenKey(combat, info.bKey);
    if (!aCombatant || !bCombatant) {
      debugLog("pruneEngagementPairs:skip-missing-combatant", {
        key,
        info,
        aFound: !!aCombatant,
        bFound: !!bCombatant
      });
      continue;
    }

    const aTokenActor = getTokenActorFromCombatant(aCombatant);
    const bTokenActor = getTokenActorFromCombatant(bCombatant);
    if (!aTokenActor || !bTokenActor) {
      debugLog("pruneEngagementPairs:skip-missing-token-actor", { key, info });
      continue;
    }

    if (actorIsUnconscious(aTokenActor) || actorIsUnconscious(bTokenActor)) {
      debugLog("pruneEngagementPairs:skip-unconscious", {
        key,
        info,
        aName: aCombatant.token?.name,
        bName: bCombatant.token?.name
      });
      continue;
    }

    if (aTokenActor.hasCondition?.("dead") || bTokenActor.hasCondition?.("dead")) {
      debugLog("pruneEngagementPairs:skip-dead", {
        key,
        info,
        aName: aCombatant.token?.name,
        bName: bCombatant.token?.name
      });
      continue;
    }

    normalized[key] = info;
  }

  debugLog("pruneEngagementPairs:result", summarizePairs(normalized));
  return normalized;
}

async function syncEngagedConditions(combat, pairs) {
  const activeTokenKeys = new Set();

  for (const info of Object.values(pairs || {})) {
    if (!info?.aKey || !info?.bKey) continue;
    activeTokenKeys.add(info.aKey);
    activeTokenKeys.add(info.bKey);
  }

  debugLog("syncEngagedConditions:start", {
    activeTokenKeys: Array.from(activeTokenKeys),
    manualSuppress: Array.from(_manualDisengageTokenSuppress),
    pairs: summarizePairs(pairs)
  });

  for (const c of combat.combatants) {
    const tokenDoc = getTokenDocFromCombatant(c);
    const tokenActor = getTokenActorFromCombatant(c);
    const tokenKey = getPersistentTokenKey(tokenDoc);

    if (!tokenDoc?.id || !tokenActor || !tokenKey) continue;

    const shouldBeEngaged = activeTokenKeys.has(tokenKey);
    const hasEngaged = tokenActor.hasCondition?.("engaged") ?? false;
    const suppressManualReadd = _manualDisengageTokenSuppress.has(tokenKey);

    debugLog("syncEngagedConditions:token", {
      tokenId: tokenDoc.id,
      tokenKey,
      tokenName: tokenDoc.name || c.name || tokenActor.name,
      shouldBeEngaged,
      hasEngaged,
      suppressManualReadd
    });

    if (shouldBeEngaged && !hasEngaged) {
      if (suppressManualReadd) {
        debugLog("syncEngagedConditions:skip-readd", {
          tokenId: tokenDoc.id,
          tokenKey,
          tokenName: tokenDoc.name || c.name || tokenActor.name
        });
        continue;
      }

      await addEngagedIfMissing(tokenActor);
    } else if (!shouldBeEngaged && hasEngaged) {
      await removeEngagedSilently(tokenActor);
    }
  }

  debugLog("syncEngagedConditions:end");
}

async function commitEngagementState(combat, pairs) {
  if (!combat) return {};

  debugLog("commitEngagementState:start", {
    inputPairs: summarizePairs(pairs)
  });

  const normalized = pruneEngagementPairs(combat, pairs);

  debugLog("commitEngagementState:after-prune", {
    normalizedPairs: summarizePairs(normalized)
  });

  await setEngagementPairsFlag(combat, normalized);

  const reloadedAfterSave = duplicatePairs((await combat.getFlag(MODULE_ID, "engagedPairs")) || {});
  debugLog("commitEngagementState:after-save-reload", {
    savedPairs: summarizePairs(reloadedAfterSave)
  });

  await syncEngagedConditions(combat, normalized);
  await refreshEngagementUI(combat, normalized);

  debugLog("commitEngagementState:end", {
    finalPairs: summarizePairs(normalized)
  });

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

  if (attackerTokenRef.tokenKey === defenderTokenRef.tokenKey) return;

  const pairs = await loadEngagementPairs(combat);
  const key = makePairKeyFromKeys(attackerTokenRef.tokenKey, defenderTokenRef.tokenKey);

  pairs[key] = {
    sceneId: attackerTokenRef.sceneId,
    aToken: attackerTokenRef.tokenId,
    bToken: defenderTokenRef.tokenId,
    aKey: attackerTokenRef.tokenKey,
    bKey: defenderTokenRef.tokenKey,
    lastRound: getCurrentRound()
  };

  debugLog("markEngagedPairTokens:before-commit", {
    pairKey: key,
    pair: pairs[key],
    allPairs: summarizePairs(pairs)
  });

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

async function removePairsForTokenKey(combat, tokenKey) {
  if (!combat || !tokenKey) return {};

  const pairs = await loadEngagementPairs(combat);
  const affectedTokenKeys = new Set([tokenKey]);
  let deletedAny = false;

  debugLog("removePairsForTokenKey:start", {
    tokenKey,
    loadedPairs: summarizePairs(pairs)
  });

  for (const [key, info] of Object.entries(pairs)) {
    if (!info) continue;

    const matchesA = info.aKey === tokenKey;
    const matchesB = info.bKey === tokenKey;

    debugLog("removePairsForTokenKey:inspect-pair", {
      key,
      tokenKey,
      matchesA,
      matchesB,
      pair: info
    });

    if (matchesA || matchesB) {
      if (info.aKey) affectedTokenKeys.add(info.aKey);
      if (info.bKey) affectedTokenKeys.add(info.bKey);

      delete pairs[key];
      deletedAny = true;

      debugLog("removePairsForTokenKey:removed-pair", {
        key,
        removedForTokenKey: tokenKey,
        pair: info
      });
    }
  }

  if (!deletedAny) {
    debugLog("removePairsForTokenKey:no-pairs-found", { tokenKey });
    return {};
  }

  debugLog("removePairsForTokenKey:before-commit", {
    tokenKey,
    affectedTokenKeys: Array.from(affectedTokenKeys),
    remainingPairs: summarizePairs(pairs)
  });

  for (const key of affectedTokenKeys) {
    _manualDisengageTokenSuppress.add(key);
  }

  try {
    const result = await commitEngagementState(combat, pairs);

    debugLog("removePairsForTokenKey:after-commit", {
      tokenKey,
      affectedTokenKeys: Array.from(affectedTokenKeys),
      committedPairs: summarizePairs(result)
    });

    return result;
  } finally {
    setTimeout(() => {
      for (const key of affectedTokenKeys) {
        _manualDisengageTokenSuppress.delete(key);
      }

      debugLog("removePairsForTokenKey:manual-suppress-cleared", {
        tokenKey,
        affectedTokenKeys: Array.from(affectedTokenKeys),
        remainingSuppress: Array.from(_manualDisengageTokenSuppress)
      });
    }, 100);
  }
}

async function reconcilePairsAfterManualDelete(combat, tokenKeys) {
  const pairs = await loadEngagementPairs(combat);
  const reconciled = {};
  const removedPairs = [];
  const affectedTokenKeys = new Set(tokenKeys);

  debugLog("reconcilePairsAfterManualDelete:start", {
    tokenKeys,
    loadedPairs: summarizePairs(pairs)
  });

  for (const [key, info] of Object.entries(pairs)) {
    if (!info?.aKey || !info?.bKey) continue;

    const aCombatant = getCombatantByTokenKey(combat, info.aKey);
    const bCombatant = getCombatantByTokenKey(combat, info.bKey);
    const aActor = aCombatant ? getTokenActorFromCombatant(aCombatant) : null;
    const bActor = bCombatant ? getTokenActorFromCombatant(bCombatant) : null;

    const touchesManual =
      tokenKeys.includes(info.aKey) ||
      tokenKeys.includes(info.bKey);

    const aHasEngaged = aActor?.hasCondition?.("engaged") ?? false;
    const bHasEngaged = bActor?.hasCondition?.("engaged") ?? false;

    const keep =
      !touchesManual &&
      !!aCombatant &&
      !!bCombatant &&
      !!aActor &&
      !!bActor &&
      aHasEngaged &&
      bHasEngaged;

    if (keep) {
      reconciled[key] = info;
    } else {
      removedPairs.push({
        key,
        pair: info,
        touchesManual,
        aHasEngaged,
        bHasEngaged
      });

      if (info.aKey) affectedTokenKeys.add(info.aKey);
      if (info.bKey) affectedTokenKeys.add(info.bKey);
    }
  }

  debugLog("reconcilePairsAfterManualDelete:removedPairs", removedPairs);
  debugLog("reconcilePairsAfterManualDelete:reconciled", summarizePairs(reconciled));

  for (const key of affectedTokenKeys) {
    _manualDisengageTokenSuppress.add(key);
  }

  try {
    await commitEngagementState(combat, reconciled);

    debugLog("reconcilePairsAfterManualDelete:after-commit", {
      tokenKeys,
      affectedTokenKeys: Array.from(affectedTokenKeys),
      finalPairs: summarizePairs(await loadEngagementPairs(combat))
    });
  } finally {
    setTimeout(() => {
      for (const key of affectedTokenKeys) {
        _manualDisengageTokenSuppress.delete(key);
      }

      debugLog("reconcilePairsAfterManualDelete:manual-suppress-cleared", {
        affectedTokenKeys: Array.from(affectedTokenKeys),
        remainingSuppress: Array.from(_manualDisengageTokenSuppress)
      });
    }, 100);
  }
}

async function flushPendingManualDisengages(combat) {
  if (!combat) return;

  const tokenKeys = Array.from(_pendingManualDisengageTokenKeys);
  _pendingManualDisengageTokenKeys.clear();

  if (!tokenKeys.length) {
    debugLog("flushPendingManualDisengages:nothing-to-do");
    return;
  }

  debugLog("flushPendingManualDisengages:start", {
    tokenKeys
  });

  await reconcilePairsAfterManualDelete(combat, tokenKeys);
}

function scheduleManualDisengageFlush(combat, tokenKey) {
  if (!combat || !tokenKey) return;

  _pendingManualDisengageTokenKeys.add(tokenKey);

  debugLog("scheduleManualDisengageFlush", {
    tokenKey,
    pending: Array.from(_pendingManualDisengageTokenKeys)
  });

  if (_manualDisengageFlushTimer) {
    clearTimeout(_manualDisengageFlushTimer);
  }

  _manualDisengageFlushTimer = setTimeout(() => {
    _manualDisengageFlushTimer = null;

    queueEngagementUpdate(async () => {
      await flushPendingManualDisengages(combat);
    });
  }, 75);
}

async function handleActorUnconsciousCleanup(combatant, combat) {
  const tokenDoc = getTokenDocFromCombatant(combatant);
  const tokenKey = getPersistentTokenKey(tokenDoc);

  debugLog("handleActorUnconsciousCleanup", {
    tokenId: tokenDoc?.id,
    tokenKey,
    tokenName: tokenDoc?.name
  });

  if (!tokenKey) return {};
  return await removePairsForTokenKey(combat, tokenKey);
}

async function handleManualEngagedRemovalByToken(tokenDoc, combat) {
  const tokenKey = getPersistentTokenKey(tokenDoc);

  debugLog("handleManualEngagedRemovalByToken", {
    tokenId: tokenDoc?.id,
    tokenKey,
    tokenName: tokenDoc?.name
  });

  if (!tokenKey || !combat) return;

  scheduleManualDisengageFlush(combat, tokenKey);
}

async function handleManualEngagedRemovalByEffect(effect) {
  const combat = getCurrentCombat();
  if (!combat) return;

  const tokenDoc = resolveTokenDocFromEffect(effect, combat);

  debugLog("handleManualEngagedRemovalByEffect", {
    effectUuid: effect?.uuid,
    effectName: effect?.name || effect?.label,
    parentUuid: effect?.parent?.uuid,
    resolvedTokenId: tokenDoc?.id,
    resolvedTokenName: tokenDoc?.name,
    resolvedTokenKey: getPersistentTokenKey(tokenDoc)
  });

  if (!tokenDoc) {
    debugLog("Cannot resolve exact token for manual engaged removal; skipping cleanup", {
      effectUuid: effect?.uuid,
      parentUuid: effect?.parent?.uuid
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

  debugLog("handleRoundChange:start", {
    changed,
    newRound
  });

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

  debugLog("handleRoundChange:previous-round-filter", {
    previousRound,
    loadedPairs: summarizePairs(pairs),
    stillPairs: summarizePairs(stillPairs)
  });

  await commitEngagementState(combat, stillPairs);

  const activeTokenKeys = new Set();
  for (const info of Object.values(stillPairs)) {
    if (info?.aKey) activeTokenKeys.add(info.aKey);
    if (info?.bKey) activeTokenKeys.add(info.bKey);
  }

  debugLog("handleRoundChange:activeTokenKeys", Array.from(activeTokenKeys));

  for (const c of combat.combatants) {
    const tokenDoc = getTokenDocFromCombatant(c);
    const tokenKey = getPersistentTokenKey(tokenDoc);
    const tokenActor = getTokenActorFromCombatant(c);

    if (!tokenDoc?.id || !tokenKey || !tokenActor) continue;

    if (!activeTokenKeys.has(tokenKey)) {
      const tokenName = tokenDoc.name || c.name || tokenActor.name;
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

  debugLog("handleTurnChange:unconscious-cleanup", {
    unconscious: unconsciousCombatants.map((c) => ({
      tokenId: c.token?.id ?? c.tokenId,
      tokenName: c.token?.name || c.name || getTokenActorFromCombatant(c)?.name,
      tokenKey: getPersistentTokenKey(getTokenDocFromCombatant(c))
    }))
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

        debugLog("updateCombat", { changed, combatId: combat.id });

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
        if (!actor?.hasCondition) {
          debugLog("deleteActiveEffect:skip-no-actor-hasCondition", {
            effectUuid: effect?.uuid,
            options,
            userId
          });
          return;
        }

        debugLog("deleteActiveEffect:start", {
          effectUuid: effect?.uuid,
          effectName: effect?.name || effect?.label,
          actorName: actor?.name,
          actorUuid: actor?.uuid,
          options,
          userId,
          suppressedByEffectUuid: _suppressEngagedEffectDeletes.has(effect?.uuid)
        });

        if (_suppressEngagedEffectDeletes.has(effect?.uuid)) {
          debugLog("deleteActiveEffect:skip-suppressed-automatic", { effectUuid: effect?.uuid });
          return;
        }

        if (!effectMatchesCondition(effect, "engaged", "WFRP4E.ConditionName.Engaged")) {
          debugLog("deleteActiveEffect:skip-not-engaged", {
            effectUuid: effect?.uuid,
            effectName: effect?.name || effect?.label
          });
          return;
        }

        if (options?.manual === false || options?.isAuto === true) {
          debugLog("deleteActiveEffect:skip-automatic-options", {
            effectUuid: effect?.uuid,
            options,
            userId
          });
          return;
        }

        await handleManualEngagedRemovalByEffect(effect);

        debugLog("deleteActiveEffect:end-manual-cleanup", {
          actor: actor.name,
          actorUuid: actor.uuid,
          effectUuid: effect?.uuid,
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
        const tokenKey = getPersistentTokenKey(tokenDoc);

        debugLog("createActiveEffect:resolved", {
          effectUuid: effect?.uuid,
          actorName: actor?.name,
          actorUuid: actor?.uuid,
          tokenId: tokenDoc?.id,
          tokenName: tokenDoc?.name,
          tokenKey,
          isUnconscious,
          isDead
        });

        if (!tokenDoc?.id || !tokenKey) {
          debugLog("Cannot resolve exact token for unconscious/dead cleanup; skipping cleanup", {
            actor: actor.name,
            actorUuid: actor.uuid,
            effectUuid: effect?.uuid,
            unconscious: isUnconscious,
            dead: isDead
          });
          return;
        }

        await removePairsForTokenKey(combat, tokenKey);

        debugLog("Engagement cleanup triggered by unconscious/dead", {
          actor: actor.name,
          actorUuid: actor.uuid,
          effectUuid: effect?.uuid,
          tokenId: tokenDoc.id,
          tokenKey,
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