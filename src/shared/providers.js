import { PROVIDERS, REQUEST_TIMEOUT_MS } from "./constants.js";

export async function callProvider(settings, conversation) {
  const provider = settings.provider;
  const config = settings[provider];
  validateConfig(provider, config);

  const systemPrompt = buildSystemPrompt(conversation);
  const messages = normalizeConversationMessages(conversation.messages);

  if (provider === PROVIDERS.anthropic) {
    return callAnthropic(config, systemPrompt, messages);
  }

  return callOpenAICompatible(config, systemPrompt, messages, {
    includeDeepSeekThinking: provider === PROVIDERS.deepseek
  });
}

export async function callProviderStream(settings, conversation, options = {}) {
  const provider = settings.provider;
  const config = settings[provider];
  validateConfig(provider, config);

  const systemPrompt = buildSystemPrompt(conversation, {
    includeContext: options.includeContext
  });
  const messages = normalizeConversationMessages(conversation.messages);
  const onDelta = typeof options.onDelta === "function" ? options.onDelta : () => {};

  if (provider === PROVIDERS.anthropic) {
    return callAnthropicStream(config, systemPrompt, messages, {
      onDelta,
      signal: options.signal
    });
  }

  return callOpenAICompatibleStream(config, systemPrompt, messages, {
    includeDeepSeekThinking: provider === PROVIDERS.deepseek,
    onDelta,
    signal: options.signal
  });
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
    "对数学、代码、概念解释类问题，请拆步骤说明，指出隐含前提，并在有帮助时给一个更简单的例子。",
    `来源页面标题：${conversation.pageTitle || conversation.title || "未知"}`,
    `来源页面 URL：${conversation.url || "未知"}`,
    `上下文来源：${conversation.contextSource || "generic"}`,
    `会话初始划选内容：\n${selectedText || "未提供"}`
  ];

  if (includeContext) {
    base.push(`当前页面上下文摘录：\n${contextText || "未提取到可用上下文"}`);
  } else {
    base.push(
      "当前页面快照与本插件会话已注入过的快照一致，本轮为节省 token 不重复注入完整页面上下文。请依赖本轮划选内容、会话历史和已知信息回答；若确实需要完整页面上下文，请说明需要用户刷新上下文。"
    );
  }

  return base.join("\n\n");
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
  const body = {
    model: config.model.trim(),
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      ...messages
    ],
    max_tokens: toPositiveInteger(config.maxTokens, 1200),
    stream: false
  };

  const temperature = toOptionalNumber(config.temperature);
  if (temperature !== null) {
    body.temperature = temperature;
  }

  if (options.includeDeepSeekThinking && config.thinkingEnabled) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = config.reasoningEffort || "medium";
  }

  const data = await fetchJson(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey.trim()}`
    },
    body: JSON.stringify(body)
  });

  const content = data?.choices?.[0]?.message?.content;
  const text = normalizeTextContent(content);
  if (!text) {
    throw new Error("Provider 返回为空。");
  }

  return text;
}

// stream 模式的调用
async function callOpenAICompatibleStream(config, systemPrompt, messages, options = {}) {
  const endpoint = buildEndpoint(config.baseUrl, "chat/completions");
  const body = {
    model: config.model.trim(),
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      ...messages
    ],
    max_tokens: toPositiveInteger(config.maxTokens, 1200),
    stream: true
  };

  const temperature = toOptionalNumber(config.temperature);
  if (temperature !== null) {
    body.temperature = temperature;
  }

  if (options.includeDeepSeekThinking && config.thinkingEnabled) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = config.reasoningEffort || "medium";
  }

  const response = await fetchStream(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey.trim()}`
    },
    body: JSON.stringify(body),
    signal: options.signal
  });

  let fullText = "";
  await readSseStream(response, (event) => {
    if (event.data === "[DONE]") {
      return;
    }

    const chunk = parseMaybeJson(event.data);
    const delta = chunk?.choices?.[0]?.delta;
    // const text = normalizeTextContent(delta?.content); 这一块是错误的！！这里会把 chunk 破坏掉其该有的结构
    const text = String(delta?.content || "");
    if (!text) {
      return;
    }

    fullText += text;
    options.onDelta(text, fullText);
  });

  if (!fullText.trim()) {
    throw new Error("Provider 返回为空。");
  }

  return fullText.trim();
}

async function callAnthropic(config, systemPrompt, messages) {
  const endpoint = buildEndpoint(config.baseUrl, "messages");
  const body = {
    model: config.model.trim(),
    system: systemPrompt,
    messages,
    max_tokens: toPositiveInteger(config.maxTokens, 1200)
  };

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

  const text = Array.isArray(data?.content)
    ? data.content
        .filter((part) => part?.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
    : "";

  if (!text) {
    throw new Error("Anthropic 返回为空。");
  }

  return text;
}

async function callAnthropicStream(config, systemPrompt, messages, options = {}) {
  const endpoint = buildEndpoint(config.baseUrl, "messages");
  const body = {
    model: config.model.trim(),
    system: systemPrompt,
    messages,
    max_tokens: toPositiveInteger(config.maxTokens, 1200),
    stream: true
  };

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

  let fullText = "";
  await readSseStream(response, (event) => {
    const payload = parseMaybeJson(event.data);
    if (payload?.type === "error") {
      throw new Error(payload.error?.message || "Anthropic stream 返回错误。");
    }

    const delta = payload?.delta;
    if (payload?.type !== "content_block_delta" || delta?.type !== "text_delta") {
      return;
    }

    const text = String(delta.text || "");
    if (!text) {
      return;
    }

    fullText += text;
    options.onDelta(text, fullText);
  });

  if (!fullText.trim()) {
    throw new Error("Anthropic 返回为空。");
  }

  return fullText.trim();
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

function normalizeTextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return part?.text || "";
      })
      .join("\n")
      .trim();
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
