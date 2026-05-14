// EchoReply sidebar runtime.
//
// Imported from content.js via dynamic import(chrome.runtime.getURL(...))
// so it runs in the content-script ISOLATED world (chrome.* APIs available).
//
// Responsibilities:
//   - Listen for opened emails (gmailParser)
//   - Run the decoder prompt → render the 3 analysis cards
//   - Lazily generate the 3 draft styles on user demand
//   - Tone-check the user's own draft
//   - Surface inline error states with retry/open-settings actions
//   - Cache decoder/draft results per email id in chrome.storage.local
//   - Persist sidebar collapsed state across sessions

import {
  onEmailOpened,
  threadHasMultipleRecipients,
  isInSentFolder,
  findListRows,
  findBackToListButton,
  extractCurrentEmail,
} from "../lib/gmailParser.js";
import { callAI, callAIStream, callAIChatStream } from "../lib/aiProvider.js";
import {
  decoderPrompt,
  draftPrompt,
  refineDraftPrompt,
  styleCoachPrompt,
  styleDiagnosisPrompt,
  toneCheckPrompt,
  extractSignatureFromSamples,
} from "../lib/prompts.js";
import { insertDraftIntoCompose } from "../lib/insertDraft.js";
import { applyI18nTo, initI18n, t } from "../lib/i18n.js";
import { detectAccountFromUrl, acctGet, acctSet, acctRemove } from "../lib/accountStorage.js";

// Module-scoped state. Kept small and explicit.
//
// The draft area is a single pane fed by `state.activeStyle`. Each style
// carries its own variants + status, so one style can stream in the
// background while another is on screen.
const state = {
  email: null,        // current email object {id, sender, subject, body, ...}
  decoder: null,      // last decoder result (parsed JSON)
  variants: {},       // { [style]: { active: 0, list: [{draft, history}, ...] } }
  activeStyle: "professional", // which style tab is showing in the pane
  draftStatus: {},    // { [style]: "idle"|"loading"|"streaming"|"ready"|"error" }
  streamBuffers: {},  // { [style]: partial text during streaming }
  streamTokens: {},   // { [style]: Symbol — detects superseded generations }
  draftErrors: {},    // { [style]: error code when status === "error" }
  collapsed: false,   // sidebar visibility
  account: "0",       // Gmail account index (from /mail/u/N/)
  replySuppressed: false, // true when DONT_REPLY / automated — draft UI collapsed
};

const MAX_VARIANTS = 2;

function getVariants(style) {
  return state.variants[style] || { active: 0, list: [] };
}

function setVariants(style, v) {
  state.variants[style] = v;
}

function getActiveDraft(style) {
  const v = getVariants(style);
  return v.list[v.active]?.draft || "";
}

function getActiveHistory(style) {
  const v = getVariants(style);
  return v.list[v.active]?.history || [];
}

function writeActiveDraft(style, draft, history) {
  const v = getVariants(style);
  if (!v.list.length) v.list.push({ draft: "", history: [] });
  v.list[v.active] = { draft, history: history || [] };
  setVariants(style, v);
}

// Snapshot of just the texts, for storage caching.
function variantSnapshot() {
  const out = {};
  for (const style of DRAFT_STYLES) {
    const v = state.variants[style];
    if (v && v.list.length) {
      out[style] = { active: v.active, list: v.list.map((x) => ({ draft: x.draft })) };
    }
  }
  return out;
}

const DRAFT_STYLES = ["professional", "warm", "confident"];

// ----- Per-email cache helpers -----
//
// We cache decoder + draft results in chrome.storage.local under
// emailCache_<emailId> so re-opening the same email is instant and free.
// Cache entries expire after 24h to avoid stale results piling up forever.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheKey(emailId) {
  return `emailCache_${emailId}`;
}

async function loadCache(emailId) {
  if (!emailId) return null;
  const key = cacheKey(emailId);
  const data = await acctGet(state.account, key);
  const entry = data[key];
  if (!entry) return null;
  if (Date.now() - (entry.savedAt || 0) > CACHE_TTL_MS) {
    acctRemove(state.account, key);
    return null;
  }
  return entry;
}

async function saveCache(emailId, patch) {
  if (!emailId) return;
  const key = cacheKey(emailId);
  const data = await acctGet(state.account, key);
  const next = {
    ...(data[key] || {}),
    ...patch,
    savedAt: Date.now(),
  };
  await acctSet(state.account, { [key]: next });
}

let els = null;

export async function init() {
  const shell = document.getElementById("er-shell");
  if (!shell) {
    console.warn("[EchoReply] sidebar shell missing, aborting init");
    return;
  }

  // Load the chosen UI locale (or auto), then translate all static markup.
  await initI18n();
  applyI18nTo(document.getElementById("echoreply-sidebar-root") || document);

  // Detect Gmail account from URL and broadcast it so Options can show
  // the right account's data without guessing.
  state.account = detectAccountFromUrl();
  chrome.storage.local.set({ lastActiveAccount: state.account });

  els = collectEls();
  bindHeader();
  bindDrafts();
  bindToneCheck();
  bindStyleSamples();
  bindShortcuts();
  bindLiveCoach();
  await restoreCollapsedState();
  await applyInitialState();
  refreshUsageDisplay();
  syncLanguageSelectors();

  // Keep language pickers in sync if user changes the language elsewhere.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.replyLanguage) syncLanguageSelectors();
  });

  // Watch for email opens.
  onEmailOpened(handleEmailOpened);
}

function collectEls() {
  return {
    shell: document.getElementById("er-shell"),
    footerText: document.getElementById("er-footer-text"),

    // Header
    settingsBtn: document.getElementById("er-settings-btn"),
    collapseBtn: document.getElementById("er-collapse-btn"),
    collapsedPill: document.getElementById("er-collapsed-pill"),

    // No-key state
    openSettings: document.getElementById("er-open-settings"),

    // Decoder cards
    intentBody: document.getElementById("er-intent-body"),
    tempPill: document.getElementById("er-temp-pill"),
    tempNote: document.getElementById("er-temp-note"),
    strategyPill: document.getElementById("er-strategy-pill"),
    strategyAdvice: document.getElementById("er-strategy-advice"),
    clarifyCard: document.getElementById("er-clarify-card"),
    clarifyList: document.getElementById("er-clarify-list"),
    actionsCard: document.getElementById("er-actions-card"),
    actionsList: document.getElementById("er-actions-list"),
    threadBadge: document.getElementById("er-thread-badge"),
    ccBadge: document.getElementById("er-cc-badge"),
    recallBadge: document.getElementById("er-recall-badge"),
    threadSummaryCard: document.getElementById("er-thread-summary-card"),
    threadSummaryBody: document.getElementById("er-thread-summary-body"),

    // Decoder error
    decoderError: document.getElementById("er-decoder-error"),
    decoderErrorText: document.getElementById("er-decoder-error-text"),
    decoderRetry: document.getElementById("er-decoder-retry"),

    // Tone check (collapsible)
    toneInput: document.getElementById("er-tone-input"),
    toneCheckBtn: document.getElementById("er-tone-check-btn"),
    toneResult: document.getElementById("er-tone-result"),
    toneSection: document.getElementById("er-tone-section"),
    toneToggle: document.getElementById("er-tone-toggle"),

    // Reply-All toggle
    replyAllWrap: document.getElementById("er-reply-all-wrap"),
    replyAll: document.getElementById("er-reply-all"),

    // Drafts section + no-reply suppression
    draftsSection: document.getElementById("er-drafts-section"),
    noReplyNotice: document.getElementById("er-no-reply-notice"),
    noReplyText: document.getElementById("er-no-reply-text"),
    draftAnyway: document.getElementById("er-draft-anyway"),
    styleTabs: document.getElementById("er-style-tabs"),
    draftPane: document.getElementById("er-draft-pane"),

    // Footer usage counter
    usageText: document.getElementById("er-footer-usage"),

    // Cheat-sheet overlay
    cheatsheet: document.getElementById("er-cheatsheet"),

    // Live Coach (standalone result strip — no permanent section)
    coachResult: document.getElementById("er-coach-result"),

    // Style-sample banner
    styleBanner: document.getElementById("er-style-banner"),
    saveSampleBtn: document.getElementById("er-save-sample"),
    styleCount: document.getElementById("er-style-count"),
    autoScanBtn: document.getElementById("er-autoscan-btn"),
    autoScanProgress: document.getElementById("er-autoscan-progress"),
    autoScanText: document.getElementById("er-autoscan-text"),
    autoScanBar: document.getElementById("er-autoscan-bar"),
    autoScanCancel: document.getElementById("er-autoscan-cancel"),
  };
}

// ----- Header controls -----

