import { DEFAULT_SETTINGS, MAX_HISTORY_ITEMS, STORAGE_KEYS } from "./constants.js";

export function mergeSettings(settings = {}) {
  return {
    provider: settings.provider || DEFAULT_SETTINGS.provider,
    allowedUrlPrefixes: normalizeAllowedUrlPrefixes(
      Array.isArray(settings.allowedUrlPrefixes)
        ? settings.allowedUrlPrefixes
        : DEFAULT_SETTINGS.allowedUrlPrefixes
    ),
    openai: {
      ...DEFAULT_SETTINGS.openai,
      ...(settings.openai || {})
    },
    anthropic: {
      ...DEFAULT_SETTINGS.anthropic,
      ...(settings.anthropic || {})
    },
    deepseek: {
      ...DEFAULT_SETTINGS.deepseek,
      ...(settings.deepseek || {})
    }
  };
}

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return mergeSettings(result[STORAGE_KEYS.settings]);
}

export async function saveSettings(settings) {
  const merged = mergeSettings(settings);
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: merged
  });
  return merged;
}

export async function getConversations() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.conversations);
  const conversations = result[STORAGE_KEYS.conversations];
  return Array.isArray(conversations) ? conversations : [];
}

export async function getConversation(id) {
  const conversations = await getConversations();
  return conversations.find((conversation) => conversation.id === id) || null;
}

export async function saveConversation(conversation) {
  const conversations = await getConversations();
  const next = [
    conversation,
    ...conversations.filter((item) => item.id !== conversation.id)
  ]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_HISTORY_ITEMS);

  await chrome.storage.local.set({
    [STORAGE_KEYS.conversations]: next
  });

  return conversation;
}

export async function deleteConversation(id) {
  const conversations = await getConversations();
  await chrome.storage.local.set({
    [STORAGE_KEYS.conversations]: conversations.filter((item) => item.id !== id)
  });
}

export async function clearConversations() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.conversations]: []
  });
}

export function hasApiKey(settings, provider = settings.provider) {
  return Boolean(settings?.[provider]?.apiKey?.trim());
}

export function getActiveProviderConfig(settings) {
  const merged = mergeSettings(settings);
  return merged[merged.provider];
}

export function normalizeAllowedUrlPrefixes(prefixes = []) {
  const normalized = prefixes
    .map((prefix) => normalizeAllowedUrlPrefix(prefix))
    .filter(Boolean);

  return [...new Set(normalized)];
}

export function normalizeAllowedUrlPrefix(prefix) {
  const value = String(prefix || "").trim();
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

export function isUrlAllowedByPrefixes(url, prefixes = []) {
  let current;
  try {
    current = new URL(url).href;
  } catch {
    return false;
  }

  return normalizeAllowedUrlPrefixes(prefixes).some((prefix) =>
    current.startsWith(prefix)
  );
}
