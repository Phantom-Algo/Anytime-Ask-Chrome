const MCP_PROTOCOL_VERSION = "2025-06-18";
const NATIVE_HOST_NAME = "com.anytime_ask.mcp_bridge";
const MCP_REQUEST_TIMEOUT_MS = 120000;
const MAX_TOOL_RESULT_CHARS = 20000;

let nativeBridge = null;

export async function createMcpToolRuntime(servers = []) {
  const enabledServers = Array.isArray(servers)
    ? servers.filter((server) => server?.enabled !== false)
    : [];
  if (!enabledServers.length) {
    return null;
  }

  const runtime = new McpToolRuntime(enabledServers);
  try {
    await runtime.loadTools();
    if (runtime.hasTools()) {
      return runtime;
    }
    runtime.close();
    return null;
  } catch (error) {
    runtime.close();
    throw error;
  }
}

class McpToolRuntime {
  constructor(servers) {
    this.servers = servers;
    this.clients = new Map();
    this.toolRecords = new Map();
  }

  async loadTools() {
    for (const server of this.servers) {
      const client = createMcpClient(server);
      this.clients.set(server.id, client);
      await client.initialize();
      const result = await client.sendRequest("tools/list", {});
      const tools = Array.isArray(result?.tools) ? result.tools : [];

      for (const tool of tools) {
        if (!tool?.name) {
          continue;
        }

        const functionName = createToolFunctionName(
          server.id,
          tool.name,
          this.toolRecords
        );
        this.toolRecords.set(functionName, {
          functionName,
          server,
          client,
          tool
        });
      }
    }
  }

  hasTools() {
    return this.toolRecords.size > 0;
  }

  getOpenAiTools() {
    return [...this.toolRecords.values()].map((record) => ({
      type: "function",
      function: {
        name: record.functionName,
        description: buildToolDescription(record),
        parameters: normalizeInputSchema(record.tool.inputSchema || record.tool.input_schema)
      }
    }));
  }

  getAnthropicTools() {
    return [...this.toolRecords.values()].map((record) => ({
      name: record.functionName,
      description: buildToolDescription(record),
      input_schema: normalizeInputSchema(record.tool.inputSchema || record.tool.input_schema)
    }));
  }

  async callTool(functionName, args = {}) {
    const record = this.toolRecords.get(functionName);
    if (!record) {
      return `MCP tool not found: ${functionName}`;
    }

    try {
      const result = await record.client.sendRequest("tools/call", {
        name: record.tool.name,
        arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {}
      });
      return formatToolResult(result);
    } catch (error) {
      return `MCP tool ${record.server.name || record.server.id}/${record.tool.name} failed: ${
        error.message || String(error)
      }`;
    }
  }

  close() {
    for (const client of this.clients.values()) {
      client.close?.();
    }
    this.clients.clear();
    this.toolRecords.clear();
  }
}

function createMcpClient(server) {
  if (server.type === "stdio") {
    return new NativeStdioMcpClient(server);
  }
  return new SseMcpClient(server);
}

class SseMcpClient {
  constructor(server) {
    this.server = server;
    this.client = null;
  }

  async initialize() {
    if (this.client) {
      return;
    }

    const streamableClient = new StreamableHttpMcpClient(this.server);
    try {
      await streamableClient.initialize();
      this.client = streamableClient;
      return;
    } catch (error) {
      if (!shouldTryLegacySse(error)) {
        throw error;
      }
      streamableClient.close();
    }

    const legacyClient = new LegacySseMcpClient(this.server);
    await legacyClient.initialize();
    this.client = legacyClient;
  }

  sendRequest(method, params) {
    return this.client.sendRequest(method, params);
  }

  close() {
    this.client?.close();
  }
}

class StreamableHttpMcpClient {
  constructor(server) {
    this.server = server;
    this.nextId = 1;
    this.sessionId = "";
    this.protocolVersion = MCP_PROTOCOL_VERSION;
  }