function bindHeader() {
  els.settingsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  els.openSettings.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  els.collapseBtn.addEventListener("click", () => setCollapsed(true));
  els.collapsedPill.addEventListener("click", () => setCollapsed(false));

  // The decoder Retry button's action is rebound per error inside
  // renderDecoderError() — but wire a default Retry handler too so it works
  // even if invoked before the first error.
  els.decoderRetry.addEventListener("click", () => {
    if (state.email) runDecoder(state.email);
  });

  // Update the footer label based on selected provider so users know what's
  // powering their replies.
  chrome.storage.local.get("provider", ({ provider }) => {
    els.footerText.textContent =
      provider === "openai" ? t("poweredByOpenAI") : t("poweredByClaude");
  });

  // React if provider changes while the sidebar is open.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.provider) {
      els.footerText.textContent =
        changes.provider.newValue === "openai"
          ? t("poweredByOpenAI")
          : t("poweredByClaude");
    }
    if (changes.apiKey) {
      const newKey = changes.apiKey.newValue;
      if (!newKey) {
        // Key was removed while sidebar was open — bounce back to the
        // friendly no-key state.
        setShellState("no-key");
      } else if (state.email && !state.decoder) {
        // Key just appeared and we have a pending email — kick off decoder.
        setShellState("ready");
        runDecoder(state.email);
      } else if (!state.email) {
        // Key just appeared, no email open yet — show "Open an email" hint
        // instead of leaving the user stuck in the no-key state.
        setShellState("empty");
      }
    }
    if (changes.uiLanguage) {
      // User switched the interface language in Options — reload the locale
      // and re-translate all static markup. Already-rendered dynamic text
      // picks up the new language on its next render.
      reapplyUiLanguage();
    }
  });
}

async function reapplyUiLanguage() {
  await initI18n();
  applyI18nTo(document.getElementById("echoreply-sidebar-root") || document);
  // Refresh dynamic header/footer bits that aren't tagged with data-i18n.
  const { provider } = await chrome.storage.local.get("provider");
  els.footerText.textContent =
    provider === "openai" ? t("poweredByOpenAI") : t("poweredByClaude");
  refreshUsageDisplay();
}

async function restoreCollapsedState() {
  const { sidebarCollapsed } = await chrome.storage.local.get("sidebarCollapsed");
  if (sidebarCollapsed) setCollapsed(true, { persist: false });
}

function setCollapsed(collapsed, { persist = true } = {}) {
  state.collapsed = collapsed;
  els.shell.setAttribute("data-collapsed", collapsed ? "true" : "false");
  els.collapsedPill.hidden = !collapsed;
  if (persist) chrome.storage.local.set({ sidebarCollapsed: collapsed });
}

// ----- State machine -----
// data-state on .er-shell drives which top-level view shows:
//   empty   → "Open an email"
//   no-key  → "Set your API key"
//   ready   → cards + drafts + tone visible

function setShellState(name) {
  els.shell.setAttribute("data-state", name);
}

async function applyInitialState() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) {
    setShellState("no-key");
  } else {
    setShellState("empty");
  }
}

// ----- Email open handler -----

async function handleEmailOpened(email) {
  state.email = email;
  state.decoder = null;
  state.variants = {};
  state.activeStyle = "professional";
  // Reset reply suppression — the new email's decoder result decides it.
  // Default to NOT suppressed so the UI doesn't flicker collapsed.
  applyReplySuppression(false);

  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) {
    setShellState("no-key");
    return;
  }

  // Auto-pop the sidebar back open when the user opens an email. Users
  // usually collapse the sidebar for inbox browsing, then expect it to
  // surface again when they actually need it.
  if (state.collapsed) setCollapsed(false);

  setShellState("ready");
  hideDecoderError();
  resetDraftPane();
  resetToneCheck();
  updateThreadBadge(email);
  updateCcBadge(email);
  if (els.recallBadge) {
    els.recallBadge.hidden = true;
    els.recallBadge.textContent = "";
  }
  updateReplyAllVisibility();
  updateStyleBannerVisibility();
  // Hide clarify + thread summary from previous email until new decoder
  // result arrives.
  els.clarifyCard.hidden = true;
  els.clarifyList.innerHTML = "";
  els.threadSummaryCard.hidden = true;
  els.threadSummaryBody.textContent = "";
  if (els.actionsCard) {
    els.actionsCard.hidden = true;
    els.actionsList.innerHTML = "";
  }

  // Try the cache first. If we have a decoder result already, paint it
  // instantly and skip the network round-trip.
  const cached = await loadCache(email.id);
  if (cached?.decoder) {
    state.decoder = cached.decoder;
    renderDecoder(cached.decoder);
  } else {
    showDecoderSkeleton();
  }

  // Restore variants from cache. Histories aren't persisted — the first
  // refine after a reopen will seed from the cached active draft. Styles
  // with restored content are marked "ready" so the pane shows them
  // instantly instead of re-generating.
  if (cached?.variants) {
    for (const style of DRAFT_STYLES) {
      const cv = cached.variants[style];
      if (!cv?.list?.length) continue;
      state.variants[style] = {
        active: typeof cv.active === "number" ? cv.active : 0,
        list: cv.list.map((x) => ({ draft: x.draft || "", history: [] })),
      };
      if (getActiveDraft(style)) state.draftStatus[style] = "ready";
    }
  } else if (cached?.drafts) {
    // Back-compat with the pre-variants cache format.
    for (const style of DRAFT_STYLES) {
      if (typeof cached.drafts[style] === "string" && cached.drafts[style]) {
        state.variants[style] = {
          active: 0,
          list: [{ draft: cached.drafts[style], history: [] }],
        };
        state.draftStatus[style] = "ready";
      }
    }
  }

  if (!state.decoder) {
    runDecoder(email);
  } else {
    // Decoder result came from cache — autoGenerateDefaultDraft wouldn't have
    // been triggered, so fire it here.
    autoGenerateDefaultDraft();
  }
}

// ----- Decoder -----

async function runDecoder(email) {
  showDecoderSkeleton();
  hideDecoderError();

  try {
    const result = await callAI(decoderPrompt(email), true);
    bumpUsage().then(refreshUsageDisplay);
    bumpStat("decoder");
    state.decoder = result;
    renderDecoder(result);
    saveCache(email.id, { decoder: result });

    // After the decoder finishes, kick off the user's preferred draft so it
    // streams in by the time they look at it. This is the highest-ROI UX
    // improvement: drafts are pre-warmed instead of waiting on a second click.
    autoGenerateDefaultDraft();
  } catch (err) {
    renderDecoderError(err.message || String(err));
  }
}

async function autoGenerateDefaultDraft() {
  if (!state.email) return;
  // No auto-draft when the reply UI is suppressed (DONT_REPLY / automated).
  if (state.replySuppressed) return;

  const { defaultStyle, autoDraft } = await chrome.storage.local.get([
    "defaultStyle",
    "autoDraft",
  ]);

  // Prefer a sender-specific style if we've learned one previously. Falls
  // back to the user's globally configured default.
  const remembered = await recalledSenderStyle(state.email?.sender);
  const style = remembered
    ? remembered
    : DRAFT_STYLES.includes(defaultStyle)
    ? defaultStyle
    : "professional";

  // Show a small "learned" badge so the user knows why a specific style
  // auto-selected (vs. the global default).
  if (remembered && els.recallBadge) {
    els.recallBadge.hidden = false;
    els.recallBadge.textContent = t("recallBadge", [t(`style${capitalize(style)}`)]);
    els.recallBadge.title = t("recallTooltip", [t(`style${capitalize(style)}`)]);
  }

  // Select the tab. Generate it now unless the user disabled auto-draft —
  // in that case we just show the empty hint and wait for a tab click.
  // If the draft is already cached (re-opened email), renderPaneForStyle
  // paints it from "ready" status without re-calling the API.
  const generate = autoDraft !== false;
  setActiveStyle(style, { generate });
}

function showDecoderSkeleton() {
  els.intentBody.innerHTML = `
    <div class="er-skeleton er-skeleton-line"></div>
    <div class="er-skeleton er-skeleton-line short"></div>
  `;

  els.tempPill.removeAttribute("data-temp");
  els.tempPill.textContent = "—";
  els.tempNote.innerHTML = `<div class="er-skeleton er-skeleton-line"></div>`;

  els.strategyPill.removeAttribute("data-strategy");
  els.strategyPill.textContent = "—";
  els.strategyAdvice.innerHTML = `<div class="er-skeleton er-skeleton-line"></div>`;
}

function renderDecoder(result) {
  els.intentBody.textContent = result.realIntent || "(no intent)";

  const temp = (result.temperature || "NEUTRAL").toUpperCase();
  els.tempPill.setAttribute("data-temp", temp);
  els.tempPill.textContent = temp;
  // Temperature note is surfaced as the pill's tooltip (no separate line).
  els.tempNote.textContent = result.temperatureNote || "";
  els.tempPill.title = result.temperatureNote || "";

  const strategy = (result.replyStrategy || "OPTIONAL").toUpperCase();
  els.strategyPill.setAttribute("data-strategy", strategy);
  els.strategyPill.textContent = strategy.replace(/_/g, " ");
  els.strategyAdvice.textContent = result.strategyAdvice || "";

  // Thread summary card — shown only for multi-message threads when the
  // decoder returned a `threadSummary`. Renders above the analysis cards.
  if (result.threadSummary && state.email?.isThread) {
    els.threadSummaryCard.hidden = false;
    els.threadSummaryBody.textContent = result.threadSummary;
  } else {
    els.threadSummaryCard.hidden = true;
    els.threadSummaryBody.textContent = "";
  }

  // 4th card: only render if the model returned items. Empty arrays hide it.
  const clarify = Array.isArray(result.clarifyBeforeReplying)
    ? result.clarifyBeforeReplying.filter((s) => typeof s === "string" && s.trim())
    : [];
  if (clarify.length) {
    els.clarifyCard.hidden = false;
    els.clarifyList.innerHTML = "";
    for (const item of clarify) {
      const li = document.createElement("li");
      li.textContent = item;
      els.clarifyList.appendChild(li);
    }
  } else {
    els.clarifyCard.hidden = true;
    els.clarifyList.innerHTML = "";
  }

  renderActionItems(Array.isArray(result.actionItems) ? result.actionItems : []);

  // Decide whether to collapse the reply machinery. Two triggers:
  //   - the model said DONT_REPLY
  //   - the sender is an automated / no-reply address
  // Either way, we don't auto-generate a draft and we show a calm notice
  // instead of three draft cards. The user can still opt in via "Draft anyway".
  const dontReply = strategy === "DONT_REPLY";
  const automated = state.email?.isAutomated === true;
  applyReplySuppression(dontReply || automated, { dontReply, automated });
}

