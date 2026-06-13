import { MESSAGE_TYPES } from "../shared/constants.js";
import { callProvider, callProviderStream, testProvider } from "../shared/providers.js";
import {
  deleteConversation,
  getConversation,
  getConversations,
  getSettings,
  mergeSettings,
  saveConversation
} from "../shared/storage.js";

const STREAM_PORT_NAME = "AA_STREAM_MESSAGE_PORT";
const STREAM_EVENTS = Object.freeze({
  conversation: "conversation",
  assistantStart: "assistant-start",
  delta: "delta",
  done: "done",
  error: "error"
});

// ── Context menu ────────────────────────────────────────────
const CONTEXT_MENU_ID = "AA_OPEN_PANEL";

function createContextMenu() {
  // Remove first to avoid duplicates on service worker restart
  chrome.contextMenus.remove(CONTEXT_MENU_ID, () => {
    if (chrome.runtime.lastError) {
      // Menu item didn't exist yet — that's fine
    }
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "进入 Anytime-Ask",
      contexts: ["page", "selection"]
    });
  });
}

// Create context menu on install / startup
chrome.runtime.onInstalled.addListener(createContextMenu);
createContextMenu();

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, {
    type: MESSAGE_TYPES.openFromContextMenu
  }).catch(() => {
    // Content script may not be ready or URL not allowed — silent ignore
  });
});

// ── Message routing ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case MESSAGE_TYPES.createConversation:
      return createConversation(message.context || {}, { forceNew: true });
    case MESSAGE_TYPES.openOrCreateConversation:
      return openOrCreateConversation(message.context || {});
    case MESSAGE_TYPES.sendMessage:
      return sendConversationMessage(message.conversationId, message.content);
    case MESSAGE_TYPES.listConversations:
      return listConversations(message.currentUrl || "");
    case MESSAGE_TYPES.loadConversation:
      return loadConversation(message.conversationId);
    case MESSAGE_TYPES.renameConversation:
      return renameConversation(message.conversationId, message.title);
    case MESSAGE_TYPES.deleteConversation:
      await deleteConversation(message.conversationId);
      return listConversations(message.currentUrl || "");
    case MESSAGE_TYPES.openOptions:
      await chrome.runtime.openOptionsPage();
      return {};
    case MESSAGE_TYPES.openHistory:
      await chrome.tabs.create({
        url: chrome.runtime.getURL("src/history/history.html")
      });
      return {};
    case MESSAGE_TYPES.clearConversationSelection:
      return clearConversationSelection(message.conversationId);
    case MESSAGE_TYPES.testProvider:
      return {
        reply: await testProvider(mergeSettings(message.settings))
      };
    default:
      throw new Error("未知消息类型。");
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== STREAM_PORT_NAME) {
    return;
  }

  const controller = new AbortController();
  let started = false;

  port.onDisconnect.addListener(() => {
    controller.abort();
  });

  port.onMessage.addListener((message) => {
    if (started || message?.type !== MESSAGE_TYPES.streamMessage) {
      return;
    }
    started = true;
    streamConversationMessage(message, port, controller.signal).catch((error) => {
      safePost(port, {
        type: STREAM_EVENTS.error,
        error: error.message || String(error)
      });
    });
  });
});

async function openOrCreateConversation(context) {
  const pageKey = normalizePageUrl(context.url || "");
  const conversations = await getConversations();
  const latest = conversations
    .filter((conversation) => conversation.pageKey === pageKey)
    .sort(sortByUpdatedAt)[0];

  if (!latest) {
    return createConversation(context, { forceNew: true });
  }

  const updated = mergeContextSnapshot(latest, context, {
    allowSelectionUpdate: (latest.messages || []).length === 0
  });
  await saveConversation(updated);
  return {
    conversation: updated,
    reused: true,
    conversations: decorateConversations(await getConversations(), context.url || "")
  };
}

async function createConversation(context, options = {}) {
  const settings = await getSettings();
  const provider = settings.provider;
  const providerConfig = settings[provider];
  const now = new Date().toISOString();
  const pageKey = normalizePageUrl(context.url || "");
  const conversations = await getConversations();
  const pageSequence = getNextPageSequence(conversations, pageKey);

  const conversation = {
    id: createId(),
    title: buildInitialTitle(context.selectedText),
    titleEdited: false,
    pageKey,
    pageSequence,
    url: context.url || "",
    pageTitle: context.title || "未命名页面",
    selectedText: context.selectedText || "",
    contextText: context.contextText || "",
    contextSource: context.contextSource || "generic",
    contextHash: context.contextHash || hashText(context.contextText || ""),
    contextInjectedHash: "",
    contextUpdatedAt: now,
    provider,
    model: providerConfig?.model || "",
    createdAt: now,
    updatedAt: now,
    messages: [],
    lastError: ""
  };

  await saveConversation(conversation);
  return {
    conversation,
    created: options.forceNew !== false,
    conversations: decorateConversations(await getConversations(), context.url || "")
  };
}

