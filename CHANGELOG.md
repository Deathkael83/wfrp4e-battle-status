# Changelog

All notable changes to this module will be documented in this file.  
This project follows Semantic Versioning.

## [Unreleased]
- No changes yet.

## [1.1.0] – Planned

### Added
- Optional handling of additional battle states beyond **Engaged**.
- Per-state settings to enable or disable individual battle state automation.
- Extended localized chat feedback for additional battle states.

### Changed
- Internal refactor to generalize engagement logic into a reusable battle-status framework.
- Improved extensibility for future combat-related state handling.

### Fixed
- Edge cases involving combatants entering or leaving combat mid-round.
- Minor inconsistencies in state cleanup during complex combat flows.

---

## [1.0.0] – Initial Public Release

### Added
- Automatic tracking of melee engagement during combat.
- Application and removal of the **Engaged** condition based on actual melee activity.
- Engagement cleanup when:
  - no melee attacks occur in the previous round
  - a combatant becomes unconscious
  - an engaged opponent becomes unconscious
  - combat ends
- Optional restriction to apply **Engaged** only after combat has started (round 1+).
- Configurable eligibility rules for engagement (both, either, or no combatant requirement).
- GM and Assistant GM whisper chat notifications (configurable).
- Optional debug logging.
- Full localization support (EN, IT, FR, ES, DE, PT-BR).

### Technical
- Clean refactor with separated `main` and `settings` modules.
- Stable module ID and i18n namespace (`wfrp4e-battle-status` / `wfrp4e_battle_status`).
- Modern `module.json` structure aligned with the WFRP4e Zero Wounds schema.
- Explicit and non-redundant combat state guards.
- No hardcoded user-facing strings (i18n-only).

### Notes
- This release supersedes earlier internal and experimental versions.
- **Engaged** is the first supported battle state; the module is designed for future extension.