// Toggle the "no reply needed" collapsed state for the drafts + tone sections.
function applyReplySuppression(suppress, { dontReply = false, automated = false } = {}) {
  state.replySuppressed = suppress;

  if (els.draftsSection) {
    els.draftsSection.setAttribute("data-suppressed", suppress ? "true" : "false");
  }
  if (els.noReplyNotice) els.noReplyNotice.hidden = !suppress;
  // Tone Check is only relevant when you're actually writing a reply.
  if (els.toneSection) els.toneSection.hidden = suppress;

  if (suppress && els.noReplyText) {
    // Tailor the message to the reason.
    els.noReplyText.textContent = automated && !dontReply
      ? t("noReplyAutomated")
      : t("noReplyNeeded");
  }
}

// "Draft anyway" — user overrides the suppression for this email.
function unsuppressReply() {
  applyReplySuppression(false);
  // Kick off the default draft now that the user has opted in.
  autoGenerateDefaultDraft();
}

// Renders the Action Items card. Each item is either:
//   - "task": copy-to-clipboard button, formatted like a todo line
//   - "event": "Add to Calendar" button → opens Google Calendar event creator
//     pre-filled with title + date (when available)
//   - "deadline": "Add to Calendar" as an all-day event on the deadline date
function renderActionItems(items) {
  if (!els.actionsCard) return;
  const clean = items.filter((it) => it && typeof it.text === "string" && it.text.trim());
  if (!clean.length) {
    els.actionsCard.hidden = true;
    els.actionsList.innerHTML = "";
    return;
  }
  els.actionsCard.hidden = false;
  els.actionsList.innerHTML = "";

  for (const item of clean) {
    els.actionsList.appendChild(renderActionItem(item));
  }
}

function renderActionItem(item) {
  const li = document.createElement("li");
  li.className = "er-action-item";

  const type = (item.type || "task").toLowerCase();
  const icon = document.createElement("span");
  icon.className = "er-action-icon";
  icon.setAttribute("data-type", type);
  icon.textContent = type === "event" ? "📅" : type === "deadline" ? "⏰" : "•";
  li.appendChild(icon);

  const textWrap = document.createElement("div");
  textWrap.className = "er-action-text";
  textWrap.textContent = item.text;
  if (item.date) {
    const dateLine = document.createElement("span");
    dateLine.className = "er-action-date";
    dateLine.textContent = formatDateForDisplay(item.date);
    textWrap.appendChild(dateLine);
  }
  li.appendChild(textWrap);

  const actions = document.createElement("div");
  actions.className = "er-action-actions";

  if (type === "event" || type === "deadline") {
    const calBtn = document.createElement("button");
    calBtn.type = "button";
    calBtn.className = "er-action-btn";
    calBtn.textContent = t("actionAddToCalendar");
    calBtn.addEventListener("click", () => openCalendarFor(item));
    actions.appendChild(calBtn);
  }

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "er-action-btn";
  copyBtn.textContent = t("actionCopy");
  copyBtn.addEventListener("click", async () => {
    const line = item.date ? `${item.text} — ${item.date}` : item.text;
    try {
      await navigator.clipboard.writeText(line);
      flashButton(copyBtn, t("copied"));
    } catch {
      flashButton(copyBtn, t("copyFailed"));
    }
  });
  actions.appendChild(copyBtn);

  li.appendChild(actions);
  return li;
}

// Best-effort date formatter — shows what the model gave us if we can't parse.
function formatDateForDisplay(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return String(raw);
  const hasTime = /T\d|\s\d{1,2}:\d{2}/.test(String(raw));
  if (hasTime) {
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Builds and opens a Google Calendar "create event" URL pre-filled with the
// action item's title + date. For deadlines, we create an all-day event on
// that date. For events with an explicit time, we use a 1-hour block.
function openCalendarFor(item) {
  const title = (item.title || item.text || "").trim();
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
  });

  // dates= YYYYMMDD/YYYYMMDD  (all-day) or YYYYMMDDTHHmmss/YYYYMMDDTHHmmss (timed)
  if (item.date) {
    const d = new Date(item.date);
    if (!isNaN(d.getTime())) {
      const hasTime = /T\d|\s\d{1,2}:\d{2}/.test(String(item.date));
      if (hasTime) {
        const end = new Date(d.getTime() + 60 * 60 * 1000); // 1h block
        params.set("dates", `${gcalStamp(d, true)}/${gcalStamp(end, true)}`);
      } else {
        // All-day event. End is exclusive, so set to next day.
        const end = new Date(d.getTime() + 24 * 60 * 60 * 1000);
        params.set("dates", `${gcalStamp(d, false)}/${gcalStamp(end, false)}`);
      }
    }
  }

  if (state.email?.subject) {
    params.set("details", `From email: ${state.email.subject}\n\n${item.text || ""}`);
  }

  const url = `https://calendar.google.com/calendar/render?${params.toString()}`;
  window.open(url, "_blank", "noopener");
}

