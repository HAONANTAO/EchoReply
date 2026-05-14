// Inserts a generated draft into Gmail's compose box.
// Gmail compose is a contenteditable div, not a real textarea — execCommand is
// still the most reliable cross-flavour way to push text in and have Gmail's
// internal listeners fire correctly.
//
// If no compose box is currently visible, we look for Gmail's "Reply" button,
// click it, then wait for the compose box to mount before inserting. This
// removes the need for the user to manually click Reply first.

const COMPOSE_SELECTORS = [
  '[role="textbox"][aria-label*="Message"]',
  '[role="textbox"][aria-label*="Body"]',
  '[role="textbox"][g_editable="true"]',
];

const REPLY_BUTTON_SELECTORS = [
  '[role="button"][aria-label^="Reply"]',
  '[role="button"][aria-label^="回复"]',
  '[role="button"][aria-label^="回覆"]',
  '[role="link"][aria-label^="Reply"]',
  '[data-tooltip^="Reply"]',
  'span.ams.bkH',
];

const REPLY_ALL_BUTTON_SELECTORS = [
  '[role="button"][aria-label^="Reply all"]',
  '[role="button"][aria-label^="Reply to all"]',
  '[role="button"][aria-label^="全部回复"]',
  '[role="button"][aria-label^="回覆所有人"]',
  '[data-tooltip^="Reply all"]',
  '[data-tooltip^="Reply to all"]',
  'span.ams.bkI',
];

function findComposeBox() {
  for (const sel of COMPOSE_SELECTORS) {
    const node = document.querySelector(sel);
    if (node) return node;
  }
  return null;
}

function findButton(selectorList) {
  for (const sel of selectorList) {
    // Prefer one inside the open conversation pane so we don't grab a stale
    // button from a closed thread that's still cached in the DOM.
    const inMain = document.querySelector(`[role="main"] ${sel}`);
    if (inMain && isVisible(inMain)) return inMain;
    const anywhere = document.querySelector(sel);
    if (anywhere && isVisible(anywhere)) return anywhere;
  }
  return null;
}

function findReplyButton() {
  return findButton(REPLY_BUTTON_SELECTORS);
}

function findReplyAllButton() {
  return findButton(REPLY_ALL_BUTTON_SELECTORS);
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// Wait up to `timeoutMs` for the compose box to appear after we click Reply.
// Resolves with the element, or null on timeout.
function waitForComposeBox(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const existing = findComposeBox();
    if (existing) return resolve(existing);

    let settled = false;
    const observer = new MutationObserver(() => {
      const node = findComposeBox();
      if (node) {
        settled = true;
        observer.disconnect();
        resolve(node);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      if (!settled) {
        observer.disconnect();
        resolve(null);
      }
    }, timeoutMs);
  });
}

function writeIntoCompose(composeBox, text) {
  composeBox.focus();

  // Place caret at start so we prepend our draft rather than appending to any
  // existing signature/quoted text.
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(composeBox);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // execCommand is deprecated but is still the path that Gmail recognises for
  // contenteditable inserts — InputEvent("insertText") falls through silently.
  document.execCommand("insertText", false, text);
  composeBox.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

export async function insertDraftIntoCompose(text, { replyAll = false } = {}) {
  let composeBox = findComposeBox();

  if (!composeBox) {
    // No compose visible — try to click Reply / Reply All ourselves.
    const btn = replyAll
      ? findReplyAllButton() || findReplyButton()
      : findReplyButton();
    if (!btn) return false;

    btn.click();
    composeBox = await waitForComposeBox(1500);
    if (!composeBox) return false;
  }

  writeIntoCompose(composeBox, text);
  return true;
}
