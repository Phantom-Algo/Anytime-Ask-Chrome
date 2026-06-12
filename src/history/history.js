import {
  clearConversations,
  deleteConversation,
  getConversations
} from "../shared/storage.js";

const countEl = document.querySelector("#count");
const searchInput = document.querySelector("#search");
const listEl = document.querySelector("#list");
const detailEl = document.querySelector("#detail");
const clearAllButton = document.querySelector("#clearAll");

let conversations = [];
let selectedId = "";

init();

searchInput.addEventListener("input", renderList);

clearAllButton.addEventListener("click", async () => {
  if (!conversations.length) {
    return;
  }

  if (!confirm("清空所有历史记录？")) {
    return;
  }

  await clearConversations();
  selectedId = "";
  await refresh();
});

async function init() {
  await refresh();
}

async function refresh() {
  conversations = await getConversations();
  if (!selectedId && conversations[0]) {
    selectedId = conversations[0].id;
  }
  countEl.textContent = `${conversations.length} 条`;
  renderList();
  renderDetail();
}

function renderList() {
  const query = searchInput.value.trim().toLowerCase();
  const items = conversations.filter((conversation) => matchesQuery(conversation, query));

  listEl.textContent = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = query ? "无匹配记录" : "暂无记录";
    listEl.appendChild(empty);
    return;
  }

  for (const conversation of items) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "history-item";
    item.dataset.active = conversation.id === selectedId ? "true" : "false";
    item.addEventListener("click", () => {
      selectedId = conversation.id;
      renderList();
      renderDetail();
    });

    const title = document.createElement("strong");
    title.textContent = conversation.title || "未命名";

    const selected = document.createElement("span");
    selected.textContent = conversation.selectedText || "无内容";

    const meta = document.createElement("small");
    meta.textContent = `${formatDate(conversation.updatedAt)} · ${conversation.provider || "-"} · ${
      conversation.model || "-"
    }`;

    item.append(title, selected, meta);
    listEl.appendChild(item);
  }
}

function renderDetail() {
  const conversation = conversations.find((item) => item.id === selectedId);
  detailEl.textContent = "";

  if (!conversation) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "选择记录查看详情";
    detailEl.appendChild(empty);
    return;
  }

  const shell = document.createElement("div");
  shell.className = "detail-shell";

  const header = document.createElement("header");
  header.className = "detail-header";

  const title = document.createElement("h2");
  title.textContent = conversation.title || "未命名页面";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${formatDate(conversation.createdAt)} · 更新于 ${formatDate(
    conversation.updatedAt
  )} · ${conversation.provider || "-"} · ${conversation.model || "-"}`;

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = "来源";
  openButton.disabled = !conversation.url;
  openButton.addEventListener("click", () => {
    if (conversation.url) {
      chrome.tabs.create({ url: conversation.url });
    }
  });

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", async () => {
    await deleteConversation(conversation.id);
    selectedId = "";
    await refresh();
  });

  toolbar.append(openButton, deleteButton);
  header.append(title, meta, toolbar);

  const quote = createTextSection("内容", conversation.selectedText || "");
  const messages = document.createElement("section");
  messages.className = "messages";

  if (conversation.messages?.length) {
    for (const message of conversation.messages) {
      messages.appendChild(createMessageSection(message));
    }
  } else {
    messages.appendChild(createTextSection("消息", "暂无消息"));
  }

  shell.append(header, quote, messages);
  detailEl.appendChild(shell);
}

function createTextSection(title, text) {
  const section = document.createElement("section");
  section.className = "quote";

  const heading = document.createElement("h3");
  heading.textContent = title;

  const body = document.createElement("p");
  body.textContent = text;

  section.append(heading, body);
  return section;
}

function createMessageSection(message) {
  const section = document.createElement("article");
  section.className = "message";
  section.dataset.role = message.role;

  const heading = document.createElement("h3");
  heading.textContent = message.role === "user" ? "你" : "AI";

  const body = document.createElement(message.role === "assistant" ? "div" : "p");
  if (message.role === "assistant" && globalThis.AnytimeAskMarkdown) {
    body.className = "markdown-body";
    globalThis.AnytimeAskMarkdown.renderMarkdown(message.content || "", body);
  } else {
    body.textContent = message.content || "";
  }

  section.append(heading, body);
  return section;
}

function matchesQuery(conversation, query) {
  if (!query) {
    return true;
  }

  const haystack = [
    conversation.title,
    conversation.url,
    conversation.selectedText,
    conversation.provider,
    conversation.model,
    ...(conversation.messages || []).map((message) => message.content)
  ]
    .join("\n")
    .toLowerCase();

  return haystack.includes(query);
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
