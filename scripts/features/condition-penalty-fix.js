let hookId = null;

export function registerConditionPenaltyFix() {
  if (hookId) {
    Hooks.off("renderRollDialog", hookId);
    hookId = null;
  }

  const ENABLED = game.settings.get("wfrp4e-battle-status", "enableConditionPenaltyFix");
  if (!ENABLED) return;

  const DEBUG = game.settings.get("wfrp4e-battle-status", "conditionPenaltyFixDebug");

  const CONDITION_ALIASES = {
    blinded: ["accecato", "blinded"],
    fatigued: ["affaticato", "fatigued"],
    entangled: ["afferrato", "entangled"],
    deafened: ["assordato", "deafened"],
    broken: ["atterrito", "broken"],
    poisoned: ["avvelenato", "poisoned"],
    prone: ["prono", "prone"],
    stunned: ["stordito", "stunned"]
  };

  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function dbg(...args) {
    if (!DEBUG) return;
    console.log("[WFRP ConditionPenaltyFix]", ...args);
  }

  function dbgGroup(label, payload) {
    if (!DEBUG) return;
    console.groupCollapsed(`[WFRP ConditionPenaltyFix] ${label}`);
    console.log(payload);
    console.groupEnd();
  }

  function decodeHtml(html) {
    const t = document.createElement("textarea");
    t.innerHTML = String(html ?? "");
    return t.value;
  }

  function rowTooltip(row) {
    return norm(row.getAttribute("data-tooltip") || "");
  }

  function rowText(row) {
    return norm(row.innerText || row.textContent || "");
  }

  function rowId(row) {
    return row.dataset.index || `${rowTooltip(row)}|${rowText(row)}`;
  }

  function isActive(row) {
    return row.classList.contains("active");
  }

  function toggleRow(row, reason = "") {
    dbg("toggleRow", {
      reason,
      id: rowId(row),
      text: rowText(row),
      tooltip: rowTooltip(row),
      activeBefore: isActive(row)
    });
    row.click();
  }

  function isTargetRow(row) {
    const t = `${rowText(row)} ${rowTooltip(row)}`;
    return t.includes("target") || t.includes("bersaglio");
  }

  function rowConditionKey(row) {
    const t = `${rowText(row)} ${rowTooltip(row)}`;

    for (const [key, aliases] of Object.entries(CONDITION_ALIASES)) {
      if (aliases.some((a) => t.includes(norm(a)))) return key;
    }

    if (t.includes("movement of any kind") || t.includes("prove legate al movimento")) return "prone";
    if (t.includes("related to sight") || t.includes("vista")) return "blinded";
    if (t.includes("related to hearing") || t.includes("udito")) return "deafened";
    if (t.includes("not involving running and hiding")) return "broken";

    return null;
  }

  function getModifierTooltipText(form) {
    const group = [...form.querySelectorAll(".form-group")].find((g) => {
      const label = norm(g.querySelector("label")?.textContent || "");
      return label.includes("modificatore") || label.includes("modifier");
    });

    const tooltip = decodeHtml(group?.getAttribute("data-tooltip") || "");
    dbg("getModifierTooltipText", tooltip);
    return tooltip;
  }

  function parsePenaltiesFromModifierTooltip(form) {
    const tooltip = getModifierTooltipText(form);

    const patterns = [
      { key: "fatigued", re: /(affaticato|fatigued).*?\((-?\d+)\)/i },
      { key: "stunned", re: /(stordito|stunned).*?\((-?\d+)\)/i },
      { key: "poisoned", re: /(avvelenato|poisoned).*?\((-?\d+)\)/i },
      { key: "broken", re: /(atterrito|broken|not involving running and hiding).*?\((-?\d+)\)/i },
      { key: "prone", re: /(movement of any kind|prove legate al movimento|prono|prone).*?\((-?\d+)\)/i },
      { key: "entangled", re: /(afferrato|entangled).*?\((-?\d+)\)/i },
      { key: "blinded", re: /(related to sight|prove.*vista|accecato|blinded).*?\((-?\d+)\)/i },
      { key: "deafened", re: /(related to hearing|prove.*udito|assordato|deafened).*?\((-?\d+)\)/i }
    ];

    const out = {};

    for (const { key, re } of patterns) {
      const m = tooltip.match(re);
      if (m) out[key] = Number(m[2]);
    }

    dbgGroup("parsePenaltiesFromModifierTooltip", out);
    return out;
  }

  function isWSorACTest(app, form) {
    const debugPrefix = "[isWSorACTest]";

    const debugLog = (...args) => {
      if (!DEBUG) return;
      try {
        console.log(debugPrefix, ...args);
      } catch (_e) {}
    };

    const root = form instanceof HTMLElement
      ? form
      : (app?.element instanceof HTMLElement ? app.element : null);

    if (!root) {
      debugLog("Nessun root html trovato -> false");
      return false;
    }

    const selectors = [
      'select[name="characteristic"]',
      'select[name="skill"]',
      'select[name="testCharacteristic"]',
      'select[name="testSkill"]',
      'select'
    ];

    let selectedText = "";
    let matchedSelector = "";

    for (const sel of selectors) {
      const node = root.querySelector(sel);
      if (!node) continue;

      const opt = node.selectedOptions?.[0] ?? node.querySelector("option:checked");
      const rawText = opt?.textContent || opt?.label || node.value || "";
      const cleaned = norm(rawText);

      debugLog(`Selector provato: ${sel}`, {
        rawText,
        cleaned,
        value: node.value
      });

      if (cleaned) {
        selectedText = cleaned;
        matchedSelector = sel;
        break;
      }
    }

    const selectedIsWS =
      selectedText === "weapon skill" ||
      selectedText === "abilita di combattimento" ||
      selectedText === "ws" ||
      selectedText === "ac";

    debugLog("Risultato controllo select", {
      matchedSelector,
      selectedText,
      selectedIsWS
    });

    let haystack = "";

    try {
      const appElement =
        app?.element instanceof HTMLElement
          ? app.element
          : app?.element?.[0] instanceof HTMLElement
            ? app.element[0]
            : null;

      haystack = norm(
        root.innerText ||
        root.textContent ||
        appElement?.innerText ||
        appElement?.textContent ||
        ""
      );
    } catch (e) {
      debugLog("Errore lettura haystack", e);
    }

    const chargingFound =
      haystack.includes("charging") ||
      haystack.includes("carica");

    //const haystackWSAC =
      //haystack.includes("abilita di combattimento") ||
      //haystack.includes("weapon skill") ||
      //haystack.includes(" ws ") ||
      //haystack.includes("(ws)") ||
      //haystack.includes(" ac ") ||
      //haystack.includes("(ac)");

    debugLog("Charging / WS-AC check (haystack)", {
      chargingFound,
      haystack
    });

    const title = norm(app?.title || "");
    const titleIsWS =
      title.includes("weapon skill") ||
      title.includes("abilita di combattimento") ||
      title.includes(" ws ") ||
      title.includes("(ws)") ||
      title.includes(" ac ") ||
      title.includes("(ac)");

    debugLog("Fallback titolo", {
      title,
      titleIsWS
    });

    const result = selectedIsWS || chargingFound || titleIsWS;

    debugLog("Risultato finale", {
      selectedIsWS,
      chargingFound,
      titleIsWS,
      result
    });

    return result;
  }

  function captureInitialState(form) {
    if (form.dataset.wfrpInitialStateCaptured === "1") {
      dbg("captureInitialState skipped: already captured");
      return;
    }

    const allRows = [...form.querySelectorAll("li.modifier")];

    const initialActiveConditionIds = allRows
      .filter((row) => isActive(row))
      .filter((row) => !isTargetRow(row))
      .filter((row) => !!rowConditionKey(row))
      .map((row) => rowId(row));

    form.dataset.wfrpInitialStateCaptured = "1";
    form.dataset.wfrpInitialActiveConditionIds = JSON.stringify(initialActiveConditionIds);

    dbgGroup("captureInitialState", {
      initialActiveConditionIds,
      activeRows: allRows.map((row) => ({
        id: rowId(row),
        active: isActive(row),
        key: rowConditionKey(row),
        target: isTargetRow(row),
        text: rowText(row),
        tooltip: rowTooltip(row)
      }))
    });
  }

  function getInitialActiveConditionIds(form) {
    try {
      const ids = JSON.parse(form.dataset.wfrpInitialActiveConditionIds || "[]");
      dbg("getInitialActiveConditionIds", ids);
      return ids;
    } catch (e) {
      dbg("getInitialActiveConditionIds parse error", e);
      return [];
    }
  }

  function applyInitialProneAdjustment(app, form) {
    if (!(form instanceof HTMLFormElement)) return false;

    const wsac = isWSorACTest(app, form);
    dbg("applyInitialProneAdjustment start", { wsac });

    if (!wsac) return false;

    let changed = false;
    const rows = [...form.querySelectorAll("li.modifier")];

    for (const row of rows) {
      if (isTargetRow(row)) continue;
      if (rowConditionKey(row) === "prone" && isActive(row)) {
        toggleRow(row, "initial-prone-adjustment");
        changed = true;
      }
    }

    dbgGroup("applyInitialProneAdjustment end", rows.map((row) => ({
      id: rowId(row),
      key: rowConditionKey(row),
      active: isActive(row),
      text: rowText(row),
      tooltip: rowTooltip(row)
    })));

    return changed;
  }

function getCurrentEligibleNegativeConditionRows(form, mode = "initial") {
  const penalties = parsePenaltiesFromModifierTooltip(form);
  const allRows = [...form.querySelectorAll("li.modifier")];
  const initialActiveConditionIds = getInitialActiveConditionIds(form);

  const result = allRows
    .filter((row) => !isTargetRow(row))
    .map((row) => {
      const key = rowConditionKey(row);
      if (!key) return null;

      const id = rowId(row);
      const wasInitiallyActive = initialActiveConditionIds.includes(id);
      const isCurrentlyActive = isActive(row);

      let eligible = false;

      if (mode === "initial") {
        eligible = wasInitiallyActive;
      } else {
        eligible = isCurrentlyActive;
      }

      if (!eligible) return null;

      const value = penalties[key];
      if (!(typeof value === "number" && value < 0)) return null;

      return {
        row,
        id,
        key,
        value,
        wasInitiallyActive,
        isCurrentlyActive,
        text: rowText(row),
        tooltip: rowTooltip(row)
      };
    })
    .filter(Boolean);

  dbgGroup(`getCurrentEligibleNegativeConditionRows [${mode}]`, result.map((x) => ({
    id: x.id,
    key: x.key,
    value: x.value,
    wasInitiallyActive: x.wasInitiallyActive,
    isCurrentlyActive: x.isCurrentlyActive,
    text: x.text,
    tooltip: x.tooltip
  })));

  return result;
}

function normalizeConditions(form, mode = "current") {
  if (!(form instanceof HTMLFormElement)) return;
  if (form.dataset.wfrpCondFixRunning === "1") {
    dbg("normalizeConditions skipped: already running", { mode });
    return;
  }

  form.dataset.wfrpCondFixRunning = "1";
  dbg("normalizeConditions start", { mode });

  try {
    const eligibleNegativeRows = getCurrentEligibleNegativeConditionRows(form, mode)
      .filter((item) => isActive(item.row));

    dbgGroup(`normalizeConditions active eligible negatives [${mode}]`, eligibleNegativeRows.map((x) => ({
      id: x.id,
      key: x.key,
      value: x.value,
      active: isActive(x.row),
      text: x.text
    })));

    if (eligibleNegativeRows.length <= 1) {
      dbg("normalizeConditions end: nothing to normalize", { mode });
      return;
    }

    eligibleNegativeRows.sort((a, b) => a.value - b.value);
    const keep = eligibleNegativeRows[0].row;

    dbg("normalizeConditions keep", {
      mode,
      id: rowId(keep),
      key: rowConditionKey(keep),
      text: rowText(keep),
      tooltip: rowTooltip(keep)
    });

    for (const item of eligibleNegativeRows) {
      if (item.row !== keep && isActive(item.row)) {
        toggleRow(item.row, `normalize-keep-worst-only [${mode}]`);
      }
    }
  } finally {
    setTimeout(() => {
      delete form.dataset.wfrpCondFixRunning;
      dbg("normalizeConditions unlock", { mode });
    }, 60);
  }
}

function attachListeners(form) {
  if (form.dataset.wfrpCondFixListenersAttached === "1") return;
  form.dataset.wfrpCondFixListenersAttached = "1";

  form.addEventListener("click", (event) => {
    const row = event.target.closest("li.modifier");
    if (!row) return;

    if (isTargetRow(row)) return;
    if (!rowConditionKey(row)) return;

    dbg("delegated row click listener", {
      id: rowId(row),
      key: rowConditionKey(row),
      activeAtClick: isActive(row),
      text: rowText(row),
      tooltip: rowTooltip(row)
    });

    // Dopo i click utente si usa SEMPRE la logica corrente
    setTimeout(() => normalizeConditions(form, "current"), 80);
    setTimeout(() => normalizeConditions(form, "current"), 180);
  });

  dbg("attachListeners done (delegated)");
}

async function initializeDialog(app, form) {
  if (!(form instanceof HTMLFormElement)) return;
  if (form.dataset.wfrpCondFixInitialized === "1") return;

  form.dataset.wfrpCondFixInitialized = "1";

  // 1. Eccezione iniziale UNA SOLA VOLTA
  const proneChanged = applyInitialProneAdjustment(app, form);

  // 2. Aspetta che il dialog si aggiorni davvero
  await wait(proneChanged ? 220 : 80);

  // 3. Solo ora fissa lo stato iniziale corretto
  captureInitialState(form);

  // 4. Primo check della peggiore
  normalizeConditions(form);

  await wait(180);
  normalizeConditions(form);

  // 5. SOLO ADESSO attacca i listener utente
  attachListeners(form);
}

  hookId = Hooks.on("renderRollDialog", (app, form) => {
    dbg("renderRollDialog hook fired", { title: app?.title || "", form });
    initializeDialog(app, form);
  });
}

export function unregisterConditionPenaltyFix() {
  if (hookId) {
    Hooks.off("renderRollDialog", hookId);
    hookId = null;
  }
}