function gcalStamp(d, withTime) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  if (!withTime) return `${y}${m}${day}`;
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${y}${m}${day}T${hh}${mm}00`;
}

function renderDecoderError(code) {
  // Special-case: missing key flips the whole sidebar to the no-key state.
  if (code === "NO_API_KEY") {
    setShellState("no-key");
    return;
  }

  els.decoderError.hidden = false;
  els.decoderErrorText.textContent = humanizeError(code);

  // Swap retry button label/handler depending on the error.
  els.decoderRetry.textContent = t("actionRetry");
  els.decoderRetry.onclick = () => {
    if (state.email) runDecoder(state.email);
  };

  // Clear out skeletons so they don't keep shimmering behind the error block.
  els.intentBody.textContent = "—";
  els.tempPill.textContent = "—";
  els.tempPill.removeAttribute("data-temp");
  els.tempNote.textContent = "";
  els.strategyPill.textContent = "—";
  els.strategyPill.removeAttribute("data-strategy");
  els.strategyAdvice.textContent = "";
}

function hideDecoderError() {
  els.decoderError.hidden = true;
}

function updateThreadBadge(email) {
  if (email?.isThread && Array.isArray(email.threadMessages)) {
    els.threadBadge.hidden = false;
    els.threadBadge.textContent = `${email.threadMessages.length} MSG`;
  } else {
    els.threadBadge.hidden = true;
    els.threadBadge.textContent = "";
  }
}

function updateCcBadge(email) {
  if (!els.ccBadge) return;
  els.ccBadge.hidden = email?.recipientRole !== "cc";
}

function updateReplyAllVisibility() {
  // Show Reply-All toggle only when the open email has multiple recipients.
  // Conservative default: unchecked; user opts in.
  if (!els.replyAllWrap) return;
  const show = threadHasMultipleRecipients();
  els.replyAllWrap.hidden = !show;
  if (!show) els.replyAll.checked = false;
}

// ----- Usage counter -----
//
// We track today's API-call count in chrome.storage.local under
// `usage_<YYYY-MM-DD>`. The number isn't a billing-grade counter — just a
// rough nudge so users don't accidentally spend $5/day.

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function bumpUsage() {
  const key = `usage_${today()}`;
  const data = await chrome.storage.local.get(key);
  const next = (data[key] || 0) + 1;
  await chrome.storage.local.set({ [key]: next });
  return next;
}

// Draft history: log every Insert with metadata so the user can browse what
// they've sent and re-use phrasing later. Per-account, capped at 50 entries.

const DRAFT_HISTORY_MAX = 50;

async function appendDraftHistory(entry) {
  if (!entry?.text) return;
  const acct = await acctGet(state.account, ["draftLog"]);
  const list = Array.isArray(acct.draftLog) ? acct.draftLog : [];
  const next = [...list, entry].slice(-DRAFT_HISTORY_MAX);
  await acctSet(state.account, { draftLog: next });
}

// Per-sender style memory: remembers which draft style the user actually
// inserted for past emails from this sender. Next time they open an email
// from the same sender, we auto-open that style instead of the global
// defaultStyle. Stored per-account in `senderStyles: { email: style }`.

async function rememberSenderStyle(senderEmail, style) {
  if (!senderEmail || !DRAFT_STYLES.includes(style)) return;
  const acct = await acctGet(state.account, ["senderStyles"]);
  const map = acct.senderStyles && typeof acct.senderStyles === "object" ? { ...acct.senderStyles } : {};
  map[senderEmail.toLowerCase()] = style;
  // Cap at 200 entries — drop the oldest by re-creating the object in
  // insertion order with only the most recent 200 keys.
  const keys = Object.keys(map);
  if (keys.length > 200) {
    const trimmed = {};
    for (const k of keys.slice(-200)) trimmed[k] = map[k];
    await acctSet(state.account, { senderStyles: trimmed });
    return;
  }
  await acctSet(state.account, { senderStyles: map });
}

async function recalledSenderStyle(senderEmail) {
  if (!senderEmail) return null;
  const acct = await acctGet(state.account, ["senderStyles"]);
  const map = acct.senderStyles && typeof acct.senderStyles === "object" ? acct.senderStyles : {};
  const v = map[senderEmail.toLowerCase()];
  return DRAFT_STYLES.includes(v) ? v : null;
}

// Detailed per-day stats: counts per category + per-style draft counts.
// Stored under `stats` as an object keyed by YYYY-MM-DD. Aged out at 90 days
// in pruneStats() to bound storage.
async function bumpStat(category, sub) {
  const day = today();
  const { stats } = await chrome.storage.local.get("stats");
  const all = stats && typeof stats === "object" ? { ...stats } : {};
  const today_ = { decoder: 0, drafts: 0, refines: 0, tones: 0, inserts: 0, byStyle: {}, ...(all[day] || {}) };
  if (category === "drafts" && sub) {
    today_.drafts = (today_.drafts || 0) + 1;
    today_.byStyle = { ...(today_.byStyle || {}) };
    today_.byStyle[sub] = (today_.byStyle[sub] || 0) + 1;
  } else if (category in today_) {
    today_[category] = (today_[category] || 0) + 1;
  }
  all[day] = today_;
  pruneStats(all);
  await chrome.storage.local.set({ stats: all });
}

// Drop entries older than 90 days. Mutates in place.
function pruneStats(all) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const day of Object.keys(all)) {
    if (day < cutoffStr) delete all[day];
  }
}

async function refreshUsageDisplay() {
  if (!els.usageText) return;
  const key = `usage_${today()}`;
  const data = await chrome.storage.local.get(key);
  const n = data[key] || 0;
  els.usageText.textContent = t(n === 1 ? "usageCalls" : "usageCallsPlural", [String(n)]);
}

// ----- Style samples -----
//
// Style samples are pieces of the user's own previous emails — when present,
// they get folded into the draft prompt as few-shot examples so generated
// replies match the user's habitual voice. Stored in chrome.storage.local
// under `styleSamples` (array of strings, capped to 10, FIFO).

const STYLE_SAMPLES_MAX = 10;

async function loadStyleSamples() {
  const acct = await acctGet(state.account, ["styleSamples"]);
  const { styleSamplesEnabled } = await chrome.storage.local.get("styleSamplesEnabled");
  const enabled = styleSamplesEnabled !== false;
  return enabled && Array.isArray(acct.styleSamples) ? acct.styleSamples : [];
}

async function loadStyleContext() {
  const acct = await acctGet(state.account, ["styleSamples", "signature"]);
  const { styleSamplesEnabled, signatureEnabled, replyLanguage } =
    await chrome.storage.local.get([
      "styleSamplesEnabled",
      "signatureEnabled",
      "replyLanguage",
    ]);
  const samplesEnabled = styleSamplesEnabled !== false;
  const sigEnabled = signatureEnabled !== false;
  return {
    styleSamples: samplesEnabled && Array.isArray(acct.styleSamples) ? acct.styleSamples : [],
    signature:
      sigEnabled && typeof acct.signature === "string" && acct.signature.trim()
        ? acct.signature
        : null,
    language: typeof replyLanguage === "string" ? replyLanguage : "auto",
  };
}

async function saveCurrentEmailAsSample() {
  if (!state.email?.body) return false;
  const sample = state.email.body.trim();
  if (sample.length < 20) return false; // too short to learn anything

  const acct = await acctGet(state.account, ["styleSamples"]);
  const existing = Array.isArray(acct.styleSamples) ? acct.styleSamples : [];

  // Don't store duplicates.
  if (existing.some((s) => s.trim() === sample)) return "dup";

  const next = [...existing, sample].slice(-STYLE_SAMPLES_MAX);
  await acctSet(state.account, { styleSamples: next });
  return true;
}

function bindStyleSamples() {
  if (!els.saveSampleBtn) return;

  els.saveSampleBtn.addEventListener("click", async () => {
    els.saveSampleBtn.disabled = true;
    const result = await saveCurrentEmailAsSample();
    if (result === true) {
      flashButton(els.saveSampleBtn, t("styleSavedFlash"));
      scheduleStyleDiagnosis();
      detectAndStoreSignature();
    } else if (result === "dup") {
      flashButton(els.saveSampleBtn, t("styleAlreadyFlash"));
    } else {
      flashButton(els.saveSampleBtn, t("styleTooShortFlash"));
    }
    updateStyleSampleCount();
  });

  if (els.autoScanBtn) {
    els.autoScanBtn.addEventListener("click", () => startAutoScan());
  }
  if (els.autoScanCancel) {
    els.autoScanCancel.addEventListener("click", () => {
      if (autoScanCtl) autoScanCtl.cancelled = true;
    });
  }

  // React to URL/hash navigation — Gmail uses hash routing so we don't get a
  // proper navigation event, but `hashchange` fires reliably.
  window.addEventListener("hashchange", updateStyleBannerVisibility);
}

// ----- Auto-scan Sent folder -----
//
// State machine: from the Sent list view, navigate into each thread, scrape
// the body, save as a style sample, hit "Back" to return to the list,
// repeat. Stops when we hit the per-day sample cap, run out of rows, or the
// user cancels. Designed to fail soft: any unexpected DOM state aborts the
// scan with a recoverable error.

let autoScanCtl = null; // current scan's control handle, or null

const AUTOSCAN_MAX_PER_ROUND = 10;
const AUTOSCAN_WAIT_MS = 2500;
const AUTOSCAN_STEP_DELAY_MS = 250;

function setAutoScanUI(running) {
  if (!els.autoScanProgress) return;
  els.autoScanProgress.hidden = !running;
  // Hide the action buttons while running.
  els.saveSampleBtn.hidden = !!running;
  els.autoScanBtn.hidden = !!running;
  els.styleCount.hidden = !!running;
}

function updateAutoScanProgress(i, n) {
  if (!els.autoScanText) return;
  els.autoScanText.textContent = t("autoScanScanning", [String(i), String(n)]);
  const pct = n ? Math.min(100, Math.round((i / n) * 100)) : 0;
  els.autoScanBar.style.width = `${pct}%`;
}

async function startAutoScan() {
  if (autoScanCtl) return; // already running
  if (!isInSentFolder()) {
    flashButton(els.autoScanBtn, t("autoScanNoList"));
    return;
  }

  // Count how many more samples we can take.
  const acct = await acctGet(state.account, ["styleSamples"]);
  const existing = Array.isArray(acct.styleSamples) ? acct.styleSamples : [];
  const remaining = Math.max(0, 10 - existing.length);
  if (remaining === 0) {
    flashButton(els.autoScanBtn, t("styleAlreadyFlash"));
    return;
  }

  const target = Math.min(AUTOSCAN_MAX_PER_ROUND, remaining);
  autoScanCtl = { cancelled: false };
  setAutoScanUI(true);
  els.autoScanText.textContent = t("autoScanStarting");
  els.autoScanBar.style.width = "0%";

  const originalHash = window.location.hash;
  let added = 0;

  try {
    // Make sure we're on the list view; if we're inside an email, go back.
    if (!isOnListView()) {
      const back = findBackToListButton();
      if (back) {
        back.click();
        await waitForList(AUTOSCAN_WAIT_MS);
      }
    }

    for (let i = 0; i < target; i++) {
      if (autoScanCtl.cancelled) break;

      updateAutoScanProgress(i, target);

      const rows = findListRows();
      if (i >= rows.length) break; // out of emails

      const row = rows[i];
      // Click on the subject/snippet cell (more reliable than the row itself,
      // which sometimes has stop-propagation handlers for checkbox/star).
      const clickTarget =
        row.querySelector(".y6") || row.querySelector(".bog") || row;
      clickTarget.click();

      // Wait for the open email DOM to appear and have a body.
      const opened = await waitForOpenEmail(AUTOSCAN_WAIT_MS);
      if (!opened) {
        // Skip this row but try to keep going.
        await goBackToList();
        continue;
      }

      const email = extractCurrentEmail();
      if (email?.body && email.body.length >= 20) {
        await addSample(email.body.trim());
        added++;
        updateStyleSampleCount();
      }

      // Return to the list before clicking the next row.
      await goBackToList();
      await sleep(AUTOSCAN_STEP_DELAY_MS);
    }

    updateAutoScanProgress(target, target);
    if (autoScanCtl.cancelled) {
      els.autoScanText.textContent = `${t("autoScanCancelled")} — +${added}`;
    } else {
      els.autoScanText.textContent = t("autoScanDone", [String(added)]);
    }
    if (added > 0) {
      scheduleStyleDiagnosis();
      detectAndStoreSignature();
    }
  } catch {
    els.autoScanText.textContent = t("autoScanFailed");
  } finally {
    // Pause briefly so the user sees the final state, then close the UI.
    await sleep(1200);
    autoScanCtl = null;
    setAutoScanUI(false);
    // Best-effort: return to the user's original location.
    if (originalHash && window.location.hash !== originalHash) {
      window.location.hash = originalHash;
    }
  }
}

function isOnListView() {
  return findListRows().length > 0;
}

function waitForOpenEmail(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const email = extractCurrentEmail();
      if (email?.body && email.body.length >= 20) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function waitForList(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (isOnListView()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

async function goBackToList() {
  const back = findBackToListButton();
  if (back) {
    back.click();
  } else {
    // Last-resort: browser back. Skips Gmail-internal animations cleanly.
    window.history.back();
  }
  await waitForList(AUTOSCAN_WAIT_MS);
}

async function addSample(sample) {
  const acct = await acctGet(state.account, ["styleSamples"]);
  const existing = Array.isArray(acct.styleSamples) ? acct.styleSamples : [];
  if (existing.some((s) => s.trim() === sample)) return false;
  const next = [...existing, sample].slice(-10);
  await acctSet(state.account, { styleSamples: next });
  return true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function updateStyleBannerVisibility() {
  if (!els.styleBanner) return;
  // Banner shows when: in Sent folder AND an email is currently open.
  const show = isInSentFolder() && state.email && state.email.body;
  els.styleBanner.hidden = !show;
  if (show) updateStyleSampleCount();
}

async function updateStyleSampleCount() {
  if (!els.styleCount) return;
  const acct = await acctGet(state.account, ["styleSamples"]);
  const n = Array.isArray(acct.styleSamples) ? acct.styleSamples.length : 0;
  els.styleCount.textContent = t("styleCount", [String(n)]);
}

// ----- Style diagnosis -----
//
// After the user accumulates ≥3 samples, ask the model to summarize their
// writing style in one sentence. Cached so we don't burn tokens on every
// view. Re-run on next add when samples-count moves to a new bucket (3,5,8)
// so the diagnosis stays fresh as more samples arrive.

const DIAGNOSIS_BUCKETS = [3, 5, 8];
let diagnosisTimer = null;

function scheduleStyleDiagnosis() {
  // Debounce: when several samples arrive in quick succession (e.g.
  // auto-scan), wait for the burst to end before re-running.
  if (diagnosisTimer) clearTimeout(diagnosisTimer);
  diagnosisTimer = setTimeout(maybeRunStyleDiagnosis, 1200);
}

// Run on every sample add — cheap (no API call), local string matching.
async function detectAndStoreSignature() {
  const acct = await acctGet(state.account, ["styleSamples"]);
  const samples = Array.isArray(acct.styleSamples) ? acct.styleSamples : [];
  if (samples.length < 2) {
    await acctSet(state.account, { signature: null });
    return;
  }
  const sig = extractSignatureFromSamples(samples);
  await acctSet(state.account, { signature: sig || null });
}

async function maybeRunStyleDiagnosis() {
  diagnosisTimer = null;
  const acct = await acctGet(state.account, ["styleSamples", "styleDiagnosis"]);
  const samples = Array.isArray(acct.styleSamples) ? acct.styleSamples : [];
  const n = samples.length;
  if (n < DIAGNOSIS_BUCKETS[0]) return;

  // Bucket the count so we don't regenerate on every single sample —
  // only when we cross a threshold.
  const currentBucket = DIAGNOSIS_BUCKETS.slice().reverse().find((b) => n >= b);
  if (acct.styleDiagnosis?.bucket === currentBucket) return;

  try {
    const text = await callAI(styleDiagnosisPrompt(samples), false);
    const clean = (text || "").trim().replace(/^["']|["']$/g, "");
    await acctSet(state.account, {
      styleDiagnosis: { text: clean, bucket: currentBucket, sampleCount: n, at: Date.now() },
    });
    bumpUsage().then(refreshUsageDisplay);
  } catch {
    // Soft fail — diagnosis is a nice-to-have, never block the user.
  }
}

// ----- Drafts -----
//
// Each .er-draft card is collapsed by default. First time it's opened we call
// the AI to generate a draft for that style and store it on state.variants.
// Subsequent toggles just show/hide the body without re-calling the model.

// ----- Draft area: segmented tabs + single pane -----
//
// One pane shows the active style's draft. state.activeStyle tracks which
// tab is selected. Each style keeps its own variants + draft status, so a
// style can be streaming in the background while another is on screen.

function bindDrafts() {
  // "Draft anyway" — overrides reply suppression for the current email.
  if (els.draftAnyway) {
    els.draftAnyway.addEventListener("click", unsuppressReply);
  }

  // Collect the single pane's element refs once.
  const pane = els.draftPane;
  els.pane = {
    pane,
    textEl: pane.querySelector("[data-text]"),
    copyBtn: pane.querySelector('[data-action="copy"]'),
    insertBtn: pane.querySelector('[data-action="insert"]'),
    toneBtn: pane.querySelector('[data-action="tone"]'),
    moreBtn: pane.querySelector('[data-action="more"]'),
    refineRow: pane.querySelector("[data-refine]"),
    refineInput: pane.querySelector("[data-refine-input]"),
    refineSubmit: pane.querySelector("[data-refine-submit]"),
    refinePresets: pane.querySelectorAll("[data-refine-preset]"),
    resetBtn: pane.querySelector("[data-refine-reset]"),
    variantsRow: pane.querySelector("[data-variants]"),
    langSelect: pane.querySelector("[data-lang]"),
    errBlock: pane.querySelector(".er-draft-error"),
  };
  const p = els.pane;

  // Segmented style tabs — clicking one switches the pane (and generates
  // that style on demand if it hasn't been generated yet).
  for (const tab of els.styleTabs.querySelectorAll(".er-style-tab")) {
    tab.addEventListener("click", () => {
      setActiveStyle(tab.dataset.style, { generate: true });
    });
  }

  p.copyBtn.addEventListener("click", () => copyDraft(state.activeStyle, p.copyBtn));
  p.insertBtn.addEventListener("click", () => insertDraft(state.activeStyle, p.insertBtn));
  p.toneBtn.addEventListener("click", () => sendDraftToTone(state.activeStyle));

  // ⋯ toggles the advanced panel.
  p.moreBtn.addEventListener("click", () => {
    const open = pane.getAttribute("data-advanced") === "true";
    pane.setAttribute("data-advanced", open ? "false" : "true");
  });

  // Keep the active variant in sync with inline edits.
  p.textEl.addEventListener("input", () => {
    if (p.textEl.contentEditable === "true") {
      const text = p.textEl.textContent.trim();
      const v = getVariants(state.activeStyle);
      if (v.list[v.active]) v.list[v.active].draft = text;
    }
  });

  // Refinement actions.
  for (const btn of p.refinePresets) {
    btn.addEventListener("click", () => refineDraft(state.activeStyle, btn.dataset.refinePreset));
  }
  p.refineSubmit.addEventListener("click", () => {
    const v = p.refineInput.value.trim();
    if (!v) return;
    refineDraft(state.activeStyle, v);
    p.refineInput.value = "";
  });
  p.refineInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      p.refineSubmit.click();
    }
  });

  if (p.resetBtn) {
    p.resetBtn.addEventListener("click", () => generateDraft(state.activeStyle, "replace"));
  }

  if (p.langSelect) {
    p.langSelect.addEventListener("change", async () => {
      await chrome.storage.local.set({ replyLanguage: p.langSelect.value });
      // Re-roll the active style in the new language.
      generateDraft(state.activeStyle, "replace");
    });
  }
}

// Switch the visible style tab. `generate` controls whether an idle style
// gets generated on the spot (true for user tab clicks, false for the
// initial paint when auto-draft is off).
function setActiveStyle(style, { generate = true } = {}) {
  if (!DRAFT_STYLES.includes(style)) return;
  state.activeStyle = style;

  for (const tab of els.styleTabs.querySelectorAll(".er-style-tab")) {
    tab.setAttribute("data-active", tab.dataset.style === style ? "true" : "false");
  }

  renderPaneForStyle(style, generate);
}

// Paint the pane to reflect the given style's current status.
function renderPaneForStyle(style, allowGenerate) {
  const status = state.draftStatus[style] || "idle";

  if (status === "idle") {
    if (allowGenerate) {
      generateDraft(style, "fresh");
    } else {
      showDraftEmpty();
    }
    return;
  }
  if (status === "loading") {
    showDraftLoading();
    return;
  }
  if (status === "streaming") {
    showDraftStreaming(state.streamBuffers[style] || "");
    return;
  }
  if (status === "error") {
    showDraftError(state.draftErrors[style], style);
    return;
  }
  // "ready"
  showDraftText(getActiveDraft(style));
  renderVariantTabs(style);
  updateResetButton(style);
}

// Resets the pane + all per-style draft state. Called on every email open.
function resetDraftPane() {
  state.draftStatus = {};
  state.streamBuffers = {};
  state.streamTokens = {};
  state.draftErrors = {};
  const p = els.pane;
  if (!p) return;
  els.draftPane.setAttribute("data-advanced", "false");
  p.textEl.classList.remove("loading", "streaming");
  p.textEl.contentEditable = "false";
  p.textEl.textContent = "";
  if (p.refineRow) p.refineRow.hidden = true;
  if (p.refineInput) p.refineInput.value = "";
  if (p.resetBtn) p.resetBtn.hidden = true;
  if (p.variantsRow) {
    p.variantsRow.hidden = true;
    p.variantsRow.innerHTML = "";
  }
  hideDraftError();
}

// `mode`: "fresh" (clear all variants), "new" (add a variant), "replace"
// (overwrite the active variant).
async function generateDraft(style, mode = "fresh") {
  // Set up variants for this style based on mode.
  let v = getVariants(style);
  if (mode === "fresh" || !v.list.length) {
    v = { active: 0, list: [{ draft: "", history: [] }] };
  } else if (mode === "new") {
    if (v.list.length >= MAX_VARIANTS) {
      v.list[v.active] = { draft: "", history: [] };
    } else {
      v.list.push({ draft: "", history: [] });
      v.active = v.list.length - 1;
    }
  } else {
    v.list[v.active] = { draft: "", history: [] };
  }
  setVariants(style, v);

  state.draftStatus[style] = "loading";
  if (state.activeStyle === style) showDraftLoading();

  const myToken = (state.streamTokens[style] = Symbol("stream"));
  const ctx = await loadStyleContext();
  const seedPrompt = draftPrompt(state.email, style, ctx);

  try {
    const text = await callAIStream(seedPrompt, {
      onDelta: (partial) => {
        if (state.streamTokens[style] !== myToken) return;
        state.draftStatus[style] = "streaming";
        state.streamBuffers[style] = partial;
        if (state.activeStyle === style) showDraftStreaming(partial);
      },
    });
    if (state.streamTokens[style] !== myToken) return; // superseded
    bumpUsage().then(refreshUsageDisplay);
    bumpStat("drafts", style);
    const clean = (text || "").trim();
    writeActiveDraft(style, clean, [
      { role: "user", content: seedPrompt },
      { role: "assistant", content: clean },
    ]);
    state.draftStatus[style] = "ready";
    delete state.streamBuffers[style];
    if (state.activeStyle === style) {
      showDraftText(clean);
      renderVariantTabs(style);
      updateResetButton(style);
    }
    saveCache(state.email.id, { variants: variantSnapshot() });
  } catch (err) {
    if (state.streamTokens[style] !== myToken) return;
    const code = err.message || String(err);
    state.draftStatus[style] = "error";
    state.draftErrors[style] = code;
    if (state.activeStyle === style) showDraftError(code, style);
  }
}

// ----- Pane paint helpers (operate on the single pane) -----

function showDraftEmpty() {
  const p = els.pane;
  hideDraftError();
  p.textEl.classList.remove("loading", "streaming");
  p.textEl.contentEditable = "false";
  p.textEl.classList.add("loading"); // reuse the muted styling
  p.textEl.textContent = t("draftEmptyHint");
  p.copyBtn.disabled = true;
  p.insertBtn.disabled = true;
  if (p.toneBtn) p.toneBtn.disabled = true;
  if (p.refineRow) p.refineRow.hidden = true;
  if (p.variantsRow) p.variantsRow.hidden = true;
}

function showDraftLoading() {
  const p = els.pane;
  hideDraftError();
  p.textEl.contentEditable = "false";
  p.textEl.classList.remove("streaming");
  p.textEl.classList.add("loading");
  p.textEl.textContent = t("draftingReply");
  p.copyBtn.disabled = true;
  p.insertBtn.disabled = true;
  if (p.toneBtn) p.toneBtn.disabled = true;
  if (p.refineRow) p.refineRow.hidden = true;
}

function showDraftStreaming(partial) {
  const p = els.pane;
  hideDraftError();
  p.textEl.classList.remove("loading");
  p.textEl.contentEditable = "false";
  p.textEl.classList.add("streaming");
  p.textEl.textContent = partial;
}

function showDraftText(text) {
  const p = els.pane;
  hideDraftError();
  p.textEl.classList.remove("loading", "streaming");
  p.textEl.textContent = text;
  // Inline editing once the stream completes.
  p.textEl.contentEditable = "true";
  p.copyBtn.disabled = false;
  p.insertBtn.disabled = false;
  if (p.toneBtn) p.toneBtn.disabled = false;
  if (p.refineRow) p.refineRow.hidden = false;
}

function showDraftError(code, style) {
  // Missing key → push the user out to the no-key state.
  if (code === "NO_API_KEY") {
    setShellState("no-key");
    return;
  }
  const p = els.pane;
  p.textEl.classList.remove("loading", "streaming");
  p.textEl.textContent = "";
  p.copyBtn.disabled = true;
  p.insertBtn.disabled = true;

  const errBlock = p.errBlock;
  errBlock.hidden = false;
  errBlock.innerHTML = "";

  const msg = document.createElement("span");
  msg.textContent = humanizeError(code);
  errBlock.appendChild(msg);

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "er-ghost-btn";
  retry.textContent = t("actionRetry");
  retry.addEventListener("click", () => generateDraft(style, "replace"));
  errBlock.appendChild(retry);
}

function hideDraftError() {
  const err = els.pane?.errBlock;
  if (err) {
    err.hidden = true;
    err.innerHTML = "";
  }
}

async function copyDraft(style, btn) {
  const text = getActiveDraft(style);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flashButton(btn, t("copied"));
  } catch {
    flashButton(btn, t("copyFailed"));
  }
}

async function insertDraft(style, btn) {
  const text = getActiveDraft(style);
  if (!text) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = t("inserting");
  const replyAll = els.replyAll?.checked === true;
  const ok = await insertDraftIntoCompose(text, { replyAll });
  btn.textContent = original;
  btn.disabled = false;
  if (ok) {
    bumpStat("inserts");
    if (state.email?.sender) {
      rememberSenderStyle(state.email.sender, style);
    }
    appendDraftHistory({
      at: Date.now(),
      style,
      sender: state.email?.sender || "",
      senderName: state.email?.senderName || "",
      subject: state.email?.subject || "",
      text,
    });
  }
  flashButton(btn, ok ? (replyAll ? t("insertedAll") : t("inserted")) : t("noReplyBox"));
}

function sendDraftToTone(style) {
  const text = getActiveDraft(style);
  if (!text) return;
  els.toneInput.value = text;
  if (els.toneSection) els.toneSection.setAttribute("data-open", "true");
  els.toneSection?.scrollIntoView({ behavior: "smooth", block: "start" });
  els.toneInput.focus();
}

// Refine the active style's draft via multi-turn chat.
async function refineDraft(style, instruction) {
  const p = els.pane;
  if (!p) return;

  // On-screen text captures any inline edits the user made.
  const onScreen = (p.textEl.textContent || "").trim();
  const current = onScreen || getActiveDraft(style);
  if (!current || !state.email) return;

  p.refinePresets.forEach((b) => (b.disabled = true));
  p.refineSubmit.disabled = true;
  p.refineInput.disabled = true;

  const myToken = (state.streamTokens[style] = Symbol("refine"));
  state.draftStatus[style] = "streaming";
  if (state.activeStyle === style) showDraftStreaming(t("rewriting"));

  const ctx = await loadStyleContext();
  const history = await getOrSeedHistory(style, current, ctx);

  // Refresh the last assistant turn to the on-screen text.
  if (history.length && history[history.length - 1].role === "assistant") {
    history[history.length - 1] = { role: "assistant", content: current };
  }

  const userMsg = { role: "user", content: instructionFor(instruction) };
  const messages = [...history, userMsg];

  try {
    const text = await callAIChatStream(messages, {
      onDelta: (partial) => {
        if (state.streamTokens[style] !== myToken) return;
        state.streamBuffers[style] = partial;
        if (state.activeStyle === style) showDraftStreaming(partial);
      },
    });
    if (state.streamTokens[style] !== myToken) return;
    bumpUsage().then(refreshUsageDisplay);
    bumpStat("refines");
    const clean = (text || "").trim();
    writeActiveDraft(style, clean, [...messages, { role: "assistant", content: clean }]);
    state.draftStatus[style] = "ready";
    delete state.streamBuffers[style];
    if (state.activeStyle === style) {
      showDraftText(clean);
      updateResetButton(style);
    }
    saveCache(state.email.id, { variants: variantSnapshot() });
  } catch (err) {
    if (state.streamTokens[style] !== myToken) return;
    const code = err.message || String(err);
    state.draftStatus[style] = "error";
    state.draftErrors[style] = code;
    if (state.activeStyle === style) showDraftError(code, style);
  } finally {
    p.refinePresets.forEach((b) => (b.disabled = false));
    p.refineSubmit.disabled = false;
    p.refineInput.disabled = false;
  }
}

async function getOrSeedHistory(style, currentDraft, ctx) {
  const existing = getActiveHistory(style);
  if (Array.isArray(existing) && existing.length >= 2) return [...existing];
  const seed = [
    { role: "user", content: draftPrompt(state.email, style, ctx) },
    { role: "assistant", content: currentDraft },
  ];
  writeActiveDraft(style, currentDraft, seed);
  return [...seed];
}

function instructionFor(input) {
  switch (input) {
    case "shorter":
      return "Make it noticeably shorter while keeping the core message.";
    case "softer":
      return "Soften the tone — warmer and less direct, without becoming sycophantic.";
    case "direct":
      return "Make it more direct and confident. Remove hedging words.";
    default:
      return input;
  }
}

function refineCountFor(style) {
  const h = getActiveHistory(style);
  return h.length >= 4 ? Math.floor((h.length - 2) / 2) : 0;
}

function updateResetButton(style) {
  const btn = els.pane?.resetBtn;
  if (!btn) return;
  const count = refineCountFor(style);
  btn.hidden = count < 1;
  if (count > 0) {
    btn.title = t("resetTooltip", [String(count)]);
  }
}

// Rebuild the variant tab row for the active style.
function renderVariantTabs(style) {
  const row = els.pane?.variantsRow;
  if (!row) return;
  // Only the active style's variants render into the single pane.
  if (state.activeStyle !== style) return;
  const v = getVariants(style);

  if (!v.list.length) {
    row.hidden = true;
    row.innerHTML = "";
    return;
  }

  row.hidden = false;
  row.innerHTML = "";

  v.list.forEach((_, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "er-variant-tab";
    btn.textContent = String(i + 1);
    btn.title = t("variantTabTooltip", [String(i + 1)]);
    if (i === v.active) btn.setAttribute("data-active", "true");
    btn.addEventListener("click", () => switchVariant(style, i));
    row.appendChild(btn);
  });

  if (v.list.length < MAX_VARIANTS) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "er-variant-add";
    addBtn.textContent = t("variantAdd");
    addBtn.title = t("variantAddTooltip");
    addBtn.addEventListener("click", () => generateDraft(style, "new"));
    row.appendChild(addBtn);
  }
}

function switchVariant(style, index) {
  const v = getVariants(style);
  if (!v.list[index]) return;
  v.active = index;
  setVariants(style, v);
  if (state.activeStyle === style) {
    showDraftText(v.list[index].draft);
    renderVariantTabs(style);
    updateResetButton(style);
  }
  if (state.email) {
    saveCache(state.email.id, { variants: variantSnapshot() });
  }
}

function flashButton(btn, label) {
  const original = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
}

// ----- Tone Check -----
//
// User pastes their own draft → we send it together with the original email so
// the model can compare register and tone. Result includes flagged phrases
// with suggested rewrites and a 1-10 score.

function bindToneCheck() {
  els.toneCheckBtn.addEventListener("click", runToneCheck);

  // Collapsible header — click to expand/collapse the Tone Check body.
  if (els.toneToggle && els.toneSection) {
    els.toneToggle.addEventListener("click", () => {
      const open = els.toneSection.getAttribute("data-open") === "true";
      els.toneSection.setAttribute("data-open", open ? "false" : "true");
    });
  }
}

function resetToneCheck() {
  els.toneInput.value = "";
  els.toneResult.hidden = true;
  els.toneResult.innerHTML = "";
  // Re-collapse on email change so it's tidy by default.
  if (els.toneSection) els.toneSection.setAttribute("data-open", "false");
}

async function runToneCheck() {
  const draft = els.toneInput.value.trim();
  if (!draft) {
    showToneResult({ type: "error", message: t("tonePasteFirst") });
    return;
  }

  els.toneCheckBtn.disabled = true;
  els.toneCheckBtn.textContent = t("toneAnalyzing");

  showToneResult({ type: "loading" });

  try {
    const result = await callAI(
      toneCheckPrompt(draft, state.email || {}),
      true,
    );
    bumpUsage().then(refreshUsageDisplay);
    bumpStat("tones");
    showToneResult({ type: "ok", data: result });
  } catch (err) {
    const code = err.message || String(err);
    if (code === "NO_API_KEY") {
      setShellState("no-key");
      els.toneResult.hidden = true;
      return;
    }
    showToneResult({
      type: "error",
      code,
      onRetry: runToneCheck,
    });
  } finally {
    els.toneCheckBtn.disabled = false;
    els.toneCheckBtn.textContent = t("toneCheckBtn");
  }
}

function showToneResult(payload) {
  els.toneResult.hidden = false;
  els.toneResult.innerHTML = "";

  if (payload.type === "loading") {
    els.toneResult.innerHTML = `
      <div class="er-skeleton er-skeleton-line"></div>
      <div class="er-skeleton er-skeleton-line short"></div>
      <div class="er-skeleton er-skeleton-line"></div>
    `;
    return;
  }

  if (payload.type === "error") {
    const text =
      payload.message ||
      humanizeError(payload.code) ||
      "Tone check failed.";
    const wrap = document.createElement("div");
    wrap.className = "er-tone-row";
    wrap.innerHTML = `
      <div class="er-tone-row-body" style="color:#991b1b">${escapeHtml(text)}</div>
    `;
    els.toneResult.appendChild(wrap);

    if (payload.onRetry) {
      const actions = document.createElement("div");
      actions.className = "er-rewrite-actions";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "er-ghost-btn";
      retry.textContent = t("actionRetry");
      retry.addEventListener("click", payload.onRetry);
      actions.appendChild(retry);
      els.toneResult.appendChild(actions);
    }
    return;
  }

  // payload.type === "ok"
  const data = payload.data || {};

  // 1. Tone Fingerprint + score
  if (data.toneFingerprint || typeof data.overallScore !== "undefined") {
    const row = document.createElement("div");
    row.className = "er-tone-row";

    const label = document.createElement("div");
    label.className = "er-tone-row-label";
    label.textContent = t("toneFingerprint");
    row.appendChild(label);

    if (typeof data.overallScore !== "undefined" && data.overallScore !== null) {
      const score = document.createElement("div");
      score.className = "er-tone-score";
      score.innerHTML = `${escapeHtml(String(data.overallScore))}<span style="font-size:11px;color:rgba(0,0,0,0.5);font-weight:500"> / 10</span>`;
      row.appendChild(score);
    }

    if (data.toneFingerprint) {
      const body = document.createElement("div");
      body.className = "er-tone-row-body";
      body.style.marginTop = "4px";
      body.textContent = data.toneFingerprint;
      row.appendChild(body);
    }

    els.toneResult.appendChild(row);
  }

  // 2. Flagged phrases
  if (Array.isArray(data.flaggedPhrases) && data.flaggedPhrases.length) {
    const row = document.createElement("div");
    row.className = "er-tone-row";

    const label = document.createElement("div");
    label.className = "er-tone-row-label";
    label.textContent = t("toneFlagged", [String(data.flaggedPhrases.length)]);
    row.appendChild(label);

    const list = document.createElement("div");
    list.className = "er-flagged";

    for (const item of data.flaggedPhrases) {
      const node = document.createElement("div");
      node.className = "er-flagged-item";
      node.innerHTML = `
        <div class="er-flagged-phrase">“${escapeHtml(item.phrase || "")}”</div>
        <div class="er-flagged-issue">${escapeHtml(item.issue || "")}</div>
        ${
          item.suggestion
            ? `<div class="er-flagged-suggestion">→ ${escapeHtml(item.suggestion)}</div>`
            : ""
        }
      `;
      list.appendChild(node);
    }
    row.appendChild(list);
    els.toneResult.appendChild(row);
  }

  // 3. Length feedback
  if (data.lengthFeedback) {
    const row = document.createElement("div");
    row.className = "er-tone-row";
    row.innerHTML = `
      <div class="er-tone-row-label">${escapeHtml(t("toneLength"))}</div>
      <div class="er-tone-row-body">${escapeHtml(data.lengthFeedback)}</div>
    `;
    els.toneResult.appendChild(row);
  }

  // 4. Rewritten draft + Copy/Insert actions
  if (data.rewrittenDraft) {
    const row = document.createElement("div");
    row.className = "er-tone-row";

    const label = document.createElement("div");
    label.className = "er-tone-row-label";
    label.textContent = t("toneRewrite");
    row.appendChild(label);

    const rewrite = document.createElement("div");
    rewrite.className = "er-rewrite";
    rewrite.textContent = data.rewrittenDraft;
    row.appendChild(rewrite);

    const actions = document.createElement("div");
    actions.className = "er-rewrite-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "er-ghost-btn";
    copyBtn.textContent = t("actionCopy");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(data.rewrittenDraft);
        flashButton(copyBtn, t("copied"));
      } catch {
        flashButton(copyBtn, t("copyFailed"));
      }
    });
    actions.appendChild(copyBtn);

    const insertBtn = document.createElement("button");
    insertBtn.type = "button";
    insertBtn.className = "er-primary-btn";
    insertBtn.textContent = t("actionInsert");
    insertBtn.addEventListener("click", async () => {
      insertBtn.disabled = true;
      const original = insertBtn.textContent;
      insertBtn.textContent = t("inserting");
      const replyAll = els.replyAll?.checked === true;
      const ok = await insertDraftIntoCompose(data.rewrittenDraft, { replyAll });
      insertBtn.textContent = original;
      insertBtn.disabled = false;
      flashButton(insertBtn, ok ? (replyAll ? t("insertedAll") : t("inserted")) : t("noReplyBox"));
    });
    actions.appendChild(insertBtn);

    row.appendChild(actions);
    els.toneResult.appendChild(row);
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function capitalize(s) {
  return typeof s === "string" && s.length ? s[0].toUpperCase() + s.slice(1) : "";
}

// ----- Keyboard shortcuts -----
//
//   J / K           cycle to next / previous draft style (expands that card)
//   R               insert active draft of currently expanded card
//   C               copy active draft of currently expanded card
//   V               toggle between variants of currently expanded card
//   Cmd/Ctrl+Shift+E   collapse/expand the sidebar
//
// We deliberately don't intercept keystrokes while the user is typing into a
// form field, contenteditable, or Gmail's compose box. That makes shortcuts
// invisible during writing — only active when navigating.

function bindShortcuts() {
  document.addEventListener("keydown", onShortcutKey, true);

  // Cheat-sheet close handlers — both backdrop click and the ✕ button.
  if (els.cheatsheet) {
    els.cheatsheet.addEventListener("click", (e) => {
      if (e.target.hasAttribute("data-cheatsheet-close")) hideCheatsheet();
    });
  }
}

function showCheatsheet() {
  if (els.cheatsheet) els.cheatsheet.hidden = false;
}

function hideCheatsheet() {
  if (els.cheatsheet) els.cheatsheet.hidden = true;
}

// ----- Live Style Coach -----
//
// Watches the Gmail compose box while the user is typing their OWN draft
// (not one of EchoReply's). After they pause for COACH_DEBOUNCE_MS and have
// written enough characters AND we haven't checked in COACH_MIN_INTERVAL,
// we send the current draft + their style samples to the AI and surface a
// short verdict ("sounds like you" or "drifting on these lines").
//
// Opt-in: requires `coachEnabled === true` in storage. Also requires the user
// to have at least 2 style samples (otherwise there's nothing to compare to).

const COACH_DEBOUNCE_MS = 4000;
const COACH_MIN_INTERVAL = 8000;
const COACH_MIN_CHARS = 40;

const coach = {
  observer: null,
  timer: null,
  lastCheckAt: 0,
  lastCheckedText: "",
  inFlight: false,
  enabled: false,
};

function bindLiveCoach() {
  // React to settings changes — start/stop watching as toggle flips or
  // samples are added.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.coachEnabled || (changes.lastActiveAccount && changes.lastActiveAccount.newValue)) {
      reconfigureCoach();
    }
    // Per-account: styleSamples may live or die.
    for (const key of Object.keys(changes)) {
      if (key.endsWith("__styleSamples")) reconfigureCoach();
    }
  });
  // Boot once on init.
  reconfigureCoach();
}

async function reconfigureCoach() {
  const { coachEnabled } = await chrome.storage.local.get("coachEnabled");
  const enabled = coachEnabled === true;
  const acct = await acctGet(state.account, ["styleSamples"]);
  const haveSamples = Array.isArray(acct.styleSamples) && acct.styleSamples.length >= 2;

  coach.enabled = enabled && haveSamples;

  if (coach.enabled) {
    attachComposeWatcher();
  } else {
    detachComposeWatcher();
    if (els.coachResult) {
      els.coachResult.hidden = true;
      els.coachResult.innerHTML = "";
    }
  }
}

function attachComposeWatcher() {
  if (coach.observer) return;
  // Watch the whole document — compose boxes appear and disappear as the
  // user toggles Reply / Reply All. We catch text changes via input events
  // bubbling up from the editable region.
  const handler = (e) => {
    const target = e.target;
    if (!target) return;
    if (!isComposeTarget(target)) return;
    onComposeInput(target);
  };
  document.addEventListener("input", handler, true);
  coach.observer = handler;
}

function detachComposeWatcher() {
  if (coach.observer) {
    document.removeEventListener("input", coach.observer, true);
    coach.observer = null;
  }
  if (coach.timer) {
    clearTimeout(coach.timer);
    coach.timer = null;
  }
}

function isComposeTarget(node) {
  if (!node || node.nodeType !== 1) return false;
  // Gmail's compose box is a contenteditable [role="textbox"][aria-label*=Message].
  return (
    node.getAttribute &&
    node.getAttribute("role") === "textbox" &&
    /Message|Body/.test(node.getAttribute("aria-label") || "")
  );
}

function onComposeInput(composeBox) {
  if (coach.timer) clearTimeout(coach.timer);
  coach.timer = setTimeout(() => maybeRunCoach(composeBox), COACH_DEBOUNCE_MS);
}

async function maybeRunCoach(composeBox) {
  const text = (composeBox.innerText || composeBox.textContent || "").trim();
  if (text.length < COACH_MIN_CHARS) return;
  if (text === coach.lastCheckedText) return;
  if (coach.inFlight) return;
  if (Date.now() - coach.lastCheckAt < COACH_MIN_INTERVAL) return;

  const acct = await acctGet(state.account, ["styleSamples"]);
  const samples = Array.isArray(acct.styleSamples) ? acct.styleSamples : [];
  if (samples.length < 2) return;

  coach.inFlight = true;
  coach.lastCheckedText = text;

  try {
    const result = await callAI(styleCoachPrompt(text, samples), true);
    bumpUsage().then(refreshUsageDisplay);
    renderCoachResult(result);
    coach.lastCheckAt = Date.now();
  } catch {
    // Soft-fail. Coach is a background convenience; never block the user.
  } finally {
    coach.inFlight = false;
  }
}

// Renders the coach verdict as a standalone strip at the top of the scroll
// area. When the draft already sounds like the user, we show a brief green
// "✓ matches" line that auto-dismisses; when it drifts, we keep the flagged
// lines visible with a manual dismiss button.
function renderCoachResult(result) {
  if (!els.coachResult) return;
  els.coachResult.innerHTML = "";

  const flagged = Array.isArray(result.flaggedLines)
    ? result.flaggedLines.filter((f) => f && (f.line || f.issue))
    : [];
  const matches = result.matches === true && flagged.length === 0;

  els.coachResult.hidden = false;
  els.coachResult.setAttribute("data-state", matches ? "match" : "drift");

  // Header: label + dismiss button.
  const head = document.createElement("div");
  head.className = "er-coach-result-header";
  const label = document.createElement("span");
  label.className = "er-coach-result-label";
  label.textContent = t("coachLabel");
  head.appendChild(label);
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "er-coach-dismiss";
  dismiss.textContent = "✕";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.addEventListener("click", () => {
    els.coachResult.hidden = true;
    els.coachResult.innerHTML = "";
  });
  head.appendChild(dismiss);
  els.coachResult.appendChild(head);

  const note = document.createElement("div");
  note.className = "er-coach-note";
  note.textContent = matches
    ? `✓ ${result.overallNote || t("coachMatch")}`
    : (result.overallNote || t("coachDrift"));
  els.coachResult.appendChild(note);

  for (const f of flagged) {
    const node = document.createElement("div");
    node.className = "er-coach-flag";
    node.innerHTML = `
      <div class="er-coach-flag-line">“${escapeHtml(f.line || "")}”</div>
      <div class="er-coach-flag-issue">${escapeHtml(f.issue || "")}</div>
      ${
        f.suggestion
          ? `<div class="er-coach-flag-suggest">→ ${escapeHtml(f.suggestion)}</div>`
          : ""
      }
    `;
    els.coachResult.appendChild(node);
  }

  // "Matches" verdict is low-signal — auto-dismiss after a few seconds so it
  // doesn't linger. Drift verdicts stay until the user dismisses them.
  if (matches) {
    setTimeout(() => {
      if (els.coachResult.getAttribute("data-state") === "match") {
        els.coachResult.hidden = true;
        els.coachResult.innerHTML = "";
      }
    }, 4000);
  }
}

async function syncLanguageSelectors() {
  const { replyLanguage } = await chrome.storage.local.get("replyLanguage");
  const lang = replyLanguage || "auto";
  if (els.pane?.langSelect) els.pane.langSelect.value = lang;
}

function isCheatsheetOpen() {
  return els.cheatsheet && !els.cheatsheet.hidden;
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

function onShortcutKey(e) {
  // Cmd/Ctrl+Shift+E toggles sidebar — always works.
  if (e.shiftKey && (e.metaKey || e.ctrlKey) && (e.key === "E" || e.key === "e")) {
    e.preventDefault();
    setCollapsed(!state.collapsed);
    return;
  }

  // Esc closes the cheat-sheet if open. Always works.
  if (e.key === "Escape" && isCheatsheetOpen()) {
    e.preventDefault();
    hideCheatsheet();
    return;
  }

  // "?" opens the cheat-sheet. Works whenever the user isn't typing. We
  // accept both "?" (Shift+/) and the raw key in case the OS reports it
  // differently on non-US layouts.
  if ((e.key === "?" || (e.shiftKey && e.key === "/")) && !isTypingTarget(e.target)) {
    e.preventDefault();
    showCheatsheet();
    return;
  }

  // Plain-letter shortcuts: skip when user is typing or holding modifiers.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  // Skip when sidebar is collapsed — letter shortcuts only make sense visible.
  if (state.collapsed) return;
  // Need an email to act on, and the shell must be in the "ready" state.
  if (!state.email) return;
  if (els.shell.getAttribute("data-state") !== "ready") return;

  const key = e.key.toLowerCase();

  if (key === "j") {
    e.preventDefault();
    cycleDraft(+1);
    return;
  }
  if (key === "k") {
    e.preventDefault();
    cycleDraft(-1);
    return;
  }
  if (key === "v") {
    e.preventDefault();
    toggleVariant();
    return;
  }
  if (key === "c") {
    e.preventDefault();
    const style = state.activeStyle;
    if (els.pane?.copyBtn) copyDraft(style, els.pane.copyBtn);
    return;
  }
  if (key === "r") {
    e.preventDefault();
    const style = state.activeStyle;
    if (els.pane?.insertBtn) insertDraft(style, els.pane.insertBtn);
    return;
  }
}

// Cycle the visible style tab to the next/previous one.
function cycleDraft(direction) {
  const idx = DRAFT_STYLES.indexOf(state.activeStyle);
  const next = DRAFT_STYLES[((idx + direction) + DRAFT_STYLES.length) % DRAFT_STYLES.length];
  setActiveStyle(next, { generate: true });
}

function toggleVariant() {
  const style = state.activeStyle;
  const v = getVariants(style);
  if (v.list.length < 2) return;
  switchVariant(style, (v.active + 1) % v.list.length);
}

// ----- Error message mapping (shared by all features) -----

export function humanizeError(code) {
  if (!code) return t("errGeneric");
  if (code === "NO_API_KEY") return t("errNoApiKey");
  if (code === "API_ERROR_401") return t("err401");
  if (code === "API_ERROR_429") return t("err429");
  if (code === "PARSE_ERROR") return t("errParse");
  if (code === "NETWORK_ERROR") return t("errNetwork");
  if (/^API_ERROR_5\d\d$/.test(code)) return t("err5xx");
  if (code.startsWith("API_ERROR_")) {
    return `${t("errGeneric")} (${code.replace("API_ERROR_", "HTTP ")})`;
  }
  return t("errGeneric");
}
