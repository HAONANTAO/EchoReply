// EchoReply service worker.
// The extension's runtime lives in content.js + sidebar.js. The toolbar icon
// opens popup/popup.html (set via manifest action.default_popup), which is
// the discoverable entry point to the Settings page.
//
// The sidebar (running in the content script's ISOLATED world) cannot call
// chrome.runtime.openOptionsPage() directly — that API is unavailable in
// content scripts. It sends an "openOptionsPage" message instead.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "openOptionsPage") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
});
