import {
  MAX_PERSONAL_INSTRUCTION_CHARS,
  PROVIDERS,
  REQUEST_TIMEOUT_MS
} from "./constants.js";
import { createMcpToolRuntime } from "./mcp-client.js";
import { getConversationMcpServers } from "./storage.js";

const MAX_TOOL_CALL_ROUNDS = 5;

export async function callProvider(settings, conversation) {
  const provider = settings.provider;
  const config = settings[provider];
  validateConfig(provider, config);
  const mcpServers = getConversationMcpServers(settings, conversation);
  const mcpRuntime = await createMcpToolRuntime(mcpServers);

  const systemPrompt = buildSystemPrompt(conversation, {
    mcpServers: mcpRuntime ? mcpServers : [],
    personalInstruction: settings.personalInstruction
  });
  const messages = normalizeConversationMessages(conversation.messages);

  try {
    if (provider === PROVIDERS.anthropic) {
      return await callAnthropic(config, systemPrompt, messages, {
        mcpRuntime
      });
    }

    return await callOpenAICompatible(config, systemPrompt, messages, {
      includeDeepSeekThinking: provider === PROVIDERS.deepseek,
      mcpRuntime
    });
  } finally {
    mcpRuntime?.close();
  }
}

export async function callProviderStream(settings, conversation, options = {}) {
  const provider = settings.provider;
  const config = settings[provider];
  validateConfig(provider, config);
  const mcpServers = getConversationMcpServers(settings, conversation);
  const mcpRuntime = await createMcpToolRuntime(mcpServers);

  const systemPrompt = buildSystemPrompt(conversation, {
    includeContext: options.includeContext,
    mcpServers: mcpRuntime ? mcpServers : [],
    personalInstruction: settings.personalInstruction
  });
  const messages = normalizeConversationMessages(conversation.messages);
  const onDelta = typeof options.onDelta === "function" ? options.onDelta : () => {};

  try {
    if (provider === PROVIDERS.anthropic) {
      return await callAnthropicStream(config, systemPrompt, messages, {
        mcpRuntime,
        onDelta,
        signal: options.signal
      });
    }

    return await callOpenAICompatibleStream(config, systemPrompt, messages, {
      includeDeepSeekThinking: provider === PROVIDERS.deepseek,
      mcpRuntime,
      onDelta,
      signal: options.signal
    });
  } finally {
    mcpRuntime?.close();
  }
}

export async function testProvider(settings) {
  const now = new Date().toISOString();
  return callProvider(settings, {
    id: "provider-test",
    title: "配置测试",
    url: "chrome-extension://anytime-ask/options",
    selectedText: "配置连通性测试",
    contextText: "这是一条最小化的 provider 连通性测试。",
    contextSource: "test",
    messages: [
      {
        id: "test-user",
        role: "user",
        content: "请只用一句中文回复：配置测试通过。",
        createdAt: now
      }
    ]
  });
}

function validateConfig(provider, config) {
  if (!config) {
    throw new Error(`未找到 provider 配置：${provider}`);
  }

  if (!config.apiKey?.trim()) {
    throw new Error("尚未配置 API Key，请先在设置页填写并保存。");
  }

  if (!config.baseUrl?.trim()) {
    throw new Error("尚未配置 Base URL。");
  }

  if (!config.model?.trim()) {
    throw new Error("尚未配置模型名称。");
  }
}

