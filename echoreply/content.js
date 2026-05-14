// EchoReply content script.
//
// Runs in Gmail's ISOLATED world so it has access to chrome.* APIs.
// Responsibilities:
//   1. Inject the sidebar HTML + CSS into mail.google.com
//   2. Dynamically import sidebar.js (which itself imports the lib/* modules)
//      so the whole sidebar runtime stays in the ISOLATED world. We use
//      dynamic import() of chrome-extension:// URLs because static
//      `import` statements aren't supported in content scripts.

const SIDEBAR_ID = "echoreply-sidebar-root";

async function injectSidebar() {
  if (document.getElementById(SIDEBAR_ID)) return;

  // Stylesheet — link element keeps the CSS in the document so all the .er-*
  // selectors apply to our injected nodes.
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("sidebar/sidebar.css");
  document.head.appendChild(link);

  // HTML — fetched as text, parsed, then appended. We avoid using innerHTML on
  // body directly because Gmail aggressively reflows body and we want a stable
  // root node we control.
  const html = await fetch(chrome.runtime.getURL("sidebar/sidebar.html")).then(
    (r) => r.text(),
  );

  const root = document.createElement("div");
  root.id = SIDEBAR_ID;
  root.innerHTML = html;
  document.body.appendChild(root);

  // Load the sidebar logic via dynamic import so it runs in the ISOLATED
  // world with chrome.* access. The module will pick up the DOM we just
  // appended via document.getElementById.
  try {
    const module = await import(chrome.runtime.getURL("sidebar/sidebar.js"));
    if (module && typeof module.init === "function") {
      module.init();
    }
  } catch (err) {
    console.error("[EchoReply] Failed to load sidebar module", err);
  }
}

if (document.readyState === "complete") {
  injectSidebar();
} else {
  window.addEventListener("load", injectSidebar, { once: true });
}
