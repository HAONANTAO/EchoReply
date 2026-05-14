// Gmail DOM scraping. Gmail's HTML is unstable across releases, so each field
// uses several fallbacks ordered most-specific → most-generic.
//
// Two extraction levels:
//   - extractCurrentEmail()  → just the open/latest message (back-compat)
//   - extractCurrentThread() → all messages in the current conversation,
//     with the latest message exposed as the "primary" target for replies.

// True when the user is currently viewing the Sent folder. Gmail uses URL
// hashes like #sent or #label/Sent — we match both.
export function isInSentFolder() {
  const hash = window.location.hash || "";
  return /^#sent/i.test(hash) || /^#label\/sent/i.test(hash);
}

// True when an individual email is currently open (vs list view).
export function isViewingSingleEmail() {
  const hash = window.location.hash || "";
  // Single-thread URLs include a slash after sent/inbox: #sent/<id>.
  return /^#sent\/[^/?]/i.test(hash) || /^#inbox\/[^/?]/i.test(hash);
}

// Returns the clickable thread rows on the currently visible message list
// (e.g. when the user is in the Sent or Inbox list view). Gmail renders
// rows as `<tr class="zA ...">` inside the conversation list table.
export function findListRows() {
  const main = document.querySelector('[role="main"]');
  if (!main) return [];
  // Filter to visible rows. Hidden/collapsed rows have zero height.
  return Array.from(main.querySelectorAll("tr.zA")).filter((r) => {
    const rect = r.getBoundingClientRect();
    return rect.height > 0;
  });
}

