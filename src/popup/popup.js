import { PROVIDER_LABELS } from "../shared/constants.js";
import { getConversations, getSettings, hasApiKey } from "../shared/storage.js";

const providerEl = document.querySelector("#provider");
const modelEl = document.querySelector("#model");
const apiKeyEl = document.querySelector("#apiKey");
const historyCountEl = document.querySelector("#historyCount");

document.querySelector("#openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.querySelector("#openHistory").addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("src/history/history.html")
  });
});

init();

async function init() {
  const [settings, conversations] = await Promise.all([
    getSettings(),
    getConversations()
  ]);
  const provider = settings.provider;
  providerEl.textContent = PROVIDER_LABELS[provider] || provider;
  modelEl.textContent = settings[provider]?.model || "-";
  apiKeyEl.textContent = hasApiKey(settings, provider) ? "已配置" : "未配置";
  historyCountEl.textContent = String(conversations.length);
}