  async initialize() {
    const result = await this.sendRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "Anytime Ask",
        version: "1.4.0"
      }
    });
    this.protocolVersion = result?.protocolVersion || MCP_PROTOCOL_VERSION;
    await this.sendNotification("notifications/initialized", {});
  }

  sendRequest(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return this.sendJsonRpc({
      jsonrpc: "2.0",
      id,
      method,
      params
    });
  }

  sendNotification(method, params = {}) {
    return this.sendJsonRpc({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  async sendJsonRpc(message) {
    const response = await fetchWithTimeout(this.server.url, {
      method: "POST",
      headers: this.buildHeaders({
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(message)
    });

    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId) {
      this.sessionId = sessionId;
    }

    if (!response.ok) {
      throw new McpHttpError(
        `MCP ${this.server.name || this.server.id} 请求失败（HTTP ${response.status}）`,
        response.status
      );
    }

    if (!("id" in message)) {
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const rpcResponse = await readJsonRpcFromSseResponse(response, message.id);
      return readJsonRpcResult(rpcResponse, this.server);
    }

    if (response.status === 202) {
      return null;
    }

    const data = await response.json();
    return readJsonRpcResult(data, this.server);
  }

  buildHeaders(headers = {}) {
    const next = {
      ...(this.server.headers || {}),
      ...headers,
      "MCP-Protocol-Version": this.protocolVersion || MCP_PROTOCOL_VERSION
    };
    if (this.sessionId) {
      next["Mcp-Session-Id"] = this.sessionId;
    }
    return next;
  }

  close() {}
}

class LegacySseMcpClient {
  constructor(server) {
    this.server = server;
    this.nextId = 1;
    this.pending = new Map();
    this.postUrl = "";
    this.abortController = new AbortController();
    this.endpointPromise = null;
  }

  async initialize() {
    await this.connect();
    const result = await this.sendRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "Anytime Ask",
        version: "1.4.0"
      }
    });
    await this.sendNotification("notifications/initialized", {});
    return result;
  }

  async connect() {
    if (this.endpointPromise) {
      return this.endpointPromise;
    }

    this.endpointPromise = new Promise((resolve, reject) => {
      fetchWithTimeout(this.server.url, {
        method: "GET",
        headers: {
          ...(this.server.headers || {}),
          Accept: "text/event-stream"
        },
        signal: this.abortController.signal,
        timeoutMs: MCP_REQUEST_TIMEOUT_MS
      })
        .then((response) => {
          if (!response.ok || !response.body) {
            reject(
              new McpHttpError(
                `MCP ${this.server.name || this.server.id} SSE 连接失败（HTTP ${
                  response.status
                }）`,
                response.status
              )
            );
            return;
          }

          readSseStream(response, (event) => {
            this.handleSseEvent(event, resolve);
          }).catch((error) => {
            this.rejectPending(error);
            if (!this.postUrl) {
              reject(error);
            }
          });
        })
        .catch(reject);
    });

    return this.endpointPromise;
  }

  handleSseEvent(event, resolveEndpoint) {
    if (event.event === "endpoint") {
      this.postUrl = new URL(event.data, this.server.url).href;
      resolveEndpoint(this.postUrl);
      return;
    }

    if (event.event && event.event !== "message") {
      return;
    }

    const message = parseMaybeJson(event.data);
    if (!message || !("id" in message)) {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timeoutId);
    if (message.error) {
      pending.reject(formatMcpRpcError(message.error, this.server));
      return;
    }
    pending.resolve(message.result);
  }

  async sendRequest(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const responsePromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.server.name || this.server.id} 请求超时：${method}`));
      }, MCP_REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeoutId });
    });

    await this.postMessage(message).catch((error) => {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timeoutId);
        pending.reject(error);
      }
      throw error;
    });

    return responsePromise;
  }

  async sendNotification(method, params = {}) {
    await this.postMessage({
      jsonrpc: "2.0",
      method,
      params
    });
    return null;
  }

  async postMessage(message) {
    const postUrl = await this.connect();
    const response = await fetchWithTimeout(postUrl, {
      method: "POST",
      headers: {
        ...(this.server.headers || {}),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(message),
      timeoutMs: MCP_REQUEST_TIMEOUT_MS
    });
    if (!response.ok) {
      throw new McpHttpError(
        `MCP ${this.server.name || this.server.id} legacy SSE POST 失败（HTTP ${
          response.status
        }）`,
        response.status
      );
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.abortController.abort();
    this.rejectPending(new Error(`MCP ${this.server.name || this.server.id} SSE 连接已关闭。`));
  }
}

class NativeStdioMcpClient {
  constructor(server) {
    this.server = server;
    this.nextId = 1;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    const result = await this.sendRequest("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "Anytime Ask",
        version: "1.4.0"
      }
    });
    await this.sendNotification("notifications/initialized", {});
    this.initialized = true;
    return result;
  }

  sendRequest(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return this.sendJsonRpc({
      jsonrpc: "2.0",
      id,
      method,
      params
    });
  }

  sendNotification(method, params = {}) {
    return this.sendJsonRpc({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  async sendJsonRpc(message) {
    const result = await getNativeBridge().send({
      type: "mcp.message",
      server: this.server,
      message
    });

    if (!("id" in message)) {
      return null;
    }

    return readJsonRpcResult(result?.message, this.server);
  }

  close() {
    nativeBridge?.disconnect();
  }
}

class NativeMcpBridge {
  constructor() {
    this.port = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  connect() {
    if (this.port) {
      return;
    }

    if (!globalThis.chrome?.runtime?.connectNative) {
      throw new Error("当前浏览器未开放 nativeMessaging，无法使用 stdio MCP。");
    }

    this.port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    this.port.onMessage.addListener((message) => {
      this.handleMessage(message);
    });
    this.port.onDisconnect.addListener(() => {
      const runtimeError = chrome.runtime.lastError;
      const error = new Error(
        runtimeError?.message ||
          `Native Messaging host ${NATIVE_HOST_NAME} 已断开，请确认本地桥接已安装。`
      );
      this.rejectAll(error);
      this.port = null;
    });
  }

  send(payload) {
    this.connect();
    const bridgeId = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(bridgeId);
        reject(new Error(`Native MCP bridge 请求超时：${payload?.type || "unknown"}`));
      }, MCP_REQUEST_TIMEOUT_MS);

      this.pending.set(bridgeId, { resolve, reject, timeoutId });
      this.port.postMessage({
        ...payload,
        bridgeId
      });
    });
  }

  handleMessage(message) {
    const bridgeId = message?.bridgeId;
    const pending = this.pending.get(bridgeId);
    if (!pending) {
      return;
    }

    this.pending.delete(bridgeId);
    clearTimeout(pending.timeoutId);
    if (!message.ok) {
      pending.reject(new Error(message.error || "Native MCP bridge 返回错误。"));
      return;
    }
    pending.resolve(message);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  disconnect() {
    if (!this.port) {
      return;
    }
    this.port.disconnect();
    this.port = null;
  }
}

function getNativeBridge() {
  if (!nativeBridge) {
    nativeBridge = new NativeMcpBridge();
  }
  return nativeBridge;
}

function readJsonRpcResult(message, server) {
  if (!message) {
    throw new Error(`MCP ${server.name || server.id} 未返回 JSON-RPC 响应。`);
  }
  if (message.error) {
    throw formatMcpRpcError(message.error, server);
  }
  return message.result;
}

async function readJsonRpcFromSseResponse(response, expectedId) {
  let rpcResponse = null;
  await readSseStream(response, (event) => {
    const message = parseMaybeJson(event.data);
    if (message && message.id === expectedId) {
      rpcResponse = message;
    }
  });

  if (!rpcResponse) {
    throw new Error("MCP SSE 响应中未找到匹配的 JSON-RPC id。");
  }
  return rpcResponse;
}

async function fetchWithTimeout(url, init = {}) {
  const timeoutMs = init.timeoutMs || MCP_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal;
  const { timeoutMs: _timeoutMs, signal: _signal, ...fetchInit } = init;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  try {
    return await fetch(url, {
      ...fetchInit,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`MCP 请求超时或已取消：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readSseStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const rawEvent of events) {
      const event = parseSseEvent(rawEvent);
      if (event.data) {
        onEvent(event);
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseSseEvent(buffer);
    if (event.data) {
      onEvent(event);
    }
  }
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split(/\r?\n/);
  let eventName = "";
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    event: eventName,
    data: dataLines.join("\n")
  };
}

