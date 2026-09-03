// ==========================================================================
// popup.js — Side Panel launcher.
//
// The popup no longer runs a second scroll/download loop. Scroll capture in
// the Side Panel is the single surface: two competing engines meant the popup
// could scroll a page while the panel was mid-capture, and the popup loop
// blocked scrolling on each download.
// ==========================================================================

const _api = typeof browser !== 'undefined' ? browser : chrome;
const openPanelBtn = document.getElementById("openPanelBtn");
const statusEl = document.getElementById("status");

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function refreshStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    const url = tab?.url || "";
    if (!url.includes("x.com") && !url.includes("twitter.com")) {
      setStatus("Open an X/Twitter tab, then open the queue.", "warn");
      return;
    }
    chrome.tabs.sendMessage(tab.id, { action: "scrollStatus" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        setStatus("Refresh this X tab so capture can start.", "warn");
        return;
      }
      setStatus(response.text || "Capturing this tab.", "ok");
    });
  });
}

openPanelBtn.addEventListener("click", () => {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  if (api.sidebarAction && api.sidebarAction.open) {
    api.sidebarAction.open().then(() => window.close()).catch(() => window.close());
    return;
  }
  if (api.sidePanel && api.sidePanel.open) {
    api.windows.getCurrent((currentWindow) => {
      api.sidePanel.open({ windowId: currentWindow.id }).then(() => window.close()).catch(() => window.close());
    });
    return;
  }
  window.close();
});

refreshStatus();
setInterval(refreshStatus, 1500);
