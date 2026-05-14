// EchoReply — options page logic.
// Reads/writes provider, apiKey, defaultStyle to chrome.storage.local.
// "Test Connection" sends a tiny request to verify the key without consuming tokens unnecessarily.

// Inline i18n helper (options.js is a classic script — can't import the ESM
// lib version that the sidebar uses). Mirrors lib/i18n.js: when the user has
// forced a UI language, we resolve from a fetched messages.json; otherwise
// fall back to the browser-locale chrome.i18n.
let i18nMessages = null; // forced-locale message map, or null for "auto"

async function initI18n() {
  i18nMessages = null;
  let pref = "auto";
  try {
    const { uiLanguage } = await chrome.storage.local.get("uiLanguage");
    if (uiLanguage === "en" || uiLanguage === "zh_CN") pref = uiLanguage;
  } catch {
    /* stay on auto */
  }
  if (pref === "auto") return;
  try {
    const url = chrome.runtime.getURL(`_locales/${pref}/messages.json`);
    const res = await fetch(url);
    i18nMessages = await res.json();
  } catch {
    i18nMessages = null;
  }
}

function resolveMessage(entry, subs) {
  let msg = entry?.message || "";
  if (entry?.placeholders) {
    for (const [name, def] of Object.entries(entry.placeholders)) {
      const re = new RegExp("\\$" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\$", "gi");
      msg = msg.replace(re, def?.content ?? "");
    }
  }
  if (subs != null) {
    const arr = Array.isArray(subs) ? subs : [subs];
    msg = msg.replace(/\$(\d+)/g, (_, n) => {
      const v = arr[Number(n) - 1];
      return v == null ? "" : String(v);
    });
  }
  return msg;
}

function t(key, subs) {
  if (i18nMessages && i18nMessages[key]) {
    return resolveMessage(i18nMessages[key], subs);
  }
  if (typeof chrome !== "undefined" && chrome.i18n) {
    return chrome.i18n.getMessage(key, subs) || key;
  }
  return key;
}

// Inline account-namespaced storage helpers (mirror of lib/accountStorage.js).
// Options reads `lastActiveAccount` written by the sidebar so it shows data
// for whichever Gmail account the user most recently had open.
const PER_ACCOUNT_KEYS = new Set([
  "styleSamples",
  "styleDiagnosis",
  "signature",
  "senderStyles",
  "draftLog",
]);
let currentAccount = "0";

function nsKey(key) {
  if (PER_ACCOUNT_KEYS.has(key) || key.startsWith("emailCache_")) {
    return `acct${currentAccount}__${key}`;
  }
  return key;
}

async function acctGet(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  const ns = list.map(nsKey);
  const data = await chrome.storage.local.get(ns);
  const out = {};
  list.forEach((k, i) => { out[k] = data[ns[i]]; });
  return out;
}

async function acctSet(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[nsKey(k)] = obj[k];
  return chrome.storage.local.set(out);
}

function applyI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const msg = t(el.getAttribute("data-i18n"));
    if (msg) el.textContent = msg;
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    const msg = t(el.getAttribute("data-i18n-placeholder"));
    if (msg) el.setAttribute("placeholder", msg);
  }
}

