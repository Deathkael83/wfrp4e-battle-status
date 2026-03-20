export const MODULE_ID = "wfrp4e-battle-status";

export function registerSettings() {
  
  game.settings.register(MODULE_ID, "enableAutoEngaged", {
    name: game.i18n.localize("wfrp4e_battle_status.Settings.EnableAutoEngaged.Name"),
    hint: game.i18n.localize("wfrp4e_battle_status.Settings.EnableAutoEngaged.Hint"),
    scope: "world",
    config: true,
    default: true,
    type: Boolean
  });

  game.settings.register(MODULE_ID, "requireActiveCombat", {
    name: game.i18n.localize("wfrp4e_battle_status.Settings.RequireActiveCombat.Name"),
    hint: game.i18n.localize("wfrp4e_battle_status.Settings.RequireActiveCombat.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "combatantRequirement", {
    name: game.i18n.localize("wfrp4e_battle_status.Settings.CombatantRequirement.Name"),
    hint: game.i18n.localize("wfrp4e_battle_status.Settings.CombatantRequirement.Hint"),
    scope: "world",
    config: true,
    type: String,
    choices: {
      both: game.i18n.localize("wfrp4e_battle_status.Settings.CombatantRequirement.Choices.Both"),
      either: game.i18n.localize("wfrp4e_battle_status.Settings.CombatantRequirement.Choices.Either"),
      none: game.i18n.localize("wfrp4e_battle_status.Settings.CombatantRequirement.Choices.None")
    },
    default: "both"
  });

  game.settings.register(MODULE_ID, "enableChatMessages", {
    name: game.i18n.localize("wfrp4e_battle_status.Settings.EnableChatMessages.Name"),
    hint: game.i18n.localize("wfrp4e_battle_status.Settings.EnableChatMessages.Hint"),
    scope: "client",
    config: true,
    default: true,
    type: Boolean
  });

  game.settings.register(MODULE_ID, "engagementTooltipVisibility", {
    name: game.i18n.localize("wfrp4e_battle_status.Settings.EngagementTooltipVisibility.Name"),
    hint: game.i18n.localize("wfrp4e_battle_status.Settings.EngagementTooltipVisibility.Hint"),
    scope: "client",
    config: true,
    type: String,
    choices: {
      gm: game.i18n.localize("wfrp4e_battle_status.Settings.EngagementTooltipVisibility.Choices.GM"),
      players: game.i18n.localize("wfrp4e_battle_status.Settings.EngagementTooltipVisibility.Choices.Players")
    },
    default: "gm"
  });

  game.settings.register(MODULE_ID, "showEngagementLines", {
    name: "wfrp4e_battle_status.Settings.ShowEngagementLines.Name",
    hint: "wfrp4e_battle_status.Settings.ShowEngagementLines.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "engagementLineWidth", {
    name: "wfrp4e_battle_status.Settings.EngagementLineWidth.Name",
    hint: "wfrp4e_battle_status.Settings.EngagementLineWidth.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: {
      min: 1,
      max: 10,
      step: 1
    },
    default: 2
  });

  game.settings.register(MODULE_ID, "engagementLineColor", {
    name: "wfrp4e_battle_status.Settings.EngagementLineColor.Name",
    hint: "wfrp4e_battle_status.Settings.EngagementLineColor.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "#c2a96a"
  });

  game.settings.register(MODULE_ID, "engagementLineAlpha", {
    name: "wfrp4e_battle_status.Settings.EngagementLineAlpha.Name",
    hint: "wfrp4e_battle_status.Settings.EngagementLineAlpha.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: {
      min: 0.1,
      max: 1,
      step: 0.1
    },
    default: 0.55
  });

  game.settings.register(MODULE_ID, "engagementLineStyle", {
    name: "wfrp4e_battle_status.Settings.EngagementLineStyle.Name",
    hint: "wfrp4e_battle_status.Settings.EngagementLineStyle.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      solid: "wfrp4e_battle_status.Settings.EngagementLineStyle.Choices.Solid",
      dashed: "wfrp4e_battle_status.Settings.EngagementLineStyle.Choices.Dashed",
      dotted: "wfrp4e_battle_status.Settings.EngagementLineStyle.Choices.Dotted",
      double: "wfrp4e_battle_status.Settings.EngagementLineStyle.Choices.Double"
    },
    default: "dashed"
  });

  game.settings.register(MODULE_ID, "enableDebugLog", {
    name: game.i18n.localize("wfrp4e_battle_status.Settings.EnableDebugLog.Name"),
    hint: game.i18n.localize("wfrp4e_battle_status.Settings.EnableDebugLog.Hint"),
    scope: "client",
    config: true,
    default: false,
    type: Boolean
  });
  
  game.settings.register(MODULE_ID, "enableConditionPenaltyFix", {
    name: game.i18n.localize("wfrp4e_battle_status.Settings.enableConditionPenaltyFix.Name"),
    hint: game.i18n.localize("wfrp4e_battle_status.Settings.enableConditionPenaltyFix.Hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "conditionPenaltyFixDebug", {
    name: game.i18n.localize("wfrp4e_battle_status.Settings.conditionPenaltyFixDebug.Name"),
    hint: game.i18n.localize("wfrp4e_battle_status.Settings.conditionPenaltyFixDebug.Hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
}
