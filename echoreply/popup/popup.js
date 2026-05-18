// Popup shown when the toolbar icon is clicked.
// Provides a clear, always-visible entry point to the Settings page and Gmail.

import { initI18n, applyI18nTo } from "../lib/i18n.js";

async function main() {
  await initI18n();
  applyI18nTo(document);

  document.getElementById("open-settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  document.getElementById("open-gmail").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://mail.google.com/" });
    window.close();
  });
}

main();