function shouldTryLegacySse(error) {
  return error instanceof McpHttpError && [404, 405].includes(error.status);
}

class McpHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function formatMcpRpcError(error, server) {
  const message = error?.message || error?.data || "未知 MCP 错误";
  return new Error(`MCP ${server.name || server.id} 返回错误：${String(message)}`);
}

function buildToolDescription(record) {
  const serverName = record.server.name || record.server.id;
  const description = String(record.tool.description || "").trim();
  return [`MCP server: ${serverName}.`, description].filter(Boolean).join(" ");
}

function normalizeInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {
      type: "object",
      properties: {}
    };
  }

  return {
    type: "object",
    properties: schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {},
    ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
    ...(schema.additionalProperties !== undefined
      ? { additionalProperties: schema.additionalProperties }
      : {})
  };
}

function createToolFunctionName(serverId, toolName, existing) {
  const base = `mcp_${toFunctionNamePart(serverId)}_${toFunctionNamePart(toolName)}`;
  let name = base.slice(0, 64);
  if (!existing.has(name)) {
    return name;
  }

  const suffix = `_${hashText(`${serverId}:${toolName}`).slice(0, 8)}`;
  name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  let index = 2;
  while (existing.has(name)) {
    const nextSuffix = `_${index}`;
    name = `${base.slice(0, 64 - nextSuffix.length)}${nextSuffix}`;
    index += 1;
  }
  return name;
}

function toFunctionNamePart(value) {
  const part = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return part || "tool";
}

function formatToolResult(result) {
  if (!result) {
    return "";
  }

  const lines = [];
  if (result.isError) {
    lines.push("MCP tool returned an error.");
  }

  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === "text") {
        lines.push(String(item.text || ""));
      } else if (item?.type === "image") {
        lines.push(`[image: ${item.mimeType || "unknown"}]`);
      } else if (item?.type === "resource") {
        lines.push(`[resource: ${item.resource?.uri || item.uri || "unknown"}]`);
      } else if (item) {
        lines.push(JSON.stringify(item));
      }
    }
  } else {
    lines.push(JSON.stringify(result));
  }

  return clip(lines.filter(Boolean).join("\n\n"), MAX_TOOL_RESULT_CHARS);
}

function parseMaybeJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function hashText(value) {
  const text = String(value || "");
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

function clip(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...[已截断]`;
}
