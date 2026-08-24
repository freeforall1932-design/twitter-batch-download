// ==========================================================================
// popup.js — Bulk controls: max items, media filter, scroll speed, start/stop
// ==========================================================================

const startBtn = document.getElementById("startBtn");
const openPanelBtn = document.getElementById("openPanelBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const warningEl = document.getElementById("warning");
const maxMediaInput = document.getElementById("maxMedia");
const mediaFilterSelect = document.getElementById("mediaFilter");
const scrollSpeedSelect = document.getElementById("scrollSpeed");

// Load saved settings
chrome.storage.local.get(["maxMedia", "scrollSpeed", "mediaFilter"], (data) => {
  if (data.maxMedia) maxMediaInput.value = data.maxMedia;
  if (data.scrollSpeed) scrollSpeedSelect.value = data.scrollSpeed;
  if (data.mediaFilter) mediaFilterSelect.value = data.mediaFilter;
});

// Poll status from content script
function pollStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: "getStatus" }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      statusEl.textContent = resp.text;
      statusEl.className = "status " + resp.state;
    });
  });
}

setInterval(pollStatus, 1000);
pollStatus();

openPanelBtn.addEventListener("click", () => {
  chrome.windows.getCurrent((window) => chrome.sidePanel.open({ windowId: window.id }));
});

// Start button
startBtn.addEventListener("click", () => {
  const maxMedia = parseInt(maxMediaInput.value) || 9999;
  const scrollSpeed = scrollSpeedSelect.value;
  const mediaFilter = mediaFilterSelect.value;

  chrome.storage.local.set({ maxMedia, scrollSpeed, mediaFilter });

  // Show warning for fast speed
  warningEl.style.display = "none";
  if (scrollSpeed === "fast") {
    warningEl.textContent = "Fast speed may trigger rate limits. Use slow/medium for reliability.";
    warningEl.style.display = "block";
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    const url = tabs[0].url || "";
    if (!url.includes("x.com") && !url.includes("twitter.com")) {
      statusEl.textContent = "Not on X/Twitter! Navigate there first.";
      statusEl.className = "status stopped";
      return;
    }

    const payload = {
      action: "start",
      maxMedia,
      scrollSpeed,
      mediaFilter
    };

    chrome.tabs.sendMessage(tabs[0].id, payload, (resp) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Reloading page to inject script...";
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          files: ["content.js"]
        }, () => {
          setTimeout(() => {
            chrome.tabs.sendMessage(tabs[0].id, payload);
          }, 500);
        });
        return;
      }
      if (resp && !resp.ok) {
        statusEl.textContent = resp.reason || "Could not start";
        statusEl.className = "status stopped";
        return;
      }
      pollStatus();
    });
  });

  statusEl.textContent = "Starting...";
  statusEl.className = "status running";
});

// Stop button
stopBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: "stop" });
  });
  statusEl.textContent = "Stopped";
  statusEl.className = "status stopped";
  warningEl.style.display = "none";
});
