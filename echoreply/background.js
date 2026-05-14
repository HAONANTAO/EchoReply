// EchoReply service worker.
// Currently a placeholder — the extension's runtime lives in content.js + sidebar.js.
// Open the options page when the toolbar icon is clicked (no popup configured).
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
