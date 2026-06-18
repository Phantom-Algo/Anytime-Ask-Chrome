(function anytimeAskContentScript() {
  if (window.__anytimeAskLoaded) {
    return;
  }
  window.__anytimeAskLoaded = true;

  const MESSAGE_TYPES = {
    createConversation: "AA_CREATE_CONVERSATION",
    openOrCreateConversation: "AA_OPEN_OR_CREATE_CONVERSATION",
    streamMessage: "AA_STREAM_MESSAGE",
    listConversations: "AA_LIST_CONVERSATIONS",
    loadConversation: "AA_LOAD_CONVERSATION",
    renameConversation: "AA_RENAME_CONVERSATION",
    deleteConversation: "AA_DELETE_CONVERSATION",
    openOptions: "AA_OPEN_OPTIONS",
    openFromContextMenu: "AA_OPEN_FROM_CONTEXT_MENU",
    clearConversationSelection: "AA_CLEAR_CONVERSATION_SELECTION",
    listMcpServers: "AA_LIST_MCP_SERVERS",
    updateConversationMcpServers: "AA_UPDATE_CONVERSATION_MCP_SERVERS"
  };

  const STREAM_PORT_NAME = "AA_STREAM_MESSAGE_PORT";
  const STREAM_EVENTS = {
    conversation: "conversation",
    assistantStart: "assistant-start",
    delta: "delta",
    done: "done",
    error: "error"
  };

  const MAX_CONTEXT_CHARS = 12000;
  const MAX_SELECTED_CHARS = 4000;
  const PANEL_MARGIN = 8;
  const PANEL_MIN_WIDTH = 360;
  const PANEL_HISTORY_MIN_WIDTH = 620;
  const PANEL_MIN_HEIGHT = 420;
  const SETTINGS_STORAGE_KEY = "aa_settings";
  const DEFAULT_ALLOWED_URL_PREFIXES = [
    "https://chatgpt.com/",
    "https://chat.deepseek.com/"
  ];

  const state = {
    trigger: null,
    lastSelection: null,
    panelHost: null,
    shadow: null,
    conversation: null,
    conversations: [],
    activeSelectionText: "",
    isPreparing: false,
    isStreaming: false,
    isHistoryOpen: false,
    historyWidth: 250,
    preHistoryFrame: null,
    error: "",
    streamPort: null,
    streamingAssistantId: "",
    renderScheduled: false,
    contextCache: null,
    pageVersion: 0,
    panelFrame: null,
    panelPointerState: null,
    suppressedSelectionSignature: "",
    urlAccessLoaded: false,
    isUrlAllowed: false,
    allowedUrlPrefixes: DEFAULT_ALLOWED_URL_PREFIXES,
    mcpServers: []
  };

  document.addEventListener("mouseup", handleSelectionCheckEvent, true);
  document.addEventListener("keyup", handleKeyup, true);
  document.addEventListener("selectionchange", scheduleSelectionCheck, true);
  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("pointerup", handleSelectionCheckEvent, true);
  document.addEventListener("click", handleSelectionCheckEvent, true);
  window.addEventListener("blur", clearSelectionState, true);
  window.addEventListener("scroll", hideTrigger, true);
  window.addEventListener("resize", () => {
    if (!state.panelFrame) {
      return;
    }
    state.panelFrame = clampPanelFrame(state.panelFrame);
    applyPanelFrame();
  });

  const observer = new MutationObserver((mutations) => {
    if (
      mutations.some((mutation) => {
        const target =
          mutation.target instanceof Element
            ? mutation.target
            : mutation.target.parentElement;
        return (
          target &&
          !target.closest("#anytime-ask-trigger,#anytime-ask-panel-host")
        );
      })
    ) {
      state.pageVersion += 1;
    }
  });

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  refreshUrlAccess().catch(() => {
    state.allowedUrlPrefixes = normalizeAllowedUrlPrefixes(DEFAULT_ALLOWED_URL_PREFIXES);
    state.isUrlAllowed = isCurrentUrlAllowed(state.allowedUrlPrefixes);
    state.urlAccessLoaded = true;
  });
  if (globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && changes[SETTINGS_STORAGE_KEY]) {
        refreshUrlAccess().catch(() => {
          clearSelectionState();
        });
        refreshMcpServers()
          .then(() => {
            if (state.shadow) {
              renderPanel();
            }
          })
          .catch(() => {
            state.mcpServers = [];
          });
      }
    });
  }

  // Listen for messages from the service worker (e.g. context menu clicks)
  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === MESSAGE_TYPES.openFromContextMenu) {
        openConversationWithoutSelection().catch((error) => {
          console.error('[AnytimeAsk] Context menu open failed:', error);
        });
        sendResponse({ ok: true });
        return true;
      }
      return false;
    });
  }

  function handleKeyup(event) {
    if (event.key === "Escape") {
      clearSelectionState();
      return;
    }
    scheduleSelectionCheck();
  }

  function handlePointerDown(event) {
    if (!canUseOnCurrentUrl()) {
      return;
    }

    const path = event.composedPath();
    if (path.includes(state.trigger) || path.includes(state.panelHost)) {
      return;
    }

    const currentSelection = readSelection();
    state.suppressedSelectionSignature = currentSelection
      ? getSelectionSignature(currentSelection)
      : "";
    state.lastSelection = null;
    hideTrigger();
    scheduleSelectionCheck();
  }

  function handleSelectionCheckEvent(event) {
    if (!canUseOnCurrentUrl()) {
      return;
    }

    const path = event.composedPath();
    if (path.includes(state.trigger) || path.includes(state.panelHost)) {
      return;
    }
    scheduleSelectionCheck();
  }

  function scheduleSelectionCheck() {
    window.setTimeout(() => {
      if (!canUseOnCurrentUrl()) {
        clearSelectionState();
        return;
      }

      const selection = readSelection();
      if (!selection) {
        clearSelectionState();
        state.suppressedSelectionSignature = "";
        return;
      }
      const signature = getSelectionSignature(selection);
      if (signature && signature === state.suppressedSelectionSignature) {
        state.lastSelection = null;
        hideTrigger();
        return;
      }
      state.suppressedSelectionSignature = "";
      state.lastSelection = selection;
      showTrigger(selection.rect);
    }, 60);
  }

  function readSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }

    const text = (selection.toString());
    if (text.length < 2) {
      return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0
    );
    const rect = rects[rects.length - 1] || range.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return null;
    }

    return {
      text: clip(text, MAX_SELECTED_CHARS),
      rect
    };
  }

  function showTrigger(rect) {
    if (!canUseOnCurrentUrl()) {
      return;
    }

    const trigger = ensureTrigger();
    const top = Math.min(window.innerHeight - 42, Math.max(8, rect.bottom + 8));
    const left = Math.min(
      window.innerWidth - 72,
      Math.max(8, rect.left + rect.width / 2 - 27)
    );

    trigger.style.top = `${top}px`;
    trigger.style.left = `${left}px`;
    trigger.hidden = false;
  }

  function ensureTrigger() {
    if (state.trigger) {
      return state.trigger;
    }

    const trigger = document.createElement("button");
    trigger.id = "anytime-ask-trigger";
    trigger.type = "button";
    trigger.textContent = "追问";
    trigger.hidden = true;
    trigger.addEventListener("mousedown", (event) => event.preventDefault());
    trigger.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const selection = state.lastSelection || readSelection();
      if (!selection) {
        clearSelectionState();
        return;
      }
      await openConversationForSelection(selection);
    });

    document.documentElement.appendChild(trigger);
    state.trigger = trigger;
    return trigger;
  }

  function hideTrigger() {
    if (state.trigger) {
      state.trigger.hidden = true;
    }
  }

  function clearSelectionState() {
    state.lastSelection = null;
    state.suppressedSelectionSignature = "";
    hideTrigger();
  }

  async function refreshUrlAccess() {
    const settings = await readSettingsFromStorage();
    const wasAllowed = canUseOnCurrentUrl();

    state.allowedUrlPrefixes = readAllowedUrlPrefixes(settings);
    state.isUrlAllowed = isCurrentUrlAllowed(state.allowedUrlPrefixes);
    state.urlAccessLoaded = true;

    if (wasAllowed && !state.isUrlAllowed) {
      clearSelectionState();
      closePanel();
      return;
    }

    if (!state.isUrlAllowed) {
      clearSelectionState();
    }
  }

  function readSettingsFromStorage() {
    return new Promise((resolve) => {
      if (!globalThis.chrome?.storage?.local?.get) {
        resolve(null);
        return;
      }

      try {
        chrome.storage.local.get(SETTINGS_STORAGE_KEY, (result) => {
          if (chrome.runtime?.lastError) {
            resolve(null);
            return;
          }
          resolve(result?.[SETTINGS_STORAGE_KEY] || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function canUseOnCurrentUrl() {
    return state.urlAccessLoaded && isCurrentUrlAllowed(state.allowedUrlPrefixes);
  }

  function readAllowedUrlPrefixes(settings) {
    if (Array.isArray(settings?.allowedUrlPrefixes)) {
      return normalizeAllowedUrlPrefixes(settings.allowedUrlPrefixes);
    }
    return normalizeAllowedUrlPrefixes(DEFAULT_ALLOWED_URL_PREFIXES);
  }

  function isCurrentUrlAllowed(prefixes) {
    const currentUrl = normalizeCurrentUrl(location.href);
    if (!currentUrl) {
      return false;
    }

    return normalizeAllowedUrlPrefixes(prefixes).some((prefix) =>
      currentUrl.startsWith(prefix)
    );
  }

  function getSelectionSignature(selection) {
    if (!selection) {
      return "";
    }

    const rect = selection.rect;
    return [
      selection.text,
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height)
    ].join("|");
  }

  async function openConversationForSelection(selection) {
    if (!canUseOnCurrentUrl()) {
      clearSelectionState();
      return;
    }

    clearSelectionState();
    ensurePanel();
    state.activeSelectionText = selection.text;
    state.isPreparing = true;
    state.error = "准备中...";
    renderPanel();

    try {
      const context = getContextSnapshot(selection.text);
      const response = await sendRuntimeMessage({
        type: MESSAGE_TYPES.openOrCreateConversation,
        context
      });

      if (!response?.ok) {
        throw new Error(response?.error || "打开失败");
      }

      state.conversation = response.conversation;
      state.conversations = response.conversations || state.conversations;
      state.error = "";
      await refreshHistory();
      await refreshMcpServers();
      renderPanel();
      focusComposer();
    } catch (error) {
      state.error = error.message || String(error);
      renderPanel();
    } finally {
      state.isPreparing = false;
      renderPanel();
    }
  }

  async function openConversationWithoutSelection() {
    if (!canUseOnCurrentUrl()) {
      clearSelectionState();
      return;
    }

    clearSelectionState();
    ensurePanel();
    state.activeSelectionText = '';
    state.isPreparing = true;
    state.error = '准备中...';
    renderPanel();

    try {
      const context = getContextSnapshot('');
      const response = await sendRuntimeMessage({
        type: MESSAGE_TYPES.openOrCreateConversation,
        context
      });

      if (!response?.ok) {
        throw new Error(response?.error || '打开失败');
      }

      state.conversation = response.conversation;
      state.conversations = response.conversations || state.conversations;
      state.error = '';
      await refreshHistory();
      await refreshMcpServers();
      renderPanel();
      focusComposer();
    } catch (error) {
      state.error = error.message || String(error);
      renderPanel();
    } finally {
      state.isPreparing = false;
      renderPanel();
    }
  }

  async function createNewConversation() {
    if (!canUseOnCurrentUrl()) {
      closePanel();
      return;
    }

    ensurePanel();
    state.isPreparing = true;
    state.error = "新建中...";
    renderPanel();

    try {
      const selectedText =
        state.lastSelection?.text ||
        state.activeSelectionText ||
        state.conversation?.selectedText ||
        "";
      const context = getContextSnapshot(selectedText);
      const response = await sendRuntimeMessage({
        type: MESSAGE_TYPES.createConversation,
        context
      });

      if (!response?.ok) {
        throw new Error(response?.error || "新建失败");
      }

      state.conversation = response.conversation;
      state.activeSelectionText = selectedText;
      state.conversations = response.conversations || state.conversations;
      state.error = "";
      await refreshHistory();
      await refreshMcpServers();
      renderPanel();
      focusComposer();
    } catch (error) {
      state.error = error.message || String(error);
      renderPanel();
    } finally {
      state.isPreparing = false;
      renderPanel();
    }
  }

  function getContextSnapshot(selectedText) {
    const canReuse =
      state.contextCache &&
      state.contextCache.url === location.href &&
      state.contextCache.pageVersion === state.pageVersion;

    if (canReuse) {
      return {
        ...state.contextCache,
        selectedText: clip(selectedText, MAX_SELECTED_CHARS)
      };
    }

    const structuredContext = extractStructuredChatContext();
    const context = structuredContext || extractGenericContext();
    const contextText = clip(context.text, MAX_CONTEXT_CHARS);
    const snapshot = {
      title: document.title || "未命名页面",
      url: location.href,
      selectedText: clip(selectedText, MAX_SELECTED_CHARS),
      contextText,
      contextSource: context.source,
      contextHash: hashText(
        [
          document.title || "",
          location.href,
          context.source,
          contextText
        ].join("\n")
      ),
      pageVersion: state.pageVersion
    };

    state.contextCache = {
      ...snapshot,
      selectedText: ""
    };

    return snapshot;
  }

  function extractStructuredChatContext() {
    const chatGptNodes = Array.from(
      document.querySelectorAll("[data-message-author-role]")
    );

    if (chatGptNodes.length > 0) {
      const messages = chatGptNodes
        .map((node) => {
          const role = node.getAttribute("data-message-author-role") || "message";
          const text = normalizeWhitespace(node.innerText || node.textContent || "");
          return text ? `${role}: ${text}` : "";
        })
        .filter(Boolean);

      if (messages.length > 0) {
        return {
          source: "chatgpt",
          text: messages.join("\n\n")
        };
      }
    }

    return null;
  }

  function extractGenericContext() {
    const root =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.querySelector('[role="main"]') ||
      document.body;

    if (!root) {
      return {
        source: "generic",
        text: ""
      };
    }

    const chunks = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) {
          return NodeFilter.FILTER_REJECT;
        }

        if (
          parent.closest(
            "script,style,noscript,svg,button,input,textarea,select,nav,footer,header,aside,#anytime-ask-trigger,#anytime-ask-panel-host"
          )
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        const text = normalizeWhitespace(node.nodeValue || "");
        if (text.length < 2) {
          return NodeFilter.FILTER_REJECT;
        }

        const style = window.getComputedStyle(parent);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent.getClientRects().length === 0) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let current;
    let totalLength = 0;
    while ((current = walker.nextNode())) {
      const text = normalizeWhitespace(current.nodeValue || "");
      chunks.push(text);
      totalLength += text.length;
      if (totalLength >= MAX_CONTEXT_CHARS) {
        break;
      }
    }

    return {
      source: "generic",
      text: chunks.join("\n")
    };
  }

  function ensurePanel() {
    if (state.panelHost && state.shadow) {
      state.panelHost.hidden = false;
      return;
    }

    const host = document.createElement("div");
    host.id = "anytime-ask-panel-host";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = getPanelMarkup();

    // Inject KaTeX CSS into the Shadow DOM for LaTeX rendering
    var katexStyle = document.createElement("link");
    katexStyle.rel = "stylesheet";
    katexStyle.href = chrome.runtime.getURL("src/shared/vendor/katex/katex.min.css");
    shadow.appendChild(katexStyle);

    document.documentElement.appendChild(host);

    state.panelHost = host;
    state.shadow = shadow;
    state.panelFrame = state.panelFrame || createDefaultPanelFrame();
    applyPanelFrame();

    shadow.querySelector('[data-action="close"]').addEventListener("click", closePanel);
    shadow.querySelector('[data-action="settings"]').addEventListener("click", () => {
      sendRuntimeMessage({ type: MESSAGE_TYPES.openOptions });
    });
    shadow.querySelector('[data-action="history"]').addEventListener("click", async () => {
      state.isHistoryOpen = !state.isHistoryOpen;
      if (state.isHistoryOpen) {
        // Save current frame before expanding
        state.preHistoryFrame = state.panelFrame ? { ...state.panelFrame } : null;
        expandPanelForHistory();
        await refreshHistory();
      } else {
        // Restore previous frame when closing history
        restorePanelAfterHistory();
      }
      renderPanel();
    });
    shadow.querySelector('[data-action="new"]').addEventListener("click", createNewConversation);
    shadow.querySelector('[data-action="rename"]').addEventListener("click", renameCurrentConversation);
    shadow.querySelector('[data-action="send"]').addEventListener("click", sendUserMessage);
    shadow.querySelector('[data-action="clear-quote"]').addEventListener("click", clearQuoteText);
    const textarea = shadow.querySelector("textarea");
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendUserMessage();
      }
    });
    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    });
    shadow.querySelector(".aa-header").addEventListener("pointerdown", startPanelDrag);
    shadow.querySelectorAll('[data-action="resize"]').forEach(function(handle) {
      handle.addEventListener("pointerdown", startPanelResize);
    });
    shadow
      .querySelector('[data-action="divider-resize"]')
      .addEventListener("pointerdown", startDividerResize);
  }

  function getPanelMarkup() {
    return `
      <style>
        :host {
          color-scheme: light;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        * {
          box-sizing: border-box;
        }

        button,
        textarea {
          font-family: inherit;
        }

        .aa-shell {
          position: fixed;
          top: var(--aa-panel-top, 24px);
          left: var(--aa-panel-left, calc(100vw - 454px));
          width: var(--aa-panel-width, 430px);
          height: var(--aa-panel-height, min(720px, calc(100vh - 48px)));
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          overflow: hidden;
          border: 1px solid rgba(15, 23, 42, 0.12);
          border-radius: 8px;
          background: #fbfcfd;
          box-shadow: 0 24px 80px rgba(15, 23, 42, 0.24);
          color: #111827;
          --aa-history-width: 250px;
        }

        .aa-shell[data-history-open="true"] {
          grid-template-columns: var(--aa-history-width) 4px 1fr;
        }

        .aa-history {
          display: none;
          min-width: 0;
          min-height: 0;
          grid-template-rows: auto auto 1fr;
          border-right: 1px solid #e5e7eb;
          background: #ffffff;
        }

        .aa-shell[data-history-open="true"] .aa-history {
          display: grid;
        }

        .aa-history-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 12px;
          border-bottom: 1px solid #e5e7eb;
        }

        .aa-history-title {
          display: grid;
          gap: 2px;
          min-width: 0;
        }

        .aa-history-title strong {
          color: #0f172a;
          font-size: 14px;
          line-height: 18px;
        }

        .aa-history-title span {
          color: #64748b;
          font-size: 12px;
          line-height: 16px;
        }

        .aa-history-list {
          min-height: 0;
          overflow: auto;
          padding: 10px;
        }

        .aa-history-group {
          display: grid;
          gap: 8px;
          margin-bottom: 12px;
        }

        .aa-history-group-label {
          color: #64748b;
          font-size: 12px;
          font-weight: 700;
          line-height: 16px;
        }

        .aa-history-item {
          display: grid;
          gap: 4px;
          width: 100%;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          background: #ffffff;
          color: #111827;
          cursor: pointer;
          padding: 9px;
          text-align: left;
          position: relative;
        }

        .aa-history-item:hover,
        .aa-history-item[data-active="true"] {
          border-color: #0f766e;
          background: #f0fdfa;
        }

        .aa-history-item strong,
        .aa-history-item span,
        .aa-history-item small {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .aa-history-item strong {
          font-size: 13px;
          line-height: 17px;
        }

        .aa-history-item span {
          color: #475569;
          font-size: 12px;
          line-height: 16px;
        }

        .aa-history-item small {
          color: #64748b;
          font-size: 11px;
          line-height: 15px;
        }

        .aa-history-item-delete {
          position: absolute;
          top: 6px;
          right: 6px;
          width: 22px;
          height: 22px;
          display: none;
          align-items: center;
          justify-content: center;
          border: 0;
          border-radius: 4px;
          background: transparent;
          color: #94a3b8;
          font-size: 16px;
          line-height: 1;
          cursor: pointer;
          padding: 0;
        }

        .aa-history-item:hover .aa-history-item-delete,
        .aa-history-item[data-active="true"] .aa-history-item-delete {
          display: flex;
        }

        .aa-history-item-delete:hover {
          background: #fee2e2;
          color: #ef4444;
        }

        .aa-panel {
          min-width: 0;
          display: grid;
          grid-template-rows: auto auto auto auto 1fr auto;
          overflow: hidden;
          background: #fbfcfd;
          color: #111827;
        }

        .aa-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          min-height: 52px;
          padding: 12px 14px;
          border-bottom: 1px solid #e5e7eb;
          background: #ffffff;
          cursor: move;
          user-select: none;
          -webkit-user-select: none;
        }

        .aa-title {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 2px;
        }

        .aa-title strong {
          color: #0f172a;
          font-size: 14px;
          line-height: 18px;
        }

        .aa-title span {
          overflow: hidden;
          color: #64748b;
          font-size: 12px;
          line-height: 16px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .aa-actions {
          display: flex;
          flex: 0 0 auto;
          gap: 6px;
        }

        .aa-icon-button,
        .aa-small-button,
        .aa-send {
          border: 1px solid #d1d5db;
          background: #ffffff;
          color: #111827;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          line-height: 1;
        }

        textarea,
        .aa-icon-button,
        .aa-small-button,
        .aa-send {
          cursor: auto;
        }

        .aa-icon-button {
          display: inline-grid;
          place-items: center;
          width: 32px;
          height: 32px;
          border-radius: 7px;
          padding: 0;
          cursor: pointer;
        }

        .aa-icon-button svg {
          width: 17px;
          height: 17px;
          stroke: currentColor;
        }

        .aa-small-button {
          height: 32px;
          border-radius: 7px;
          padding: 0 10px;
          cursor: pointer;
        }

        .aa-icon-button:hover,
        .aa-small-button:hover,
        .aa-send:hover {
          border-color: #0f766e;
          color: #0f766e;
        }

        .aa-quote {
          display: none;
          gap: 6px;
          padding: 12px 14px;
          border-bottom: 1px solid #e5e7eb;
          background: #f8fafc;
        }

        .aa-quote[data-visible="true"] {
          display: grid;
        }

        .aa-quote-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .aa-quote-label {
          color: #64748b;
          font-size: 12px;
          line-height: 16px;
        }

        .aa-quote-clear {
          width: 20px;
          height: 20px;
          padding: 2px;
          border: none;
          background: transparent;
          color: #94a3b8;
          transition: color 0.15s ease;
        }

        .aa-quote-clear svg {
          width: 14px;
          height: 14px;
        }

        .aa-quote-clear:hover {
          color: #ef4444;
          border-color: transparent;
        }

        .aa-quote-text {
          max-height: 86px;
          overflow: auto;
          color: #1f2937;
          font-size: 13px;
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .aa-mcp {
          display: none;
          gap: 8px;
          padding: 10px 14px;
          border-bottom: 1px solid #e5e7eb;
          background: #ffffff;
        }

        .aa-mcp[data-visible="true"] {
          display: grid;
        }

        .aa-mcp-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          color: #334155;
          font-size: 12px;
          font-weight: 700;
          line-height: 16px;
        }

        .aa-mcp-header small {
          overflow: hidden;
          color: #64748b;
          font-size: 11px;
          font-weight: 600;
          line-height: 15px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .aa-mcp-list {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .aa-mcp-option {
          display: inline-flex;
          align-items: center;
          max-width: 100%;
          gap: 6px;
          min-height: 28px;
          border: 1px solid #dbe3ef;
          border-radius: 7px;
          background: #f8fafc;
          color: #334155;
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
          line-height: 16px;
          padding: 5px 8px;
        }

        .aa-mcp-option input {
          width: 14px;
          height: 14px;
          margin: 0;
          flex: 0 0 auto;
        }

        .aa-mcp-option span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .aa-mcp-option[data-selected="true"] {
          border-color: #0f766e;
          background: #f0fdfa;
          color: #0f766e;
        }

        .aa-mcp-option[data-disabled="true"] {
          cursor: not-allowed;
          opacity: 0.62;
        }

        .aa-status {
          display: none;
          padding: 10px 14px;
          border-bottom: 1px solid #e5e7eb;
          background: #fff7ed;
          color: #9a3412;
          font-size: 13px;
          line-height: 1.45;
        }

        .aa-status[data-visible="true"] {
          display: block;
        }

        .aa-messages {
          min-height: 0;
          overflow: auto;
          padding: 14px;
          background: #fbfcfd;
        }

        .aa-empty {
          margin: 18px 0;
          color: #64748b;
          font-size: 13px;
          line-height: 1.6;
          text-align: center;
        }

        .aa-message {
          display: grid;
          gap: 6px;
          margin-bottom: 12px;
        }

        .aa-role {
          color: #64748b;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0;
          text-transform: uppercase;
        }

        .aa-bubble {
          min-width: 0;
          max-width: 100%;
          padding: 10px 11px;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          background: #ffffff;
          color: #111827;
          font-size: 13px;
          line-height: 1.65;
          white-space: pre-wrap;
          word-break: break-word;
        }

        .aa-message[data-role="user"] {
          justify-items: end;
        }

        .aa-message[data-role="user"] .aa-bubble {
          width: fit-content;
          max-width: 85%;
          border-color: #0f766e;
          background: #0f766e;
          color: #ffffff;
        }

        .aa-message[data-role="assistant"] .aa-bubble {
          width: 100%;
        }

        /* ── Markdown body ──────────────────────────────────── */
        .aa-markdown {
          white-space: normal;
          line-height: 1.65;
          word-break: break-word;
        }

        /* ── Block spacing ──────────────────────────────────── */
        .aa-markdown h1,
        .aa-markdown h2,
        .aa-markdown h3,
        .aa-markdown h4,
        .aa-markdown h5,
        .aa-markdown h6,
        .aa-markdown p,
        .aa-markdown ul,
        .aa-markdown ol,
        .aa-markdown blockquote,
        .aa-markdown pre,
        .aa-markdown table,
        .aa-markdown hr,
        .aa-markdown details {
          margin: 0 0 10px;
        }

        .aa-markdown > :last-child {
          margin-bottom: 0;
        }

        /* ── Headings ───────────────────────────────────────── */
        .aa-markdown h1 { font-size: 1.4em; font-weight: 700; line-height: 1.3; }
        .aa-markdown h2 { font-size: 1.25em; font-weight: 700; line-height: 1.35; }
        .aa-markdown h3 { font-size: 1.12em; font-weight: 700; line-height: 1.4; }
        .aa-markdown h4 { font-size: 1.05em; font-weight: 700; line-height: 1.4; }
        .aa-markdown h5 { font-size: 1em; font-weight: 700; line-height: 1.45; }
        .aa-markdown h6 { font-size: 0.92em; font-weight: 700; color: #475569; line-height: 1.45; }

        /* ── Lists ──────────────────────────────────────────── */
        .aa-markdown ul,
        .aa-markdown ol {
          padding-left: 24px;
        }

        .aa-markdown li {
          margin-bottom: 2px;
        }

        .aa-markdown li > ul,
        .aa-markdown li > ol {
          margin-top: 2px;
          margin-bottom: 2px;
        }

        /* GFM task list */
        .aa-markdown ul > li.task-list-item {
          list-style: none;
          margin-left: -20px;
        }

        .aa-markdown ul > li.task-list-item > input[type="checkbox"] {
          margin: 0 6px 0 0;
          vertical-align: middle;
        }

        /* ── Horizontal rule ────────────────────────────────── */
        .aa-markdown hr {
          border: 0;
          border-top: 1px solid #e5e7eb;
          height: 0;
        }

        /* ── Tables ─────────────────────────────────────────── */
        .aa-markdown table.md-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
          display: block;
          overflow: auto;
        }

        .aa-markdown table.md-table th,
        .aa-markdown table.md-table td {
          border: 1px solid #d1d5db;
          padding: 6px 12px;
          text-align: left;
          min-width: 60px;
        }

        .aa-markdown table.md-table th {
          background: #f1f5f9;
          font-weight: 700;
          white-space: nowrap;
        }

        .aa-markdown table.md-table tr:nth-child(even) td {
          background: #fafafa;
        }

        /* ── Inline code ────────────────────────────────────── */
        .aa-markdown code {
          border-radius: 4px;
          background: #f1f5f9;
          color: #0f172a;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 0.88em;
          padding: 1px 5px;
        }

        /* ── Code blocks (base) ─────────────────────────────── */
        .aa-markdown pre {
          overflow: auto;
          border-radius: 8px;
          background: #0d1117;
          color: #c9d1d9;
          padding: 12px;
          font-size: 12px;
          line-height: 1.55;
        }

        .aa-markdown pre code {
          background: transparent;
          color: inherit;
          padding: 0;
          font-size: inherit;
        }

        /* ── highlight.js theme (GitHub Dark adapted) ──────── */
        .aa-markdown .hljs-keyword,
        .aa-markdown .hljs-doctag,
        .aa-markdown .hljs-meta .hljs-keyword,
        .aa-markdown .hljs-template-tag,
        .aa-markdown .hljs-template-variable,
        .aa-markdown .hljs-type,
        .aa-markdown .hljs-variable.language_ { color: #ff7b72; }

        .aa-markdown .hljs-title,
        .aa-markdown .hljs-title.class_,
        .aa-markdown .hljs-title.class_.inherited__,
        .aa-markdown .hljs-title.function_ { color: #d2a8ff; }

        .aa-markdown .hljs-attr,
        .aa-markdown .hljs-attribute,
        .aa-markdown .hljs-literal,
        .aa-markdown .hljs-meta,
        .aa-markdown .hljs-number,
        .aa-markdown .hljs-operator,
        .aa-markdown .hljs-selector-attr,
        .aa-markdown .hljs-selector-class,
        .aa-markdown .hljs-selector-id,
        .aa-markdown .hljs-variable { color: #79c0ff; }

        .aa-markdown .hljs-meta .hljs-string,
        .aa-markdown .hljs-regexp,
        .aa-markdown .hljs-string { color: #a5d6ff; }

        .aa-markdown .hljs-built_in,
        .aa-markdown .hljs-symbol { color: #ffa657; }

        .aa-markdown .hljs-code,
        .aa-markdown .hljs-comment,
        .aa-markdown .hljs-formula { color: #8b949e; }

        .aa-markdown .hljs-name,
        .aa-markdown .hljs-quote,
        .aa-markdown .hljs-selector-pseudo,
        .aa-markdown .hljs-selector-tag { color: #7ee787; }

        .aa-markdown .hljs-subst { color: #c9d1d9; }

        .aa-markdown .hljs-section { color: #1f6feb; font-weight: 700; }

        .aa-markdown .hljs-bullet { color: #f2cc60; }

        .aa-markdown .hljs-emphasis { font-style: italic; }

        .aa-markdown .hljs-strong { font-weight: 700; }

        .aa-markdown .hljs-addition { color: #aff5b4; background-color: #033a16; }

        .aa-markdown .hljs-deletion { color: #ffdcd7; background-color: #67060c; }

        /* ── Blockquote ─────────────────────────────────────── */
        .aa-markdown blockquote {
          border-left: 3px solid #0f766e;
          color: #475569;
          padding: 4px 0 4px 14px;
          margin-left: 0;
        }

        .aa-markdown blockquote > :last-child {
          margin-bottom: 0;
        }

        /* nested blockquote */
        .aa-markdown blockquote blockquote {
          border-left-color: #94a3b8;
        }

        /* ── Links ──────────────────────────────────────────── */
        .aa-markdown a {
          color: #0f766e;
          text-decoration: underline;
        }

        .aa-markdown a:hover {
          color: #0d5b55;
        }

        /* ── Images ─────────────────────────────────────────── */
        .aa-markdown img {
          max-width: 100%;
          border-radius: 6px;
        }

        /* ── Inline emphasis ────────────────────────────────── */
        .aa-markdown strong { font-weight: 700; }
        .aa-markdown em { font-style: italic; }
        .aa-markdown del,
        .aa-markdown s { color: #94a3b8; text-decoration: line-through; }

        /* ── Details / summary (GFM) ────────────────────────── */
        .aa-markdown details {
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          padding: 8px 12px;
        }

        .aa-markdown summary {
          cursor: pointer;
          font-weight: 600;
        }

        /* Three-dot bouncing loader */
        .aa-dot-loader {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px 0;
        }

        .aa-dot-loader span {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #94a3b8;
          animation: aa-bounce 1.4s infinite ease-in-out both;
        }

        .aa-dot-loader span:nth-child(1) { animation-delay: -0.32s; }
        .aa-dot-loader span:nth-child(2) { animation-delay: -0.16s; }
        .aa-dot-loader span:nth-child(3) { animation-delay: 0s; }

        @keyframes aa-bounce {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1); }
        }

        /* Sidebar divider resize handle */
        .aa-divider {
          display: none;
          width: 4px;
          cursor: col-resize;
          background: transparent;
          transition: background 0.15s;
          flex-shrink: 0;
        }

        .aa-divider:hover {
          background: rgba(15, 118, 110, 0.25);
        }

        .aa-shell[data-history-open="true"] .aa-divider {
          display: block;
        }

        .aa-composer {
          display: flex;
          align-items: flex-end;
          gap: 8px;
          padding: 10px 12px;
          border-top: 1px solid #e5e7eb;
          background: #ffffff;
        }

        textarea {
          flex: 1;
          min-height: 38px;
          max-height: 120px;
          resize: none;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 8px 10px;
          color: #111827;
          font-size: 13px;
          line-height: 1.5;
          outline: none;
          font-family: inherit;
        }

        textarea:focus {
          border-color: #0f766e;
          box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.12);
        }

        .aa-composer-row {
          display: none;
        }

        .aa-hint {
          display: none;
        }

        .aa-send {
          min-width: 56px;
          height: 38px;
          border-radius: 8px;
          border: 0;
          background: #111827;
          color: #ffffff;
          cursor: pointer;
          font-size: 13px;
          font-weight: 700;
          flex-shrink: 0;
        }

        .aa-resize-handle {
          position: absolute;
          border: 0;
          padding: 0;
          background: transparent;
          z-index: 1;
        }

        .aa-resize-handle[data-edge="left"] {
          left: -3px;
          top: 0;
          bottom: 0;
          width: 6px;
          cursor: ew-resize;
        }

        .aa-resize-handle[data-edge="right"] {
          right: -3px;
          top: 0;
          bottom: 0;
          width: 6px;
          cursor: ew-resize;
        }

        .aa-resize-handle[data-edge="bottom"] {
          left: 0;
          right: 0;
          bottom: -3px;
          height: 6px;
          cursor: ns-resize;
        }

        .aa-resize-handle[data-edge="corner"] {
          right: -2px;
          bottom: -2px;
          width: 14px;
          height: 14px;
          cursor: nwse-resize;
        }

        .aa-send:hover {
          border-color: #111827;
          background: #0f766e;
          color: #ffffff;
        }

        .aa-send:disabled,
        textarea:disabled,
        .aa-icon-button:disabled,
        .aa-small-button:disabled {
          cursor: not-allowed;
          opacity: 0.62;
        }

        @media (max-width: 760px) {
          .aa-shell,
          .aa-shell[data-history-open="true"] {
            grid-template-columns: 1fr;
          }

          .aa-history {
            max-height: 240px;
            border-right: 0;
            border-bottom: 1px solid #e5e7eb;
          }

          .aa-shell:not([data-history-open="true"]) .aa-history {
            display: none;
          }

          .aa-divider {
            display: none !important;
          }
        }

        /* ── KaTeX math rendering ───────────────────────── */
        .katex-display {
          display: block;
          margin: 10px 0;
          overflow-x: auto;
          overflow-y: hidden;
        }

        .katex-display > .katex {
          display: block;
          text-align: center;
        }

        .katex {
          font-size: 1.05em;
          line-height: 1.2;
        }

        /* Raw LaTeX fallback (shown when KaTeX fails to render) */
        .aa-latex-raw {
          display: inline-block;
          border-radius: 4px;
          background: #fff7ed;
          color: #9a3412;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 0.88em;
          padding: 1px 6px;
        }
      </style>
      <div class="aa-shell" data-history-open="false">
        <section class="aa-history">
          <header class="aa-history-header">
            <div class="aa-history-title">
              <strong>历史</strong>
              <span data-field="history-count">0</span>
            </div>
            <button class="aa-small-button" type="button" data-action="new">+ 新会话</button>
          </header>
          <div class="aa-status" data-field="history-status"></div>
          <main class="aa-history-list" data-field="history-list"></main>
        </section>
        <div class="aa-divider" data-action="divider-resize"></div>
        <aside class="aa-panel">
          <header class="aa-header">
            <div class="aa-title">
              <strong data-field="conversation-title">Anytime Ask</strong>
              <span data-field="source-title"></span>
            </div>
            <div class="aa-actions">
              <button class="aa-icon-button" type="button" data-action="history" title="历史">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 7v5l3 2"/></svg>
              </button>
              <button class="aa-icon-button" type="button" data-action="rename" title="重命名">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <button class="aa-icon-button" type="button" data-action="settings" title="设置">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.3 7A2 2 0 1 1 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>
              </button>
              <button class="aa-icon-button" type="button" data-action="close" title="关闭">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>
          </header>
          <section class="aa-quote">
            <div class="aa-quote-header">
              <div class="aa-quote-label" data-field="quote-label">划选内容</div>
              <button class="aa-icon-button aa-quote-clear" type="button" data-action="clear-quote" title="清除划选内容">
                <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>
              </button>
            </div>
            <div class="aa-quote-text" data-field="quote"></div>
          </section>
          <section class="aa-mcp" data-field="mcp">
            <div class="aa-mcp-header">
              <span>MCP</span>
              <small data-field="mcp-summary">未启用</small>
            </div>
            <div class="aa-mcp-list" data-field="mcp-list"></div>
          </section>
          <div class="aa-status" data-field="status"></div>
          <main class="aa-messages" data-field="messages"></main>
          <footer class="aa-composer">
            <textarea placeholder="输入追问..." data-field="input" rows="1"></textarea>
            <button class="aa-send" type="button" data-action="send">发送</button>
          </footer>
        </aside>
        <button class="aa-resize-handle" type="button" data-action="resize" data-edge="left"></button>
        <button class="aa-resize-handle" type="button" data-action="resize" data-edge="right"></button>
        <button class="aa-resize-handle" type="button" data-action="resize" data-edge="bottom"></button>
        <button class="aa-resize-handle" type="button" data-action="resize" data-edge="corner"></button>
      </div>
    `;
  }

  function createDefaultPanelFrame() {
    const width = Math.min(430, Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_MARGIN * 2));
    const height = Math.min(720, Math.max(PANEL_MIN_HEIGHT, window.innerHeight - 48));
    return clampPanelFrame({
      left: window.innerWidth - width - 24,
      top: 24,
      width,
      height
    });
  }

  function applyPanelFrame() {
    if (!state.shadow || !state.panelFrame) {
      return;
    }

    const shell = state.shadow.querySelector(".aa-shell");
    if (!shell) {
      return;
    }

    const frame = clampPanelFrame(state.panelFrame);
    state.panelFrame = frame;
    shell.style.setProperty("--aa-panel-left", `${frame.left}px`);
    shell.style.setProperty("--aa-panel-top", `${frame.top}px`);
    shell.style.setProperty("--aa-panel-width", `${frame.width}px`);
    shell.style.setProperty("--aa-panel-height", `${frame.height}px`);
    shell.style.setProperty("--aa-history-width", `${state.historyWidth || 250}px`);
  }

  function expandPanelForHistory() {
    if (!state.panelFrame) {
      state.panelFrame = createDefaultPanelFrame();
    }

    // Ensure panel is wide enough for history + main content
    const minTotalWidth = state.historyWidth + 360;
    const maxWidth = Math.max(0, window.innerWidth - PANEL_MARGIN * 2);
    const targetWidth = Math.min(Math.max(minTotalWidth, 680), maxWidth);
    if (state.panelFrame.width >= targetWidth) {
      applyHistoryWidthVar();
      return;
    }

    const delta = targetWidth - state.panelFrame.width;
    state.panelFrame = clampPanelFrame({
      ...state.panelFrame,
      left: Math.max(PANEL_MARGIN, state.panelFrame.left - delta),
      width: targetWidth
    });
    applyPanelFrame();
    applyHistoryWidthVar();
  }

  function applyHistoryWidthVar() {
    if (!state.shadow) return;
    const shell = state.shadow.querySelector(".aa-shell");
    if (shell) {
      shell.style.setProperty("--aa-history-width", state.historyWidth + "px");
    }
  }

  function restorePanelAfterHistory() {
    if (state.preHistoryFrame) {
      state.panelFrame = clampPanelFrame(state.preHistoryFrame);
      state.preHistoryFrame = null;
      applyPanelFrame();
    }
  }

  function clampPanelFrame(frame) {
    const maxWidth = Math.max(260, window.innerWidth - PANEL_MARGIN * 2);
    const maxHeight = Math.max(260, window.innerHeight - PANEL_MARGIN * 2);
    const desiredMinWidth = state.isHistoryOpen ? PANEL_HISTORY_MIN_WIDTH : PANEL_MIN_WIDTH;
    const minWidth = Math.min(desiredMinWidth, maxWidth);
    const minHeight = Math.min(PANEL_MIN_HEIGHT, maxHeight);
    const width = clamp(Number(frame.width) || minWidth, minWidth, maxWidth);
    const height = clamp(Number(frame.height) || minHeight, minHeight, maxHeight);
    const left = clamp(Number(frame.left) || PANEL_MARGIN, PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
    const top = clamp(Number(frame.top) || PANEL_MARGIN, PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN);

    return {
      left,
      top,
      width,
      height
    };
  }

  function startPanelDrag(event) {
    if (event.button !== 0 || shouldIgnorePanelPointer(event.target)) {
      return;
    }

    event.preventDefault();
    state.panelFrame = state.panelFrame || createDefaultPanelFrame();
    state.panelPointerState = {
      type: "drag",
      startX: event.clientX,
      startY: event.clientY,
      startFrame: { ...state.panelFrame }
    };
    beginPanelPointerTracking();
  }

  function startPanelResize(event) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const edge = event.currentTarget.dataset.edge || "corner";
    state.panelFrame = state.panelFrame || createDefaultPanelFrame();
    state.panelPointerState = {
      type: "resize",
      edge: edge,
      startX: event.clientX,
      startY: event.clientY,
      startFrame: { ...state.panelFrame }
    };
    beginPanelPointerTracking();
  }

  function startDividerResize(event) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const shell = state.shadow.querySelector(".aa-shell");
    const historyWidth = state.historyWidth || 250;
    state.panelPointerState = {
      type: "divider",
      startX: event.clientX,
      startHistoryWidth: historyWidth
    };
    shell.style.setProperty("--aa-history-width", historyWidth + "px");
    beginPanelPointerTracking();
  }

  function beginPanelPointerTracking() {
    document.addEventListener("pointermove", handlePanelPointerMove, true);
    document.addEventListener("pointerup", stopPanelPointerTracking, true);
    document.addEventListener("pointercancel", stopPanelPointerTracking, true);
  }

  function handlePanelPointerMove(event) {
    if (!state.panelPointerState) {
      return;
    }

    event.preventDefault();
    const pointerState = state.panelPointerState;
    const deltaX = event.clientX - pointerState.startX;
    const deltaY = event.clientY - pointerState.startY;

    if (pointerState.type === "drag") {
      state.panelFrame = clampPanelFrame({
        ...pointerState.startFrame,
        left: pointerState.startFrame.left + deltaX,
        top: pointerState.startFrame.top + deltaY
      });
      applyPanelFrame();
      return;
    }

    if (pointerState.type === "divider") {
      const minW = 180;
      const maxW = state.panelFrame
        ? state.panelFrame.width - 320
        : 400;
      const newW = clamp(pointerState.startHistoryWidth + deltaX, minW, Math.max(minW, maxW));
      state.historyWidth = newW;
      const shell = state.shadow.querySelector(".aa-shell");
      if (shell) shell.style.setProperty("--aa-history-width", newW + "px");
      return;
    }

    // Edge-specific resizing
    var nextFrame = { ...pointerState.startFrame };
    var edge = pointerState.edge || "corner";

    if (edge === "left") {
      nextFrame.width = pointerState.startFrame.width - deltaX;
      nextFrame.left = pointerState.startFrame.left + deltaX;
    } else if (edge === "right") {
      nextFrame.width = pointerState.startFrame.width + deltaX;
    } else if (edge === "bottom") {
      nextFrame.height = pointerState.startFrame.height + deltaY;
    } else {
      // corner: original behavior
      nextFrame.width = pointerState.startFrame.width + deltaX;
      nextFrame.height = pointerState.startFrame.height + deltaY;
    }

    state.panelFrame = clampPanelFrame(nextFrame);
    applyPanelFrame();
  }

  function stopPanelPointerTracking() {
    state.panelPointerState = null;
    document.removeEventListener("pointermove", handlePanelPointerMove, true);
    document.removeEventListener("pointerup", stopPanelPointerTracking, true);
    document.removeEventListener("pointercancel", stopPanelPointerTracking, true);
  }

  function shouldIgnorePanelPointer(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(
      target.closest(
        "button,textarea,input,select,a,[data-action],.aa-history,.aa-messages,.aa-quote,.aa-mcp"
      )
    );
  }

  function clamp(value, min, max) {
    if (max < min) {
      return min;
    }
    return Math.min(max, Math.max(min, value));
  }

  async function refreshHistory() {
    const response = await sendRuntimeMessage({
      type: MESSAGE_TYPES.listConversations,
      currentUrl: location.href
    });
    if (response?.ok) {
      state.conversations = response.conversations || [];
    }
  }

  async function refreshMcpServers() {
    const response = await sendRuntimeMessage({
      type: MESSAGE_TYPES.listMcpServers
    });
    if (response?.ok) {
      state.mcpServers = response.mcpServers || [];
    }
  }

  function renderPanel() {
    if (!state.shadow) {
      return;
    }

    const shell = state.shadow.querySelector(".aa-shell");
    shell.dataset.historyOpen = state.isHistoryOpen ? "true" : "false";

    const conversation = state.conversation;
    state.shadow.querySelector('[data-field="conversation-title"]').textContent =
      conversation?.title || "Anytime Ask";
    state.shadow.querySelector('[data-field="source-title"]').textContent =
      conversation?.pageTitle || document.title || "";
    const quoteText = state.activeSelectionText || conversation?.selectedText || "";
    state.shadow.querySelector('[data-field="quote"]').textContent = quoteText;
    const quoteSection = state.shadow.querySelector(".aa-quote");
    quoteSection.dataset.visible = quoteText ? "true" : "false";

    renderMessages();
    renderHistory();
    renderMcpSelector();
    setStatus(state.error);
    setComposerDisabled(state.isPreparing || state.isStreaming);
  }

  function renderMcpSelector() {
    if (!state.shadow) {
      return;
    }

    const section = state.shadow.querySelector('[data-field="mcp"]');
    const list = state.shadow.querySelector('[data-field="mcp-list"]');
    const summary = state.shadow.querySelector('[data-field="mcp-summary"]');
    const servers = state.mcpServers || [];
    const selectedIds = new Set(state.conversation?.mcpServerIds || []);

    list.textContent = "";
    section.dataset.visible = servers.length ? "true" : "false";
    if (!servers.length) {
      summary.textContent = "未配置";
      return;
    }

    const selectedCount = servers.filter((server) => selectedIds.has(server.id)).length;
    summary.textContent = state.conversation
      ? `${selectedCount}/${servers.length} 已启用`
      : "先创建会话";

    for (const server of servers) {
      const checked = selectedIds.has(server.id);
      const disabled = !state.conversation || state.isPreparing || state.isStreaming;
      const label = document.createElement("label");
      label.className = "aa-mcp-option";
      label.dataset.selected = checked ? "true" : "false";
      label.dataset.disabled = disabled ? "true" : "false";
      label.title = [server.name, server.type, server.description].filter(Boolean).join(" · ");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = checked;
      checkbox.disabled = disabled;
      checkbox.addEventListener("change", () => {
        updateConversationMcpSelection(server.id, checkbox.checked);
      });

      const name = document.createElement("span");
      name.textContent = server.name || server.id;

      label.append(checkbox, name);
      list.appendChild(label);
    }
  }

  function renderHistory() {
    if (!state.shadow) {
      return;
    }

    const list = state.shadow.querySelector('[data-field="history-list"]');
    const count = state.shadow.querySelector('[data-field="history-count"]');
    list.textContent = "";
    count.textContent = String(state.conversations.length);

    if (!state.conversations.length) {
      const empty = document.createElement("div");
      empty.className = "aa-empty";
      empty.textContent = "暂无";
      list.appendChild(empty);
      return;
    }

    const current = state.conversations.filter((item) => item.isCurrentPage);
    const others = state.conversations.filter((item) => !item.isCurrentPage);
    appendHistoryGroup(list, "当前页面会话", current);
    appendHistoryGroup(list, "其他页面会话", others);
  }

  function appendHistoryGroup(container, label, conversations) {
    if (!conversations.length) {
      return;
    }

    const group = document.createElement("section");
    group.className = "aa-history-group";

    const heading = document.createElement("div");
    heading.className = "aa-history-group-label";
    heading.textContent = label;
    group.appendChild(heading);

    for (const conversation of conversations) {
      group.appendChild(createHistoryItem(conversation));
    }

    container.appendChild(group);
  }

  function createHistoryItem(conversation) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "aa-history-item";
    item.dataset.active = conversation.id === state.conversation?.id ? "true" : "false";
    item.addEventListener("click", () => loadConversation(conversation.id));

    const title = document.createElement("strong");
    title.textContent = conversation.title || "未命名";

    const selected = document.createElement("span");
    selected.textContent = conversation.selectedText || "无内容";

    const meta = document.createElement("small");
    meta.textContent = `#${conversation.pageSequence || 1} · ${formatDate(
      conversation.updatedAt
    )}`;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "aa-history-item-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = "删除";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      deleteConversationFromPanel(conversation.id);
    });

    item.append(title, selected, meta, deleteBtn);
    return item;
  }

  async function deleteConversationFromPanel(conversationId) {
    if (!conversationId) {
      return;
    }

    const response = await sendRuntimeMessage({
      type: MESSAGE_TYPES.deleteConversation,
      conversationId,
      currentUrl: location.href
    });

    if (response?.ok) {
      state.conversations = response.conversations || [];
      if (state.conversation?.id === conversationId) {
        state.conversation = null;
        state.activeSelectionText = "";
      }
      renderPanel();
    }
  }

  async function clearQuoteText() {
    const quoteText = state.activeSelectionText || state.conversation?.selectedText || "";
    if (!quoteText) {
      return;
    }

    state.activeSelectionText = "";

    if (state.conversation?.id) {
      // Update the local conversation state immediately for instant UI feedback
      state.conversation = { ...state.conversation, selectedText: "" };

      // Persist the change to storage in the background
      sendRuntimeMessage({
        type: MESSAGE_TYPES.clearConversationSelection,
        conversationId: state.conversation.id
      }).catch(() => {
        // Silently ignore background errors — local state is already updated
      });
    }

    renderPanel();
  }

  async function loadConversation(conversationId) {
    state.error = "";
    const response = await sendRuntimeMessage({
      type: MESSAGE_TYPES.loadConversation,
      conversationId
    });

    if (!response?.ok) {
      state.error = response?.error || "加载失败";
      renderPanel();
      return;
    }

    state.conversation = response.conversation;
    state.activeSelectionText = response.conversation.selectedText || "";
    renderPanel();
    focusComposer();
  }

  async function updateConversationMcpSelection(serverId, enabled) {
    if (!state.conversation?.id) {
      return;
    }

    const availableIds = new Set((state.mcpServers || []).map((server) => server.id));
    const selectedIds = new Set(state.conversation.mcpServerIds || []);
    if (enabled) {
      selectedIds.add(serverId);
    } else {
      selectedIds.delete(serverId);
    }

    const nextIds = [...selectedIds].filter((id) => availableIds.has(id));
    const previousConversation = state.conversation;
    state.conversation = {
      ...state.conversation,
      mcpServerIds: nextIds
    };
    renderPanel();

    const response = await sendRuntimeMessage({
      type: MESSAGE_TYPES.updateConversationMcpServers,
      conversationId: state.conversation.id,
      mcpServerIds: nextIds
    });

    if (!response?.ok) {
      state.conversation = previousConversation;
      state.error = response?.error || "MCP 选择保存失败";
      renderPanel();
      return;
    }

    state.conversation = response.conversation;
    state.mcpServers = response.mcpServers || state.mcpServers;
    state.error = "";
    await refreshHistory();
    renderPanel();
  }

  async function renameCurrentConversation() {
    if (!state.conversation) {
      return;
    }

    const title = window.prompt("编辑会话标题", state.conversation.title || "");
    if (title === null) {
      return;
    }

    const response = await sendRuntimeMessage({
      type: MESSAGE_TYPES.renameConversation,
      conversationId: state.conversation.id,
      title
    });

    if (!response?.ok) {
      state.error = response?.error || "重命名失败";
      renderPanel();
      return;
    }

    state.conversation = response.conversation;
    await refreshHistory();
    renderPanel();
  }

  function renderMessages() {
    const container = state.shadow.querySelector('[data-field="messages"]');
    container.textContent = "";

    const messages = state.conversation?.messages || [];
    if (messages.length === 0 && !state.isStreaming) {
      // Don't show placeholder text — keep it clean
      return;
    }

    for (const message of messages) {
      container.appendChild(createMessageNode(message));
    }

    container.scrollTop = container.scrollHeight;
  }

  function scheduleRenderMessages() {
    if (state.renderScheduled) {
      return;
    }

    state.renderScheduled = true;
    requestAnimationFrame(() => {
      state.renderScheduled = false;
      renderPanel();
    });
  }

  function createMessageNode(message) {
    const wrapper = document.createElement("article");
    wrapper.className = "aa-message";
    wrapper.dataset.role = message.role;

    const role = document.createElement("div");
    role.className = "aa-role";
    role.textContent = message.role === "user" ? "你" : "AI";

    const bubble = document.createElement("div");
    bubble.className = "aa-bubble";

    if (message.role === "assistant") {
      bubble.classList.add("aa-markdown");
      if (message.content && globalThis.AnytimeAskMarkdown?.renderMarkdown) {
        globalThis.AnytimeAskMarkdown.renderMarkdown(message.content, bubble);
      } else if (state.isStreaming) {
        // Show bouncing dot animation for streaming
        const loader = document.createElement("div");
        loader.className = "aa-dot-loader";
        loader.appendChild(document.createElement("span"));
        loader.appendChild(document.createElement("span"));
        loader.appendChild(document.createElement("span"));
        bubble.appendChild(loader);
      } else {
        bubble.textContent = "";
      }
    } else {
      bubble.textContent = message.content || "";
    }

    wrapper.append(role, bubble);
    return wrapper;
  }

  async function sendUserMessage() {
    if (!canUseOnCurrentUrl() || state.isPreparing || state.isStreaming) {
      return;
    }

    const input = state.shadow.querySelector('[data-field="input"]');
    const content = input.value.trim();
    if (!content) {
      return;
    }

    const selectedText = state.activeSelectionText || state.conversation?.selectedText || "";
    try {
      await ensureConversationForSend(selectedText);
    } catch (error) {
      state.error = error.message || String(error);
      renderPanel();
      focusComposer();
      return;
    }

    const localUserId = `local-user-${Date.now()}`;
    const localAssistantId = `local-assistant-${Date.now()}`;
    const optimisticMessages = [
      ...(state.conversation.messages || []),
      {
        id: localUserId,
        role: "user",
        content,
        selectedText,
        createdAt: new Date().toISOString()
      },
      {
        id: localAssistantId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString()
      }
    ];

    state.conversation = {
      ...state.conversation,
      messages: optimisticMessages
    };
    state.streamingAssistantId = localAssistantId;
    state.isStreaming = true;
    state.error = "";
    input.value = "";
    input.style.height = "auto";
    renderPanel();

    const context = getContextSnapshot(selectedText);
    const started = startStreamingMessage({
      conversationId: state.conversation.id,
      content,
      selectedText,
      context
    });
    if (!started) {
      state.isStreaming = false;
      state.streamingAssistantId = "";
      state.conversation = removeEmptyStreamingAssistant();
      input.value = content;
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
      renderPanel();
      focusComposer();
    }
  }

  async function ensureConversationForSend(selectedText) {
    if (state.conversation) {
      return;
    }

    state.isPreparing = true;
    state.error = "创建中...";
    renderPanel();

    try {
      const response = await sendRuntimeMessage({
        type: MESSAGE_TYPES.createConversation,
        context: getContextSnapshot(selectedText)
      });

      if (!response?.ok) {
        throw new Error(response?.error || "创建失败");
      }

      state.conversation = response.conversation;
      state.conversations = response.conversations || state.conversations;
      state.error = "";
      await refreshHistory();
      await refreshMcpServers();
    } finally {
      state.isPreparing = false;
      renderPanel();
    }
  }

  function startStreamingMessage(payload) {
    if (!globalThis.chrome?.runtime?.connect) {
      state.error = getRuntimeUnavailableMessage();
      return false;
    }

    if (state.streamPort) {
      disconnectStreamPort(state.streamPort);
    }

    let port;
    try {
      port = chrome.runtime.connect({ name: STREAM_PORT_NAME });
    } catch (error) {
      state.error = normalizeRuntimeError(error);
      return false;
    }
    state.streamPort = port;

    try {
      port.onMessage.addListener((message) => {
        handleStreamEvent(message).catch((error) => {
          state.isStreaming = false;
          state.streamPort = null;
          state.streamingAssistantId = "";
          state.error = normalizeRuntimeError(error);
          renderPanel();
          focusComposer();
        });
      });
      port.onDisconnect.addListener(() => {
        if (state.isStreaming) {
          state.isStreaming = false;
          state.streamPort = null;
          renderPanel();
        }
      });
      port.postMessage({
        type: MESSAGE_TYPES.streamMessage,
        ...payload
      });
      return true;
    } catch (error) {
      state.streamPort = null;
      state.error = normalizeRuntimeError(error);
      disconnectStreamPort(port);
      return false;
    }
  }

  async function handleStreamEvent(message) {
    if (message.type === STREAM_EVENTS.conversation && message.conversation) {
      const streamingMessage = findStreamingAssistant();
      state.conversation = {
        ...message.conversation,
        messages: streamingMessage
          ? [...(message.conversation.messages || []), streamingMessage]
          : message.conversation.messages || []
      };
      scheduleRenderMessages();
      return;
    }

    if (message.type === STREAM_EVENTS.assistantStart) {
      replaceStreamingAssistantId(message.assistantId);
      return;
    }

    if (message.type === STREAM_EVENTS.delta) {
      updateStreamingAssistant(message.content || "");
      scheduleRenderMessages();
      return;
    }

    if (message.type === STREAM_EVENTS.done) {
      const port = state.streamPort;
      state.isStreaming = false;
      state.streamPort = null;
      state.streamingAssistantId = "";
      state.conversation = message.conversation || state.conversation;
      state.error = "";
      disconnectStreamPort(port);
      await refreshHistory();
      renderPanel();
      focusComposer();
      return;
    }

    if (message.type === STREAM_EVENTS.error) {
      const port = state.streamPort;
      state.isStreaming = false;
      state.streamPort = null;
      state.streamingAssistantId = "";
      state.conversation = message.conversation || removeEmptyStreamingAssistant();
      state.error = message.error || "请求失败";
      disconnectStreamPort(port);
      await refreshHistory();
      renderPanel();
      focusComposer();
    }
  }

  function findStreamingAssistant() {
    return (state.conversation?.messages || []).find(
      (message) => message.id === state.streamingAssistantId
    );
  }

  function replaceStreamingAssistantId(nextId) {
    if (!nextId || !state.conversation) {
      return;
    }

    state.conversation = {
      ...state.conversation,
      messages: (state.conversation.messages || []).map((message) =>
        message.id === state.streamingAssistantId ? { ...message, id: nextId } : message
      )
    };
    state.streamingAssistantId = nextId;
  }

  function updateStreamingAssistant(content) {
    if (!state.conversation || !state.streamingAssistantId) {
      return;
    }

    state.conversation = {
      ...state.conversation,
      messages: (state.conversation.messages || []).map((message) =>
        message.id === state.streamingAssistantId ? { ...message, content } : message
      )
    };
  }

  function removeEmptyStreamingAssistant() {
    if (!state.conversation || !state.streamingAssistantId) {
      return state.conversation;
    }

    return {
      ...state.conversation,
      messages: (state.conversation.messages || []).filter(
        (message) => message.id !== state.streamingAssistantId || message.content
      )
    };
  }

  function setStatus(message) {
    if (!state.shadow) {
      return;
    }
    const status = state.shadow.querySelector('[data-field="status"]');
    status.textContent = message || "";
    status.dataset.visible = message ? "true" : "false";
  }

  function setComposerDisabled(disabled) {
    if (!state.shadow) {
      return;
    }
    state.shadow.querySelector('[data-field="input"]').disabled = disabled;
    state.shadow.querySelector('[data-action="send"]').disabled = disabled;
    state.shadow.querySelector('[data-action="rename"]').disabled = !state.conversation;
    const clearQuoteBtn = state.shadow.querySelector('[data-action="clear-quote"]');
    if (clearQuoteBtn) {
      clearQuoteBtn.disabled = disabled;
    }
    state.shadow.querySelectorAll('[data-field="mcp-list"] input').forEach((input) => {
      input.disabled = disabled || !state.conversation;
    });
  }

  function focusComposer() {
    window.setTimeout(() => {
      state.shadow?.querySelector('[data-field="input"]')?.focus();
    }, 0);
  }

  function closePanel() {
    stopPanelPointerTracking();
    if (state.streamPort) {
      disconnectStreamPort(state.streamPort);
      state.streamPort = null;
    }
    state.isStreaming = false;
    state.isPreparing = false;
    state.streamingAssistantId = "";
    state.panelHost?.remove();
    state.panelHost = null;
    state.shadow = null;
  }

  function disconnectStreamPort(port) {
    try {
      port?.disconnect();
    } catch {
      // The port may already be invalid after extension reload.
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      if (!globalThis.chrome?.runtime?.sendMessage) {
        resolve({
          ok: false,
          error: getRuntimeUnavailableMessage()
        });
        return;
      }

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            resolve({
              ok: false,
              error: normalizeRuntimeError(runtimeError)
            });
            return;
          }
          resolve(response);
        });
      } catch (error) {
        resolve({
          ok: false,
          error: normalizeRuntimeError(error)
        });
      }
    });
  }

  function normalizeRuntimeError(error) {
    const message = error?.message || String(error || "");
    if (
      message.includes("Extension context invalidated") ||
      message.includes("Cannot read properties of undefined") ||
      message.includes("Receiving end does not exist")
    ) {
      return getRuntimeUnavailableMessage();
    }
    return message || getRuntimeUnavailableMessage();
  }

  function getRuntimeUnavailableMessage() {
    return "扩展已失效，请刷新扩展后刷新页面。";
  }

  function normalizeWhitespace(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((line) => line.replace(/[\t\f\v ]+/g, " ").trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeAllowedUrlPrefixes(prefixes) {
    const normalized = prefixes
      .map((prefix) => normalizeAllowedUrlPrefix(prefix))
      .filter(Boolean);
    return [...new Set(normalized)];
  }

  function normalizeAllowedUrlPrefix(prefix) {
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

  function normalizeCurrentUrl(urlValue) {
    try {
      return new URL(urlValue).href;
    } catch {
      return "";
    }
  }

  function clip(value, maxLength) {
    const text = String(value || "").trim();
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}\n...[已截断]`;
  }

  function hashText(value) {
    const text = String(value || "");
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 33) ^ text.charCodeAt(index);
    }
    return (hash >>> 0).toString(16);
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "-";
    }
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }
})();