function buildSystemPrompt(conversation, options = {}) {
  const selectedText = clip(conversation.selectedText || "", 4000);
  const contextText = clip(conversation.contextText || "", 12000);
  const includeContext = options.includeContext !== false;

  const base = [
    "你是 Anytime Ask，一个网页旁路解释助手。",
    "用户正在查看一个网页端 AI 会话或普通网页，并划选了其中一段内容进行独立追问。你的回答不会写回原网页对话，所以要围绕划选内容清晰解释，不要假设用户已经理解中间步骤。",
    "请优先结合当前网页上下文回答。若上下文不足，请直接说明缺失的信息，并基于已知内容给出最可靠的解释。",
    "对数学、代码、概念解释类问题，请拆步骤说明，指出隐含前提，并在有帮助时给一个更简单的例子。"
  ];

  const personalInstruction = formatPersonalInstructionForPrompt(
    options.personalInstruction
  );
  if (personalInstruction) {
    base.push(`用户个人指令：\n${personalInstruction}`);
  }

  base.push(
    `来源页面标题：${conversation.pageTitle || conversation.title || "未知"}`,
    `来源页面 URL：${conversation.url || "未知"}`,
    `上下文来源：${conversation.contextSource || "generic"}`,
    `会话初始划选内容：\n${selectedText || "未提供"}`
  );

  if (includeContext) {
    base.push(`当前页面上下文摘录：\n${contextText || "未提取到可用上下文"}`);
  } else {
    base.push(
      "当前页面快照与本插件会话已注入过的快照一致，本轮为节省 token 不重复注入完整页面上下文。请依赖本轮划选内容、会话历史和已知信息回答；若确实需要完整页面上下文，请说明需要用户刷新上下文。"
    );
  }

  const mcpSummary = formatMcpServersForPrompt(options.mcpServers || []);
  if (mcpSummary) {
    base.push(
      [
        "本会话启用的 MCP 服务器与工具：",
        mcpSummary,
        "当问题需要外部数据、文件、检索或动作时，请优先使用可用的 MCP 工具；工具结果会由插件执行后回传给你。"
      ].join("\n")
    );
  }

  return base.join("\n\n");
}

function formatPersonalInstructionForPrompt(personalInstruction) {
  if (personalInstruction?.enabled !== true) {
    return "";
  }

  return clipPlainText(
    personalInstruction.content || "",
    MAX_PERSONAL_INSTRUCTION_CHARS
  );
}

function clipPlainText(value, maxLength) {
  return Array.from(String(value || "").trim()).slice(0, maxLength).join("");
}

function formatMcpServersForPrompt(servers = []) {
  return servers
    .map((server) => {
      const lines = [
        `- ${server.name || server.id} (${server.id}, ${server.type})`
      ];

      if (server.description) {
        lines.push(`  描述：${server.description}`);
      }

      if (server.type === "stdio") {
        lines.push(
          `  启动：${[server.command, ...(server.args || [])].filter(Boolean).join(" ")}`
        );
        if (server.cwd) {
          lines.push(`  工作目录：${server.cwd}`);
        }
        const envKeys = Object.keys(server.env || {});
        if (envKeys.length) {
          lines.push(`  环境变量：${envKeys.join(", ")}（值已隐藏）`);
        }
      }

      if (server.type === "sse") {
        lines.push(`  SSE URL：${server.url}`);
        const headerKeys = Object.keys(server.headers || {});
        if (headerKeys.length) {
          lines.push(`  Headers：${headerKeys.join(", ")}（值已隐藏）`);
        }
      }

      return lines.join("\n");
    })
    .join("\n");
}

function normalizeConversationMessages(messages = []) {
  return messages
    .filter((message) => message && ["user", "assistant"].includes(message.role))
    .slice(-20)
    .map((message) => ({
      role: message.role,
      content: buildMessageContent(message)
    }));
}

function buildMessageContent(message) {
  const content = clip(String(message.content || ""), 8000);
  if (message.role !== "user" || !message.selectedText) {
    return content;
  }

  return [
    `本轮用户划选内容：\n${clip(message.selectedText, 2500)}`,
    `用户问题：\n${content}`
  ].join("\n\n");
}