async function sendConversationMessage(conversationId, content) {
  const text = String(content || "").trim();
  if (!conversationId) {
    throw new Error("缺少会话 ID。");
  }
  if (!text) {
    throw new Error("请输入要追问的问题。");
  }

  const conversation = await getConversation(conversationId);
  if (!conversation) {
    throw new Error("未找到对应会话，可能已被删除。");
  }

  const settings = await getSettings();
  const now = new Date().toISOString();
  const userMessage = {
    id: createId(),
    role: "user",
    content: text,
    createdAt: now
  };

  const conversationWithUserMessage = {
    ...conversation,
    provider: settings.provider,
    model: settings[settings.provider]?.model || conversation.model,
    updatedAt: now,
    messages: [...(conversation.messages || []), userMessage],
    lastError: ""
  };

  await saveConversation(conversationWithUserMessage);

  try {
    const reply = await callProvider(settings, conversationWithUserMessage);
    const doneAt = new Date().toISOString();
    const updatedConversation = {
      ...conversationWithUserMessage,
      updatedAt: doneAt,
      messages: [
        ...conversationWithUserMessage.messages,
        {
          id: createId(),
          role: "assistant",
          content: reply,
          createdAt: doneAt
        }
      ],
      lastError: ""
    };
    await saveConversation(updatedConversation);
    return { conversation: updatedConversation };
  } catch (error) {
    const failedConversation = {
      ...conversationWithUserMessage,
      updatedAt: new Date().toISOString(),
      lastError: error.message || String(error)
    };
    await saveConversation(failedConversation);
    throw error;
  }
}

async function streamConversationMessage(message, port, signal) {
  const text = String(message.content || "").trim();
  if (!message.conversationId) {
    throw new Error("缺少会话 ID。");
  }
  if (!text) {
    throw new Error("请输入要追问的问题。");
  }

  const existing = await getConversation(message.conversationId);
  if (!existing) {
    throw new Error("未找到对应会话，可能已被删除。");
  }

  const settings = await getSettings();
  const now = new Date().toISOString();
  const syncedConversation = mergeContextSnapshot(existing, message.context || {}, {
    allowSelectionUpdate: false
  });
  const hadUserMessage = (syncedConversation.messages || []).some(
    (item) => item.role === "user"
  );
  const selectedText = String(message.selectedText || syncedConversation.selectedText || "").trim();

  const userMessage = {
    id: createId(),
    role: "user",
    content: text,
    selectedText,
    contextHash: syncedConversation.contextHash || "",
    createdAt: now
  };

  const conversationWithUserMessage = {
    ...syncedConversation,
    title:
      !syncedConversation.titleEdited && !hadUserMessage
        ? buildConversationTitle(selectedText || syncedConversation.selectedText, text)
        : syncedConversation.title,
    provider: settings.provider,
    model: settings[settings.provider]?.model || syncedConversation.model,
    updatedAt: now,
    messages: [...(syncedConversation.messages || []), userMessage],
    lastError: ""
  };

  await saveConversation(conversationWithUserMessage);
  safePost(port, {
    type: STREAM_EVENTS.conversation,
    conversation: conversationWithUserMessage
  });

  const assistantId = createId();
  const includeContext = shouldInjectContext(conversationWithUserMessage);
  let reply = "";

  safePost(port, {
    type: STREAM_EVENTS.assistantStart,
    assistantId
  });

  try {
    reply = await callProviderStream(settings, conversationWithUserMessage, {
      includeContext,
      signal,
      onDelta(delta, fullText) {
        safePost(port, {
          type: STREAM_EVENTS.delta,
          assistantId,
          delta,
          content: fullText
        });
      }
    });

    const doneAt = new Date().toISOString();
    const updatedConversation = {
      ...conversationWithUserMessage,
      updatedAt: doneAt,
      contextInjectedHash: includeContext
        ? conversationWithUserMessage.contextHash || ""
        : conversationWithUserMessage.contextInjectedHash || "",
      messages: [
        ...conversationWithUserMessage.messages,
        {
          id: assistantId,
          role: "assistant",
          content: reply,
          createdAt: doneAt
        }
      ],
      lastError: ""
    };
    await saveConversation(updatedConversation);
    safePost(port, {
      type: STREAM_EVENTS.done,
      conversation: updatedConversation
    });
  } catch (error) {
    const failedConversation = {
      ...conversationWithUserMessage,
      updatedAt: new Date().toISOString(),
      lastError: error.message || String(error)
    };
    await saveConversation(failedConversation);
    safePost(port, {
      type: STREAM_EVENTS.error,
      conversation: failedConversation,
      error: error.message || String(error)
    });
  }
}

