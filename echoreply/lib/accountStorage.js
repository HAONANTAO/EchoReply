// Multi-account-aware storage helpers.
//
// Gmail URLs look like /mail/u/<N>/... where N is the account index.
// EchoReply namespaces per-account data so multiple Gmail accounts in the
// same Chrome profile don't pollute each other's writing samples, signatures,
// or per-email cache.
//
// Per-account data:
//   styleSamples, styleDiagnosis, signature, emailCache_<id>
//
// Global data (stays unnamespaced):
//   provider, apiKey, defaultStyle, autoDraft, styleSamplesEnabled,
//   signatureEnabled, sidebarCollapsed, usage_<date>
//
// We also write lastActiveAccount whenever the sidebar boots so the Options
// page can read the right namespace.

const PER_ACCOUNT_KEYS = new Set([
  "styleSamples",
  "styleDiagnosis",
  "signature",
]);

const EMAIL_CACHE_PREFIX = "emailCache_";

export function detectAccountFromUrl() {
  const m = window.location.pathname.match(/\/mail\/u\/(\d+)\b/);
  return m ? m[1] : "0";
}

function isPerAccount(key) {
  return PER_ACCOUNT_KEYS.has(key) || key.startsWith(EMAIL_CACHE_PREFIX);
}

export function namespacedKey(account, key) {
  if (!isPerAccount(key)) return key;
  return `acct${account}__${key}`;
}

export async function acctGet(account, keys) {
  if (Array.isArray(keys)) {
    const map = keys.map((k) => ({ orig: k, ns: namespacedKey(account, k) }));
    const data = await chrome.storage.local.get(map.map((x) => x.ns));
    const out = {};
    for (const { orig, ns } of map) out[orig] = data[ns];
    return out;
  }
  if (typeof keys === "string") {
    const ns = namespacedKey(account, keys);
    const data = await chrome.storage.local.get(ns);
    return { [keys]: data[ns] };
  }
  return chrome.storage.local.get(keys);
}

export async function acctSet(account, obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    out[namespacedKey(account, k)] = obj[k];
  }
  return chrome.storage.local.set(out);
}

export async function acctRemove(account, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  return chrome.storage.local.remove(list.map((k) => namespacedKey(account, k)));
}

// Listen for storage changes and only fire when the change is for the given
// account. Returns the underlying chrome listener so you can detach if needed.
export function acctOnChanged(account, callback) {
  const listener = (changes, area) => {
    if (area && area !== "local") return;
    const mapped = {};
    for (const ns of Object.keys(changes)) {
      // Detect "acctN__originalKey" and unwrap to original key.
      const m = ns.match(/^acct(\d+)__(.+)$/);
      if (m) {
        if (m[1] !== account) continue;
        mapped[m[2]] = changes[ns];
      } else if (!isPerAccount(ns)) {
        mapped[ns] = changes[ns];
      }
    }
    if (Object.keys(mapped).length) callback(mapped);
  };
  chrome.storage.onChanged.addListener(listener);
  return listener;
}