// 非 stream 模式的调用
async function callOpenAICompatible(config, systemPrompt, messages, options = {}) {
  const endpoint = buildEndpoint(config.baseUrl, "chat/completions");
  const requestMessages = [
    {
      role: "system",
      content: systemPrompt
    },
    ...messages
  ];

  for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
    const body = buildOpenAiBody(config, requestMessages, {
      ...options,
      stream: false
    });

    const data = await fetchJson(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey.trim()}`
      },
      body: JSON.stringify(body)
    });

    const assistantMessage = data?.choices?.[0]?.message || {};
    const toolCalls = normalizeOpenAiToolCalls(assistantMessage.tool_calls);
    if (toolCalls.length && options.mcpRuntime && round < MAX_TOOL_CALL_ROUNDS) {
      requestMessages.push({
        role: "assistant",
        content: normalizeTextContent(assistantMessage.content) || null,
        tool_calls: toolCalls
      });
      requestMessages.push(
        ...(await executeOpenAiToolCalls(options.mcpRuntime, toolCalls))
      );
      continue;
    }

    const text = normalizeTextContent(assistantMessage.content);
    const reasoningText = normalizeTextContent(assistantMessage.reasoning_content);
    if (!text) {
      if (reasoningText) {
        throw new Error("Provider 只返回了 thinking 内容，未返回最终回答；请提高 max_tokens 或关闭 DeepSeek thinking。");
      }
      throw new Error("Provider 返回为空。");
    }

    return text;
  }

  throw new Error("MCP 工具调用轮次过多，已停止。");
}

// stream 模式的调用
async function callOpenAICompatibleStream(config, systemPrompt, messages, options = {}) {
  const endpoint = buildEndpoint(config.baseUrl, "chat/completions");
  const requestMessages = [
    {
      role: "system",
      content: systemPrompt
    },
    ...messages
  ];
  let fullText = "";
  let lastStreamed = null;

  for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
    const body = buildOpenAiBody(config, requestMessages, {
      ...options,
      stream: true
    });

    const response = await fetchStream(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey.trim()}`
      },
      body: JSON.stringify(body),
      signal: options.signal
    });

    const streamed = await readOpenAiStreamResponse(response, (delta) => {
      fullText += delta;
      options.onDelta(delta, fullText);
    });
    lastStreamed = streamed;

    if (streamed.toolCalls.length && options.mcpRuntime && round < MAX_TOOL_CALL_ROUNDS) {
      requestMessages.push({
        role: "assistant",
        content: streamed.text || null,
        tool_calls: streamed.toolCalls
      });
      requestMessages.push(
        ...(await executeOpenAiToolCalls(options.mcpRuntime, streamed.toolCalls))
      );
      continue;
    }

    break;
  }

  if (!fullText.trim()) {
    throwEmptyOpenAiStreamError(lastStreamed);
  }

  return fullText.trim();

  function throwEmptyOpenAiStreamError(streamed) {
    const finishReason = streamed?.finishReason
      ? `（finish_reason: ${streamed.finishReason}）`
      : "";
    if (streamed?.reasoningText?.trim()) {
      throw new Error(
        `Provider 只返回了 thinking 内容，未返回最终回答${finishReason}；请提高 max_tokens 或关闭 DeepSeek thinking。`
      );
    }
    throw new Error(`Provider 返回为空${finishReason}。`);
  }
}

async function callAnthropic(config, systemPrompt, messages, options = {}) {
  const endpoint = buildEndpoint(config.baseUrl, "messages");
  const requestMessages = [...messages];

  for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
    const body = buildAnthropicBody(config, systemPrompt, requestMessages, options);

    const data = await fetchJson(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey.trim(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body)
    });

    const content = Array.isArray(data?.content) ? data.content : [];
    const toolUses = content.filter((part) => part?.type === "tool_use");
    if (toolUses.length && options.mcpRuntime && round < MAX_TOOL_CALL_ROUNDS) {
      requestMessages.push({
        role: "assistant",
        content
      });
      requestMessages.push({
        role: "user",
        content: await executeAnthropicToolUses(options.mcpRuntime, toolUses)
      });
      continue;
    }

    const text = extractAnthropicText(content);
    if (!text) {
      throw new Error("Anthropic 返回为空。");
    }

    return text;
  }

  throw new Error("MCP 工具调用轮次过多，已停止。");
}