const els = {
  providerRadios: document.querySelectorAll('input[name="provider"]'),
  claudeModelRow: document.getElementById("claude-model-row"),
  openaiModelRow: document.getElementById("openai-model-row"),
  claudeModel: document.getElementById("claude-model"),
  openaiModel: document.getElementById("openai-model"),
  apiKey: document.getElementById("api-key"),
  toggleKey: document.getElementById("toggle-key"),
  defaultStyle: document.getElementById("default-style"),
  autoDraft: document.getElementById("auto-draft"),
  styleCount: document.getElementById("style-count"),
  styleEnabled: document.getElementById("style-enabled"),
  styleList: document.getElementById("style-list"),
  clearSamples: document.getElementById("clear-samples"),
  styleDiagnosis: document.getElementById("style-diagnosis"),
  styleDiagnosisText: document.getElementById("style-diagnosis-text"),
  signatureBlock: document.getElementById("signature-block"),
  signatureText: document.getElementById("signature-text"),
  signatureEnabled: document.getElementById("signature-enabled"),
  statDrafts: document.getElementById("stat-drafts"),
  statRefines: document.getElementById("stat-refines"),
  statInserts: document.getElementById("stat-inserts"),
  statTimeSaved: document.getElementById("stat-time-saved"),
  statStyleRow: document.getElementById("stat-style-row"),
  statsPeriod: document.getElementById("stats-period"),
  coachEnabled: document.getElementById("coach-enabled"),
  uiLanguage: document.getElementById("ui-language"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  historyCount: document.getElementById("history-count"),
  clearHistory: document.getElementById("clear-history"),
  save: document.getElementById("save-btn"),
  test: document.getElementById("test-btn"),
  status: document.getElementById("status"),
};

function getProvider() {
  for (const r of els.providerRadios) if (r.checked) return r.value;
  return "claude";
}

function setProvider(value) {
  for (const r of els.providerRadios) r.checked = r.value === value;
  updateModelRowVisibility();
}

function updateModelRowVisibility() {
  const p = getProvider();
  if (els.claudeModelRow) els.claudeModelRow.hidden = p !== "claude";
  if (els.openaiModelRow) els.openaiModelRow.hidden = p !== "openai";
}

// Switching the provider radio should swap which model row is visible.
for (const r of document.querySelectorAll('input[name="provider"]')) {
  r.addEventListener("change", updateModelRowVisibility);
}

function setStatus(text, kind) {
  els.status.textContent = text || "";
  els.status.classList.remove("success", "error");
  if (kind) els.status.classList.add(kind);
}

async function load() {
  // Pick up the active Gmail account (set by the sidebar) so per-account
  // data shows for the right inbox.
  const { lastActiveAccount } = await chrome.storage.local.get("lastActiveAccount");
  if (typeof lastActiveAccount === "string") currentAccount = lastActiveAccount;

  const global = await chrome.storage.local.get([
    "provider",
    "apiKey",
    "defaultStyle",
    "autoDraft",
    "styleSamplesEnabled",
    "signatureEnabled",
    "stats",
    "coachEnabled",
    "claudeModel",
    "openaiModel",
    "uiLanguage",
  ]);
  const acct = await acctGet([
    "styleSamples",
    "styleDiagnosis",
    "signature",
    "draftLog",
  ]);

  // Display which account these per-account settings belong to.
  const acctLine = document.getElementById("account-line");
  if (acctLine) {
    acctLine.hidden = false;
    acctLine.textContent = t("optionsAccountLine", [currentAccount]);
  }

  setProvider(global.provider || "claude");
  if (global.claudeModel) els.claudeModel.value = global.claudeModel;
  if (global.openaiModel) els.openaiModel.value = global.openaiModel;
  els.apiKey.value = global.apiKey || "";
  els.defaultStyle.value = global.defaultStyle || "professional";
  els.autoDraft.checked = global.autoDraft !== false;
  els.styleEnabled.checked = global.styleSamplesEnabled !== false;
  els.signatureEnabled.checked = global.signatureEnabled !== false;
  els.coachEnabled.checked = global.coachEnabled === true;
  if (els.uiLanguage) {
    els.uiLanguage.value =
      global.uiLanguage === "en" || global.uiLanguage === "zh_CN"
        ? global.uiLanguage
        : "auto";
  }
  renderSamples(Array.isArray(acct.styleSamples) ? acct.styleSamples : []);
  renderDiagnosis(acct.styleDiagnosis);
  renderSignature(acct.signature);
  renderStats(global.stats, els.statsPeriod?.value || "30");
  renderHistory(Array.isArray(acct.draftLog) ? acct.draftLog : []);
}

function renderHistory(entries) {
  if (!els.historyList) return;
  const sorted = [...entries].sort((a, b) => (b.at || 0) - (a.at || 0));
  els.historyCount.textContent = t("historyCount", [String(sorted.length)]);
  if (!sorted.length) {
    els.historyEmpty.hidden = false;
    els.historyList.hidden = true;
    els.historyList.innerHTML = "";
    return;
  }
  els.historyEmpty.hidden = true;
  els.historyList.hidden = false;
  els.historyList.innerHTML = "";

  const styleEmoji = { professional: "🎩", warm: "🤝", confident: "⚡" };
  const styleLabel = {
    professional: t("styleProfessional"),
    warm: t("styleWarm"),
    confident: t("styleConfident"),
  };

  for (const entry of sorted) {
    const wrap = document.createElement("div");
    wrap.className = "history-item";
    wrap.title = t("historyClickToCopy");

    const meta = document.createElement("div");
    meta.className = "history-meta";

    const pill = document.createElement("span");
    pill.className = "history-style-pill";
    pill.textContent = `${styleEmoji[entry.style] || ""} ${styleLabel[entry.style] || entry.style}`;
    meta.appendChild(pill);

    const time = document.createElement("span");
    time.textContent = formatRelativeTime(entry.at);
    meta.appendChild(time);

    if (entry.senderName || entry.sender) {
      const who = document.createElement("span");
      who.textContent = `↪ ${entry.senderName || entry.sender}`;
      meta.appendChild(who);
    }

    wrap.appendChild(meta);

    if (entry.subject) {
      const subj = document.createElement("div");
      subj.className = "history-subject";
      subj.textContent = entry.subject;
      wrap.appendChild(subj);
    }

    const snippet = document.createElement("div");
    snippet.className = "history-snippet";
    snippet.textContent = entry.text;
    wrap.appendChild(snippet);

    wrap.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(entry.text);
        setStatus(t("historyCopied"), "success");
      } catch {
        setStatus(t("copyFailed"), "error");
      }
    });

    els.historyList.appendChild(wrap);
  }
}

function formatRelativeTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return t("timeJustNow");
  if (diff < 3600) return t("timeMinutesAgo", [String(Math.floor(diff / 60))]);
  if (diff < 86400) return t("timeHoursAgo", [String(Math.floor(diff / 3600))]);
  if (diff < 86400 * 7) return t("timeDaysAgo", [String(Math.floor(diff / 86400))]);
  return d.toLocaleDateString();
}

// Aggregate per-day stats over the selected window and render the dashboard.
// `period` is "7", "30", or "all". Time-saved estimate uses 90s per draft.
function renderStats(stats, period) {
  if (!els.statDrafts) return;
  const all = stats && typeof stats === "object" ? stats : {};

  let cutoff = null;
  if (period !== "all") {
    const days = parseInt(period, 10) || 30;
    const d = new Date();
    d.setDate(d.getDate() - days + 1);
    cutoff = d.toISOString().slice(0, 10);
  }

  const sum = { decoder: 0, drafts: 0, refines: 0, tones: 0, inserts: 0, byStyle: {} };
  for (const day of Object.keys(all)) {
    if (cutoff && day < cutoff) continue;
    const v = all[day] || {};
    sum.decoder += v.decoder || 0;
    sum.drafts += v.drafts || 0;
    sum.refines += v.refines || 0;
    sum.tones += v.tones || 0;
    sum.inserts += v.inserts || 0;
    for (const s of Object.keys(v.byStyle || {})) {
      sum.byStyle[s] = (sum.byStyle[s] || 0) + v.byStyle[s];
    }
  }

  els.statDrafts.textContent = String(sum.drafts);
  els.statRefines.textContent = String(sum.refines);
  els.statInserts.textContent = String(sum.inserts);

  // Time-saved estimate: 90s per draft saved (typing) + 60s per refine saved
  // (back-and-forth) + 45s per tone check (proof-reading).
  const seconds = sum.drafts * 90 + sum.refines * 60 + sum.tones * 45;
  els.statTimeSaved.textContent = formatDuration(seconds);

  // Per-style pills (only non-zero).
  els.statStyleRow.innerHTML = "";
  const styles = [
    ["professional", "🎩", t("styleProfessional")],
    ["warm", "🤝", t("styleWarm")],
    ["confident", "⚡", t("styleConfident")],
  ];
  for (const [key, emoji, label] of styles) {
    const n = sum.byStyle[key] || 0;
    if (n === 0) continue;
    const pill = document.createElement("span");
    pill.className = "stat-style-pill";
    pill.innerHTML = `${emoji} ${label} <strong>${n}</strong>`;
    els.statStyleRow.appendChild(pill);
  }
}

function formatDuration(seconds) {
  if (!seconds || seconds < 60) return `${seconds || 0} sec`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return t("statMinutes", [String(min)]);
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (remMin === 0) return t("statHours", [String(hr)]);
  return t("statHoursMinutes", [String(hr), String(remMin)]);
}

function renderSignature(sig) {
  if (!els.signatureBlock) return;
  if (!sig || typeof sig !== "string" || !sig.trim()) {
    els.signatureBlock.hidden = true;
    els.signatureText.textContent = "";
    return;
  }
  els.signatureBlock.hidden = false;
  els.signatureText.textContent = sig;
}

function renderDiagnosis(diagnosis) {
  if (!els.styleDiagnosis) return;
  const text = diagnosis?.text;
  if (!text) {
    els.styleDiagnosis.hidden = true;
    els.styleDiagnosisText.textContent = "";
    return;
  }
  els.styleDiagnosis.hidden = false;
  els.styleDiagnosisText.textContent = text;
}

function renderSamples(samples) {
  els.styleCount.textContent = t("styleCount", [String(samples.length)]);
  if (!samples.length) {
    els.styleList.hidden = true;
    els.styleList.innerHTML = "";
    return;
  }
  els.styleList.hidden = false;
  els.styleList.innerHTML = "";
  for (const s of samples) {
    const div = document.createElement("div");
    div.className = "style-list-item";
    div.textContent = s;
    els.styleList.appendChild(div);
  }
}

els.clearSamples.addEventListener("click", async () => {
  await acctSet({ styleSamples: [], styleDiagnosis: null, signature: null });
  renderSamples([]);
  renderDiagnosis(null);
  renderSignature(null);
  setStatus(t("optionsClearedSamples"), "success");
});

els.styleEnabled.addEventListener("change", async () => {
  await chrome.storage.local.set({ styleSamplesEnabled: els.styleEnabled.checked });
});

