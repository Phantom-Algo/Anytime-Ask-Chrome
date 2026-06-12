export const STORAGE_KEYS = Object.freeze({
  settings: "aa_settings",
  conversations: "aa_conversations"
});

export const MESSAGE_TYPES = Object.freeze({
  createConversation: "AA_CREATE_CONVERSATION",
  openOrCreateConversation: "AA_OPEN_OR_CREATE_CONVERSATION",
  sendMessage: "AA_SEND_MESSAGE",
  streamMessage: "AA_STREAM_MESSAGE",
  listConversations: "AA_LIST_CONVERSATIONS",
  loadConversation: "AA_LOAD_CONVERSATION",
  renameConversation: "AA_RENAME_CONVERSATION",
  deleteConversation: "AA_DELETE_CONVERSATION",
  openOptions: "AA_OPEN_OPTIONS",
  openHistory: "AA_OPEN_HISTORY",
  testProvider: "AA_TEST_PROVIDER"
});

export const PROVIDERS = Object.freeze({
  openai: "openai",
  anthropic: "anthropic",
  deepseek: "deepseek"
});

export const PROVIDER_LABELS = Object.freeze({
  openai: "OpenAI Compatible",
  anthropic: "Anthropic Compatible",
  deepseek: "DeepSeek V4"
});

export const DEFAULT_SETTINGS = Object.freeze({
  provider: PROVIDERS.deepseek,
  allowedUrlPrefixes: [
    "https://chatgpt.com/",
    "https://chat.deepseek.com/"
  ],
  openai: {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.5",
    maxTokens: 1200,
    temperature: 0.2
  },
  anthropic: {
    apiKey: "",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
    maxTokens: 1200
  },
  deepseek: {
    apiKey: "",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    maxTokens: 1200,
    temperature: 0.2,
    thinkingEnabled: false,
    reasoningEffort: "medium"
  }
});

export const MAX_HISTORY_ITEMS = 100;
export const MAX_CONTEXT_CHARS = 12000;
export const MAX_SELECTED_CHARS = 4000;
export const REQUEST_TIMEOUT_MS = 60000;