async function callAnthropicStream(config, systemPrompt, messages, options = {}) {
  const endpoint = buildEndpoint(config.baseUrl, "messages");
  const requestMessages = [...messages];
  let fullText = "";

  for (let round = 0; round <= MAX_TOOL_CALL_ROUNDS; round += 1) {
    const body = buildAnthropicBody(config, systemPrompt, requestMessages, {
      ...options,
      stream: true
    });

    const response = await fetchStream(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey.trim(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(body),
      signal: options.signal
    });

    const streamed = await readAnthropicStreamResponse(response, (delta) => {
      fullText += delta;
      options.onDelta(delta, fullText);
    });

    if (streamed.toolUses.length && options.mcpRuntime && round < MAX_TOOL_CALL_ROUNDS) {
      requestMessages.push({
        role: "assistant",
        content: streamed.content
      });
      requestMessages.push({
        role: "user",
        content: await executeAnthropicToolUses(options.mcpRuntime, streamed.toolUses)
      });
      continue;
    }

    break;
  }

  if (!fullText.trim()) {
    throw new Error("Anthropic 返回为空。");
  }

  return fullText.trim();
}

function buildOpenAiBody(config, messages, options = {}) {
  const body = {
    model: config.model.trim(),
    messages,
    max_tokens: toPositiveInteger(config.maxTokens, 1200),
    stream: Boolean(options.stream)
  };

  const temperature = toOptionalNumber(config.temperature);
  if (temperature !== null) {
    body.temperature = temperature;
  }

  const tools = options.mcpRuntime?.getOpenAiTools() || [];
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  if (options.includeDeepSeekThinking) {
    body.thinking = {
      type: config.thinkingEnabled ? "enabled" : "disabled"
    };
    if (config.thinkingEnabled) {
      body.reasoning_effort = normalizeDeepSeekReasoningEffort(config.reasoningEffort);
    }
  }

  return body;
}

function normalizeDeepSeekReasoningEffort(value) {
  const normalized = String(value || "high").trim().toLowerCase();
  return normalized === "max" || normalized === "xhigh" ? "max" : "high";
}

function buildAnthropicBody(config, systemPrompt, messages, options = {}) {
  const body = {
    model: config.model.trim(),
    system: systemPrompt,
    messages,
    max_tokens: toPositiveInteger(config.maxTokens, 1200),
    stream: Boolean(options.stream)
  };

  const tools = options.mcpRuntime?.getAnthropicTools() || [];
  if (tools.length) {
    body.tools = tools;
  }

  return body;
}

async function readOpenAiStreamResponse(response, onDelta) {
  let text = "";
  let reasoningText = "";
  let finishReason = "";
  const toolCallParts = [];

  await readSseStream(response, (event) => {
    if (event.data === "[DONE]") {
      return;
    }

    const chunk = parseMaybeJson(event.data);
    if (chunk?.error) {
      throw new Error(formatProviderErrorMessage(chunk.error));
    }

    const choice = chunk?.choices?.[0];
    const delta = choice?.delta;
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }

    const content = normalizeTextContent(delta?.content, { trim: false });
    if (content) {
      text += content;
      onDelta(content);
    }

    const reasoningContent = normalizeTextContent(delta?.reasoning_content, { trim: false });
    if (reasoningContent) {
      reasoningText += reasoningContent;
    }

    if (Array.isArray(delta?.tool_calls)) {
      for (const item of delta.tool_calls) {
        const index = Number.isInteger(item.index) ? item.index : toolCallParts.length;
        const current = toolCallParts[index] || {
          id: "",
          type: "function",
          function: {
            name: "",
            arguments: ""
          }
        };
        current.id = item.id || current.id;
        current.type = item.type || current.type || "function";
        current.function.name =
          item.function?.name || current.function.name || "";
        current.function.arguments += item.function?.arguments || "";
        toolCallParts[index] = current;
      }
    }
  });

  return {
    text,
    reasoningText,
    finishReason,
    toolCalls: normalizeOpenAiToolCalls(toolCallParts)
  };
}