async function listConversations(currentUrl) {
  return {
    conversations: decorateConversations(await getConversations(), currentUrl)
  };
}

async function loadConversation(conversationId) {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    throw new Error("未找到对应会话，可能已被删除。");
  }
  return { conversation };
}

async function renameConversation(conversationId, title) {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    throw new Error("未找到对应会话，可能已被删除。");
  }

  const nextTitle = String(title || "").trim();
  if (!nextTitle) {
    throw new Error("标题不能为空。");
  }

  const updatedConversation = {
    ...conversation,
    title: nextTitle.slice(0, 80),
    titleEdited: true,
    updatedAt: new Date().toISOString()
  };

  await saveConversation(updatedConversation);
  return { conversation: updatedConversation };
}

async function clearConversationSelection(conversationId) {
  if (!conversationId) {
    return {};
  }

  const conversation = await getConversation(conversationId);
  if (!conversation) {
    return {};
  }

  const updatedConversation = {
    ...conversation,
    selectedText: "",
    updatedAt: new Date().toISOString()
  };

  await saveConversation(updatedConversation);
  return { conversation: updatedConversation };
}

function mergeContextSnapshot(conversation, context, options = {}) {
  if (!context || !context.url) {
    return conversation;
  }

  const now = new Date().toISOString();
  const contextHash = context.contextHash || hashText(context.contextText || "");
  const pageKey = normalizePageUrl(context.url || conversation.url || "");
  const contextChanged = contextHash && contextHash !== conversation.contextHash;
  const shouldUpdateSelection = options.allowSelectionUpdate && context.selectedText;

  if (!contextChanged && !shouldUpdateSelection && conversation.pageKey === pageKey) {
    return conversation;
  }

  return {
    ...conversation,
    pageKey,
    url: context.url || conversation.url,
    pageTitle: context.title || conversation.pageTitle || conversation.title,
    selectedText: shouldUpdateSelection ? context.selectedText : conversation.selectedText,
    title:
      shouldUpdateSelection && !conversation.titleEdited
        ? buildInitialTitle(context.selectedText)
        : conversation.title,
    contextText: contextChanged ? context.contextText || "" : conversation.contextText || "",
    contextSource: contextChanged
      ? context.contextSource || "generic"
      : conversation.contextSource || "generic",
    contextHash: contextChanged ? contextHash : conversation.contextHash || "",
    contextUpdatedAt: contextChanged ? now : conversation.contextUpdatedAt || now,
    updatedAt: contextChanged || shouldUpdateSelection ? now : conversation.updatedAt
  };
}

function shouldInjectContext(conversation) {
  const contextHash = conversation.contextHash || "";
  return Boolean(contextHash);
}

function decorateConversations(conversations, currentUrl) {
  const currentPageKey = normalizePageUrl(currentUrl || "");
  return conversations
    .map((conversation) => {
      const pageKey = conversation.pageKey || normalizePageUrl(conversation.url || "");
      return {
        ...conversation,
        pageKey,
        isCurrentPage: pageKey === currentPageKey,
        displayKey: `${pageKey || "unknown"}-${slugify(conversation.title || "untitled")}-${
          conversation.pageSequence || 1
        }`
      };
    })
    .sort((a, b) => {
      if (a.isCurrentPage !== b.isCurrentPage) {
        return a.isCurrentPage ? -1 : 1;
      }
      return sortByUpdatedAt(a, b);
    });
}

function normalizePageUrl(rawUrl) {
  if (!rawUrl) {
    return "";
  }

  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return String(rawUrl).split("#")[0];
  }
}

function getNextPageSequence(conversations, pageKey) {
  const maxSequence = conversations
    .filter((conversation) => conversation.pageKey === pageKey)
    .reduce((max, conversation) => Math.max(max, Number(conversation.pageSequence) || 0), 0);
  return maxSequence + 1;
}

function buildInitialTitle(selectedText) {
  const text = cleanTitlePart(selectedText);
  return text ? `关于：${text}` : "新追问";
}

function buildConversationTitle(selectedText, question) {
  const selected = cleanTitlePart(selectedText);
  const asked = cleanTitlePart(question);
  const title = [selected, asked].filter(Boolean).join(" / ");
  return title || "新追问";
}

function cleanTitlePart(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30);
}

function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "conversation";
}

function hashText(value) {
  const text = String(value || "");
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

function sortByUpdatedAt(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime();
}

function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The content script may have disconnected after the stream was aborted.
  }
}

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