els.clearHistory?.addEventListener("click", async () => {
  await acctSet({ draftLog: [] });
  renderHistory([]);
  setStatus(t("historyCleared"), "success");
});

els.statsPeriod?.addEventListener("change", async () => {
  const { stats } = await chrome.storage.local.get("stats");
  renderStats(stats, els.statsPeriod.value);
});

els.signatureEnabled.addEventListener("change", async () => {
  await chrome.storage.local.set({ signatureEnabled: els.signatureEnabled.checked });
});

els.coachEnabled.addEventListener("change", async () => {
  await chrome.storage.local.set({ coachEnabled: els.coachEnabled.checked });
});

// Interface language — store the choice and reload the page so every string
// (static + dynamic) re-renders in the new language. The sidebar reacts via
// its own chrome.storage.onChanged listener.
els.uiLanguage?.addEventListener("change", async () => {
  await chrome.storage.local.set({ uiLanguage: els.uiLanguage.value });
  location.reload();
});

async function save() {
  const provider = getProvider();
  const apiKey = els.apiKey.value.trim();
  const defaultStyle = els.defaultStyle.value;
  const autoDraft = els.autoDraft.checked;

  if (!apiKey) {
    setStatus(t("optionsSaveEmpty"), "error");
    return;
  }

  await chrome.storage.local.set({
    provider,
    apiKey,
    defaultStyle,
    autoDraft,
    claudeModel: els.claudeModel.value,
    openaiModel: els.openaiModel.value,
  });
  setStatus(t("optionsSaved"), "success");
}

async function testConnection() {
  const provider = getProvider();
  const apiKey = els.apiKey.value.trim();

  if (!apiKey) {
    setStatus(t("optionsTestEmpty"), "error");
    return;
  }

  setStatus(t("optionsTesting"));
  els.test.disabled = true;

  try {
    const ok = await pingProvider(provider, apiKey);
    if (ok) setStatus(t("optionsTestOk"), "success");
    else setStatus(t("errGeneric"), "error");
  } catch (err) {
    setStatus(humanizeError(err.message || String(err)), "error");
  } finally {
    els.test.disabled = false;
  }
}

async function pingProvider(provider, apiKey) {
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: els.openaiModel.value,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (!res.ok) throw new Error(`API_ERROR_${res.status}`);
    return true;
  }

  // Claude default
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: els.claudeModel.value,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  if (!res.ok) throw new Error(`API_ERROR_${res.status}`);
  return true;
}

function humanizeError(code) {
  if (code === "API_ERROR_401") return t("err401");
  if (code === "API_ERROR_429") return t("err429");
  if (code.startsWith("API_ERROR_5")) return t("err5xx");
  if (code.startsWith("API_ERROR_")) return `${t("errGeneric")} (${code.replace("API_ERROR_", "HTTP ")})`;
  return t("errNetwork");
}

els.toggleKey.addEventListener("click", () => {
  const showing = els.apiKey.type === "text";
  els.apiKey.type = showing ? "password" : "text";
  els.toggleKey.textContent = showing ? t("optionsShow") : t("optionsHide");
});

els.save.addEventListener("click", save);
els.test.addEventListener("click", testConnection);

// Startup: load the chosen UI locale first, then translate + populate.
(async () => {
  await initI18n();
  document.title = t("extName") + " — " + t("settings");
  applyI18n();
  await load();
})();

// Live-update sample list if user saves more in the sidebar while Options is
// open in another tab.
chrome.storage.onChanged.addListener((changes) => {
  // If the active account switched while Options is open, reload everything.
  if (changes.lastActiveAccount) {
    const newAcct = changes.lastActiveAccount.newValue;
    if (typeof newAcct === "string" && newAcct !== currentAccount) {
      currentAccount = newAcct;
      load();
      return;
    }
  }
  // Live-update stats whenever the sidebar bumps a counter.
  if (changes.stats) {
    renderStats(changes.stats.newValue, els.statsPeriod?.value || "30");
  }

  // Per-account changes come in with namespaced keys (acct0__styleSamples).
  for (const key of Object.keys(changes)) {
    const m = key.match(/^acct(\d+)__(.+)$/);
    if (!m) continue;
    if (m[1] !== currentAccount) continue;
    const inner = m[2];
    if (inner === "styleSamples") {
      const v = changes[key].newValue;
      renderSamples(Array.isArray(v) ? v : []);
    } else if (inner === "styleDiagnosis") {
      renderDiagnosis(changes[key].newValue);
    } else if (inner === "signature") {
      renderSignature(changes[key].newValue);
    } else if (inner === "draftLog") {
      const v = changes[key].newValue;
      renderHistory(Array.isArray(v) ? v : []);
    }
  }
});