async function readAnthropicStreamResponse(response, onDelta) {
  const blocks = [];

  await readSseStream(response, (event) => {
    const payload = parseMaybeJson(event.data);
    if (payload?.type === "error") {
      throw new Error(payload.error?.message || "Anthropic stream 返回错误。");
    }

    if (payload?.type === "content_block_start") {
      const block = payload.content_block || {};
      if (block.type === "tool_use") {
        blocks[payload.index] = {
          type: "tool_use",
          id: block.id,
          name: block.name,
          inputPartial: ""
        };
      } else {
        blocks[payload.index] = {
          type: "text",
          text: String(block.text || "")
        };
      }
      return;
    }

    if (payload?.type !== "content_block_delta") {
      return;
    }

    const block = blocks[payload.index];
    const delta = payload.delta;
    if (!block || !delta) {
      return;
    }

    if (delta.type === "text_delta") {
      const text = String(delta.text || "");
      if (text) {
        block.text += text;
        onDelta(text);
      }
      return;
    }

    if (delta.type === "input_json_delta") {
      block.inputPartial = `${block.inputPartial || ""}${delta.partial_json || ""}`;
    }
  });

  const content = blocks
    .filter(Boolean)
    .map((block) => {
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: parseToolArguments(block.inputPartial)
        };
      }
      return {
        type: "text",
        text: block.text || ""
      };
    })
    .filter((block) => block.type !== "text" || block.text);

  return {
    content,
    toolUses: content.filter((block) => block.type === "tool_use")
  };
}

function normalizeOpenAiToolCalls(toolCalls = []) {
  return Array.isArray(toolCalls)
    ? toolCalls
        .filter((toolCall) => toolCall?.function?.name)
        .map((toolCall, index) => ({
          id: toolCall.id || `tool-call-${index + 1}`,
          type: toolCall.type || "function",
          function: {
            name: toolCall.function.name,
            arguments: String(toolCall.function.arguments || "{}")
          }
        }))
    : [];
}

async function executeOpenAiToolCalls(mcpRuntime, toolCalls) {
  const messages = [];
  for (const toolCall of toolCalls) {
    const content = await mcpRuntime.callTool(
      toolCall.function.name,
      parseToolArguments(toolCall.function.arguments)
    );
    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
      content: content || ""
    });
  }
  return messages;
}

async function executeAnthropicToolUses(mcpRuntime, toolUses) {
  const results = [];
  for (const toolUse of toolUses) {
    const content = await mcpRuntime.callTool(toolUse.name, toolUse.input || {});
    results.push({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: content || ""
    });
  }
  return results;
}

function parseToolArguments(value) {
  if (!value) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function extractAnthropicText(content = []) {
  return Array.isArray(content)
    ? content
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
    : "";
}

async function fetchJson(url, init) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    const text = await response.text();
    const data = parseMaybeJson(text);

    if (!response.ok) {
      throw new Error(formatHttpError(response.status, data, text));
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("请求超时，请检查网络、Base URL 或 provider 状态。");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchStream(url, init) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const externalSignal = init.signal;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(formatHttpError(response.status, parseMaybeJson(text), text));
    }

    if (!response.body) {
      throw new Error("Provider 未返回可读取的流。");
    }

    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("请求已取消或超时，请检查网络、Base URL 或 provider 状态。");
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

function buildEndpoint(baseUrl, path) {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  if (clean.endsWith(`/${path}`)) {
    return clean;
  }
  return `${clean}/${path}`;
}

function parseMaybeJson(text) {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatHttpError(status, data, text) {
  const message =
    data?.error?.message ||
    data?.message ||
    data?.error ||
    text ||
    "未知错误";
  return `Provider 请求失败（HTTP ${status}）：${String(message).slice(0, 600)}`;
}

function formatProviderErrorMessage(error) {
  const message =
    error?.message ||
    error?.error?.message ||
    error?.type ||
    JSON.stringify(error) ||
    "未知错误";
  return `Provider stream 返回错误：${String(message).slice(0, 600)}`;
}

function normalizeTextContent(content, options = {}) {
  const shouldTrim = options.trim !== false;

  if (typeof content === "string") {
    return shouldTrim ? content.trim() : content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return part?.text || part?.content || part?.value || "";
      })
      .join(shouldTrim ? "\n" : "");
    return shouldTrim ? text.trim() : text;
  }

  return "";
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function toOptionalNumber(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clip(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...[已截断]`;
}
