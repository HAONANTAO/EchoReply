// i18n helper with a manual UI-language override.
//
// Chrome's __MSG_*__ placeholders only work in manifest.json/CSS, and
// chrome.i18n.getMessage() is locked to the browser locale. To let the user
// pick the interface language independently, we:
//   1. read `uiLanguage` from chrome.storage.local ("auto" | "en" | "zh_CN")
//   2. when it's a specific locale, fetch that locale's messages.json
//      ourselves and resolve messages manually
//   3. when it's "auto" (or unset), fall back to chrome.i18n.getMessage()
//
// initI18n() must be awaited before the first t() / applyI18nTo() call.

let activeMessages = null; // parsed messages.json for the forced locale, or null

export async function initI18n() {
  activeMessages = null;
  let pref = "auto";
  try {
    const { uiLanguage } = await chrome.storage.local.get("uiLanguage");
    if (uiLanguage === "en" || uiLanguage === "zh_CN") pref = uiLanguage;
  } catch {
    // storage unavailable — stay on auto
  }
  if (pref === "auto") return;

  try {
    const url = chrome.runtime.getURL(`_locales/${pref}/messages.json`);
    const res = await fetch(url);
    activeMessages = await res.json();
  } catch {
    activeMessages = null; // fall back to chrome.i18n
  }
}

// Resolve a chrome-format message entry with optional $1/$2 substitutions.
function resolveMessage(entry, subs) {
  let msg = entry?.message || "";

  // Named placeholders: $NAME$ → its `content` ($1 etc). Case-insensitive,
  // matching chrome.i18n behaviour.
  if (entry?.placeholders) {
    for (const [name, def] of Object.entries(entry.placeholders)) {
      const re = new RegExp("\\$" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\$", "gi");
      msg = msg.replace(re, def?.content ?? "");
    }
  }

  // Positional substitutions: $1, $2, ...
  if (subs != null) {
    const arr = Array.isArray(subs) ? subs : [subs];
    msg = msg.replace(/\$(\d+)/g, (_, n) => {
      const v = arr[Number(n) - 1];
      return v == null ? "" : String(v);
    });
  }
  return msg;
}

export function t(key, substitutions) {
  // Forced-locale path.
  if (activeMessages && activeMessages[key]) {
    return resolveMessage(activeMessages[key], substitutions);
  }
  // Auto / fallback → browser-locale chrome.i18n.
  if (typeof chrome !== "undefined" && chrome.i18n) {
    const msg = chrome.i18n.getMessage(key, substitutions);
    if (msg) return msg;
  }
  return key;
}

// Walk the DOM and fill in any element tagged with i18n data-attributes.
//   data-i18n="key"             → textContent
//   data-i18n-placeholder="key" → placeholder attribute
//   data-i18n-title="key"       → title attribute
//   data-i18n-aria-label="key"  → aria-label attribute
export function applyI18nTo(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const msg = t(el.getAttribute("data-i18n"));
    if (msg) el.textContent = msg;
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    const msg = t(el.getAttribute("data-i18n-placeholder"));
    if (msg) el.setAttribute("placeholder", msg);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const msg = t(el.getAttribute("data-i18n-title"));
    if (msg) el.setAttribute("title", msg);
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    const msg = t(el.getAttribute("data-i18n-aria-label"));
    if (msg) el.setAttribute("aria-label", msg);
  }
}
