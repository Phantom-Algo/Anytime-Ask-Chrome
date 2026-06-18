import {
  DEFAULT_SETTINGS,
  MAX_HISTORY_ITEMS,
  MCP_TRANSPORTS,
  STORAGE_KEYS
} from "./constants.js";

export function mergeSettings(settings = {}) {
  return {
    provider: settings.provider || DEFAULT_SETTINGS.provider,
    allowedUrlPrefixes: normalizeAllowedUrlPrefixes(
      Array.isArray(settings.allowedUrlPrefixes)
        ? settings.allowedUrlPrefixes
        : DEFAULT_SETTINGS.allowedUrlPrefixes
    ),
    mcpServers: normalizeMcpServers(
      settings.mcpServers || settings.mcp || DEFAULT_SETTINGS.mcpServers
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

export function parseMcpServersJson(value) {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`MCP JSON 格式无效：${error.message || String(error)}`);
  }

  return normalizeMcpServers(parsed, { strict: true });
}

export function stringifyMcpServers(servers = []) {
  const normalized = normalizeMcpServers(servers);
  const mcpServers = {};

  for (const server of normalized) {
    mcpServers[server.id] = serializeMcpServer(server);
  }

  return JSON.stringify({ mcpServers }, null, 2);
}

export function normalizeMcpServers(value = [], options = {}) {
  const entries = readMcpServerEntries(value, options);
  const normalized = [];
  const seenIds = new Set();

  for (const [fallbackId, server] of entries) {
    const next = normalizeMcpServer(fallbackId, server, options);
    if (!next) {
      continue;
    }

    if (seenIds.has(next.id)) {
      if (options.strict) {
        throw new Error(`MCP 配置存在重复 id：${next.id}`);
      }
      continue;
    }

    seenIds.add(next.id);
    normalized.push(next);
  }

  return normalized;
}

export function normalizeMcpServerIds(ids = [], servers = []) {
  const available = new Set(
    normalizeMcpServers(servers)
      .filter((server) => server.enabled !== false)
      .map((server) => server.id)
  );

  const normalized = Array.isArray(ids)
    ? ids.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  return [...new Set(normalized)].filter((id) => available.has(id));
}

export function getConversationMcpServers(settings, conversation) {
  const selectedIds = new Set(
    normalizeMcpServerIds(conversation?.mcpServerIds, settings?.mcpServers)
  );

  return normalizeMcpServers(settings?.mcpServers || []).filter(
    (server) => server.enabled !== false && selectedIds.has(server.id)
  );
}

export function getPublicMcpServers(settings) {
  return normalizeMcpServers(settings?.mcpServers || [])
    .filter((server) => server.enabled !== false)
    .map((server) => ({
      id: server.id,
      name: server.name,
      type: server.type,
      description: server.description || ""
    }));
}

function readMcpServerEntries(value, options = {}) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((server, index) => [
      server?.id || server?.name || `mcp-${index + 1}`,
      server
    ]);
  }

  if (typeof value !== "object") {
    if (options.strict) {
      throw new Error("MCP 配置必须是 JSON 对象或数组。");
    }
    return [];
  }

  const container = value.mcpServers || value.servers || value;
  if (Array.isArray(container)) {
    return container.map((server, index) => [
      server?.id || server?.name || `mcp-${index + 1}`,
      server
    ]);
  }

  if (!container || typeof container !== "object") {
    if (options.strict) {
      throw new Error("MCP servers 必须是对象或数组。");
    }
    return [];
  }

  return Object.entries(container);
}

function normalizeMcpServer(fallbackId, server, options = {}) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return invalidMcpConfig(`MCP server ${fallbackId || ""} 必须是对象。`, options);
  }

  const id = normalizeMcpId(server.id || fallbackId || server.name);
  if (!id) {
    return invalidMcpConfig("MCP server 缺少 id。", options);
  }

  const type = normalizeMcpTransport(
    server.type || server.transport || server.mode || (server.url ? "sse" : "stdio")
  );
  if (!type) {
    return invalidMcpConfig(`MCP server ${id} 的 type 仅支持 stdio 或 sse。`, options);
  }

  const name = String(server.name || fallbackId || id).trim() || id;
  const base = {
    id,
    name,
    type,
    enabled: server.enabled !== false,
    description: String(server.description || "").trim()
  };

  if (type === MCP_TRANSPORTS.stdio) {
    const command = String(server.command || "").trim();
    if (!command) {
      return invalidMcpConfig(`MCP server ${id} 使用 stdio 时必须配置 command。`, options);
    }

    return {
      ...base,
      command,
      args: normalizeStringArray(server.args),
      env: normalizeStringRecord(server.env),
      cwd: String(server.cwd || "").trim()
    };
  }

  const url = normalizeMcpSseUrl(server.url);
  if (!url) {
    return invalidMcpConfig(`MCP server ${id} 使用 sse 时必须配置有效的 http(s) url。`, options);
  }

  return {
    ...base,
    url,
    headers: normalizeStringRecord(server.headers)
  };
}

function serializeMcpServer(server) {
  const base = {
    type: server.type,
    name: server.name,
    enabled: server.enabled !== false
  };

  if (server.description) {
    base.description = server.description;
  }

  if (server.type === MCP_TRANSPORTS.stdio) {
    return {
      ...base,
      command: server.command,
      args: server.args || [],
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: server.env } : {})
    };
  }

  return {
    ...base,
    url: server.url,
    ...(server.headers && Object.keys(server.headers).length
      ? { headers: server.headers }
      : {})
  };
}

function normalizeMcpId(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 80);
}

function normalizeMcpTransport(value) {
  const transport = String(value || "").trim().toLowerCase();
  if (transport === MCP_TRANSPORTS.stdio || transport === MCP_TRANSPORTS.sse) {
    return transport;
  }
  return "";
}

function normalizeMcpSseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    return url.href;
  } catch {
    return "";
  }
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.length > 0)
    : [];
}

function normalizeStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((record, [key, item]) => {
    const normalizedKey = String(key || "").trim();
    if (normalizedKey) {
      record[normalizedKey] = String(item);
    }
    return record;
  }, {});
}

function invalidMcpConfig(message, options = {}) {
  if (options.strict) {
    throw new Error(message);
  }
  return null;
}