// Returns Gmail's "Back to list" button (the arrow icon in the top toolbar
// when viewing a single email). Selector covers a few labels Gmail uses.
export function findBackToListButton() {
  const main = document.querySelector('[role="main"]') || document;
  const sels = [
    '[role="button"][aria-label^="Back to"]',
    '[role="button"][aria-label^="返回"]',
    '[data-tooltip^="Back to"]',
    '[data-tooltip^="返回"]',
  ];
  for (const sel of sels) {
    const el = main.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// Heuristic: an email has multiple recipients (To/Cc) when its conversation
// footer shows a recipient count or its parsed addresses include ≥2 others.
// Returns true when the LAST message has multiple recipients besides the user.
export function threadHasMultipleRecipients() {
  const main = document.querySelector('[role="main"]');
  if (!main) return false;
  // Gmail renders the recipient list under .ajw / .hb / .iw — count visible
  // mailto-style spans. Conservative: only true when we see clear evidence.
  const recipientNodes = main.querySelectorAll(
    "[data-hovercard-id], [data-hovercard-owner-id], .g2",
  );
  // Account for sender being in the list too — multiple if >=3 unique values.
  const seen = new Set();
  for (const n of recipientNodes) {
    const v =
      n.getAttribute("data-hovercard-id") ||
      n.getAttribute("email") ||
      n.textContent?.trim();
    if (v) seen.add(v);
    if (seen.size >= 3) return true;
  }
  return false;
}

// Detect whether the current user was a primary recipient (To) or a CC.
// Returns "to" | "cc" | null. Gmail renders the recipient line as text like
// "to me", "to X, cc me", or "cc: me, X" depending on locale and layout —
// we look at the relative positions of the "cc" marker and "me".
function detectRecipientRole(emailNode) {
  if (!emailNode) return null;

  const candidates = [
    emailNode.querySelector(".iw"),
    emailNode.querySelector(".ajw"),
    emailNode.querySelector(".ix"),
    emailNode.querySelector(".hb"),
  ].filter(Boolean);

  for (const node of candidates) {
    const text = (node.innerText || node.textContent || "").trim();
    if (!text) continue;
    const lower = text.toLowerCase();

    // Look for the user's "me" marker (English default).
    const meIndex = lower.search(/\bme\b/);
    if (meIndex === -1) continue;

    // English "cc" + Chinese "抄送" / 副本 + variants.
    const ccMatch = lower.match(/\bcc\b|抄送|副本/);
    const ccIndex = ccMatch ? lower.indexOf(ccMatch[0]) : -1;

    if (ccIndex === -1) return "to";
    return meIndex > ccIndex ? "cc" : "to";
  }
  return null;
}

// Heuristic: is this an automated / no-reply sender? These addresses never
// expect a human reply (newsletters, alerts, receipts, notifications). We
// match common local-part patterns across the @.
const AUTOMATED_LOCALPART = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|alerts?|mailer|postmaster|bounce|updates?|news(letter)?|noreply|automated?|system|info|support[-_.]?bot)/i;

function isAutomatedSender(email) {
  if (!email || typeof email !== "string") return false;
  const at = email.indexOf("@");
  if (at === -1) return false;
  const local = email.slice(0, at).toLowerCase();
  return AUTOMATED_LOCALPART.test(local);
}

function extractMessageFromNode(node) {
  if (!node) return null;

  const sender =
    node.querySelector("[email]")?.getAttribute("email") ||
    node.querySelector(".gD")?.getAttribute("email") ||
    node.querySelector(".go")?.textContent?.trim() ||
    "unknown";

  const senderName =
    node.querySelector(".gD")?.getAttribute("name") ||
    node.querySelector("[email]")?.getAttribute("name") ||
    sender;

  const body =
    node.querySelector(".a3s.aiL")?.innerText?.trim() ||
    node.querySelector(".ii.gt")?.innerText?.trim() ||
    "";

  if (!body) return null;

  const id =
    node.getAttribute("data-message-id") ||
    node.dataset?.messageId ||
    `msg-${Date.now()}`;

  return {
    id,
    sender,
    senderName,
    body: body.slice(0, 4000),
  };
}

function getOpenSubject() {
  return document.querySelector("h2.hP")?.textContent?.trim() || "";
}

function findMessageNodes() {
  // Gmail renders each message in a thread as a separate .adn.ads container.
  // The data-message-id attribute appears on the same node (or a child) when
  // the message is fully expanded.
  const main = document.querySelector('[role="main"]') || document;
  const nodes = Array.from(
    main.querySelectorAll("[data-message-id], .adn.ads"),
  );
  // Filter to *visible* nodes only — collapsed ancestors render with 0
  // height and we want to skip those for "current open" detection.
  return nodes.filter((n) => {
    const rect = n.getBoundingClientRect();
    return rect.height > 0;
  });
}

export function extractCurrentEmail() {
  const nodes = findMessageNodes();
  if (!nodes.length) return null;

  // Use the last visible message as the "current" one — that's the message
  // the user is actively reading when they reply.
  const target = nodes[nodes.length - 1];
  const msg = extractMessageFromNode(target);
  if (!msg) return null;

  return {
    ...msg,
    subject: getOpenSubject(),
  };
}

// Returns the full thread context. Latest message's fields are spread at the
// top level so existing decoder/draft/tone-check prompts keep working without
// changes; `threadMessages` carries the full history when present.
export function extractCurrentThread() {
  const nodes = findMessageNodes();
  if (!nodes.length) return null;

  const messages = [];
  for (const node of nodes) {
    const msg = extractMessageFromNode(node);
    if (msg) messages.push(msg);
  }

  if (!messages.length) return null;

  // Detect whether the current user is on the To or CC line of the latest
  // message. Mostly affects draft brevity and reply strategy.
  const latestNode = nodes[nodes.length - 1];
  const recipientRole = detectRecipientRole(latestNode);

  const latest = messages[messages.length - 1];
  return {
    ...latest,
    subject: getOpenSubject(),
    threadMessages: messages,
    isThread: messages.length > 1,
    recipientRole, // "to" | "cc" | null
    isAutomated: isAutomatedSender(latest.sender),
  };
}

// Calls `callback(thread)` once per newly opened email/thread. Debounced via
// the __echoreplyLastEmailId marker to avoid re-firing on every mutation.
export function onEmailOpened(callback) {
  let pending = null;
  let observer = null;
  let observedRoot = null;

  const fire = () => {
    pending = null;
    const thread = extractCurrentThread();
    if (!thread) return;
    if (thread.id === window.__echoreplyLastEmailId) return;
    window.__echoreplyLastEmailId = thread.id;
    callback(thread);
  };

  const schedule = () => {
    if (pending) return;
    pending = setTimeout(fire, 150);
  };

  // We narrow the observed root to Gmail's [role="main"] node because that's
  // where conversation rendering happens. The full <body> sees thousands of
  // mutations per minute (chat sidebar, nav, ads) — most are irrelevant.
  // When [role="main"] doesn't exist yet (early page load), fall back to body
  // and re-attach later.
  const attach = () => {
    const main = document.querySelector('[role="main"]');
    const root = main || document.body;
    if (root === observedRoot) return;

    if (observer) observer.disconnect();
    observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    observedRoot = root;

    // If we just got the real [role="main"], also re-check immediately —
    // an email may already be visible.
    if (main) fire();
  };

  attach();
  // Re-attach when Gmail finishes mounting (it replaces large DOM chunks
  // during navigation, so [role="main"] may swap out).
  const reattachInterval = setInterval(attach, 1500);

  fire();

  return {
    disconnect() {
      if (observer) observer.disconnect();
      clearInterval(reattachInterval);
    },
  };
}
