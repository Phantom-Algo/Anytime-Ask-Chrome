import { MESSAGE_TYPES, PROVIDER_LABELS, PROVIDERS } from "../shared/constants.js";
import {
  getSettings,
  mergeSettings,
  normalizeAllowedUrlPrefix,
  normalizeAllowedUrlPrefixes,
  parseMcpServersJson,
  stringifyMcpServers,
  saveSettings
} from "../shared/storage.js";

const providerSelect = document.querySelector("#provider");
const apiKeyInput = document.querySelector("#apiKey");
const baseUrlInput = document.querySelector("#baseUrl");
const modelInput = document.querySelector("#model");
const maxTokensInput = document.querySelector("#maxTokens");
const temperatureInput = document.querySelector("#temperature");
const temperatureRow = document.querySelector("#temperatureRow");
const deepseekFields = document.querySelector("#deepseekFields");
const thinkingEnabledInput = document.querySelector("#thinkingEnabled");
const reasoningEffortSelect = document.querySelector("#reasoningEffort");
const allowedUrlPrefixesInput = document.querySelector("#allowedUrlPrefixes");
const mcpConfigInput = document.querySelector("#mcpConfig");
const settingsForm = document.querySelector("#settingsForm");
const saveButton = document.querySelector("#saveButton");
const testButton = document.querySelector("#testButton");
const statusEl = document.querySelector("#status");

let draft = mergeSettings();
let activeProvider = draft.provider;

init();

async function init() {
  draft = await getSettings();
  activeProvider = draft.provider;
  renderProviderOptions();
  renderForm();
}

providerSelect.addEventListener("change", () => {
  syncDraftFromForm(activeProvider);
  draft.provider = providerSelect.value;
  activeProvider = draft.provider;
  renderForm();
  setStatus("");
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveCurrentSettings();
});

testButton.addEventListener("click", async () => {
  await testCurrentSettings();
});

function renderProviderOptions() {
  providerSelect.textContent = "";
  for (const [value, label] of Object.entries(PROVIDER_LABELS)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    providerSelect.appendChild(option);
  }
}

function renderForm() {
  providerSelect.value = activeProvider;
  const config = draft[activeProvider];
  apiKeyInput.value = config.apiKey || "";
  baseUrlInput.value = config.baseUrl || "";
  modelInput.value = config.model || "";
  maxTokensInput.value = config.maxTokens || 1200;
  temperatureInput.value = config.temperature ?? "";

  const isAnthropic = activeProvider === PROVIDERS.anthropic;
  temperatureRow.hidden = isAnthropic;
  deepseekFields.hidden = activeProvider !== PROVIDERS.deepseek;

  if (activeProvider === PROVIDERS.deepseek) {
    thinkingEnabledInput.checked = Boolean(config.thinkingEnabled);
    reasoningEffortSelect.value = config.reasoningEffort || "medium";
  }

  allowedUrlPrefixesInput.value = (draft.allowedUrlPrefixes || []).join("\n");
  mcpConfigInput.value = stringifyMcpServers(draft.mcpServers || []);
}

function syncDraftFromForm(providerName, options = {}) {
  const allowedUrlPrefixes = parseAllowedUrlPrefixes(
    allowedUrlPrefixesInput.value,
    options
  );
  const mcpServers = parseMcpConfigFromForm(options);
  const currentConfig = {
    ...draft[providerName],
    apiKey: apiKeyInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
    model: modelInput.value.trim(),
    maxTokens: Number(maxTokensInput.value) || 1200
  };

  if (providerName !== PROVIDERS.anthropic) {
    currentConfig.temperature =
      temperatureInput.value === "" ? "" : Number(temperatureInput.value);
  }

  if (providerName === PROVIDERS.deepseek) {
    currentConfig.thinkingEnabled = thinkingEnabledInput.checked;
    currentConfig.reasoningEffort = reasoningEffortSelect.value;
  }

  draft = mergeSettings({
    ...draft,
    allowedUrlPrefixes,
    mcpServers,
    [providerName]: currentConfig
  });
}

async function saveCurrentSettings() {
  setBusy(true);
  setStatus("正在保存...");

  try {
    syncDraftFromForm(activeProvider, { strict: true });
    await ensureHostPermission(draft[draft.provider].baseUrl);
    await ensureMcpHostPermissions(draft.mcpServers);
    draft = await saveSettings(draft);
    activeProvider = draft.provider;
    renderForm();
    setStatus("已保存。");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function testCurrentSettings() {
  setBusy(true);
  setStatus("正在测试配置...");

  try {
    syncDraftFromForm(activeProvider, { strict: true });
    await ensureHostPermission(draft[draft.provider].baseUrl);
    const response = await sendRuntimeMessage({
      type: MESSAGE_TYPES.testProvider,
      settings: draft
    });

    if (!response?.ok) {
      throw new Error(response?.error || "测试失败。");
    }

    setStatus(`测试成功：${response.reply}`);
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function ensureHostPermission(baseUrl) {
  const pattern = toPermissionPattern(baseUrl);
  if (!pattern || isBuiltInProviderHost(baseUrl)) {
    return true;
  }

  const granted = await chrome.permissions.request({
    origins: [pattern]
  });

  if (!granted) {
    throw new Error(`未授予访问 ${pattern} 的权限，无法请求该 Base URL。`);
  }

  return true;
}

async function ensureMcpHostPermissions(mcpServers = []) {
  const patterns = [
    ...new Set(
      (mcpServers || [])
        .filter((server) => server.type === "sse")
        .map((server) => toPermissionPattern(server.url))
        .filter(Boolean)
    )
  ];

  if (!patterns.length) {
    return true;
  }

  const granted = await chrome.permissions.request({
    origins: patterns
  });

  if (!granted) {
    throw new Error(`未授予 MCP SSE 访问权限：${patterns.join(", ")}`);
  }

  return true;
}

function toPermissionPattern(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Base URL 格式无效。");
  }

  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Base URL 仅支持 http 或 https。");
  }

  if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error("HTTP Base URL 仅允许 localhost 或 127.0.0.1。");
  }

  return `${url.protocol}//${url.hostname}/*`;
}

function isBuiltInProviderHost(baseUrl) {
  try {
    const { hostname } = new URL(baseUrl);
    return ["api.openai.com", "api.anthropic.com", "api.deepseek.com"].includes(hostname);
  } catch {
    return false;
  }
}

function parseAllowedUrlPrefixes(value, options = {}) {
  const rawPrefixes = String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  const invalid = rawPrefixes.filter((prefix) => !normalizeAllowedUrlPrefix(prefix));
  if (invalid.length > 0 && options.strict) {
    throw new Error(`URL 前缀格式无效：${invalid[0]}`);
  }

  return normalizeAllowedUrlPrefixes(rawPrefixes);
}

function parseMcpConfigFromForm(options = {}) {
  if (options.strict) {
    return parseMcpServersJson(mcpConfigInput.value);
  }

  try {
    return parseMcpServersJson(mcpConfigInput.value);
  } catch {
    return draft.mcpServers || [];
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        resolve({
          ok: false,
          error: runtimeError.message
        });
        return;
      }
      resolve(response);
    });
  });
}

function setBusy(isBusy) {
  saveButton.disabled = isBusy;
  testButton.disabled = isBusy;
}

function setStatus(message, tone = "default") {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}
