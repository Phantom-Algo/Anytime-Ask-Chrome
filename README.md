# Anytime Ask

> 在任意 AI 对话页面上划选文字，即可在侧边栏中追问——不污染原始对话。

[![Chrome](https://img.shields.io/badge/Chrome-114%2B-0f766e?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![Manifest](https://img.shields.io/badge/Manifest-V3-0f766e?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License](https://img.shields.io/badge/License-MIT-0f766e)](LICENSE)

---

## 这是什么？

当你在 ChatGPT、Claude、DeepSeek 等 AI 对话页面中阅读长篇回复时，经常想针对某一段内容进一步追问——但又不想在主对话中污染上下文。**Anytime Ask** 提供了一个独立对话窗口，让你在不污染原始对话的情况下自由追问、验证、深挖。

## 功能特性

### 核心体验
- **划选即用** — 在页面上选中任意文字，点击浮出的「追问」按钮，对话窗口即打开并将选中文字以及该对话界面的内容作为上下文。
- **多轮对话** — 允许在独立窗口中与 AI 进行多轮问答。
- **单页多会话** - 同一页面可创建多个独立会话，互不干扰，适合不同主题或不同段落的追问。

### AI 集成
- **多厂商支持** — 本插件支持 OpenAI 与 Anthropic 两种主流 API 格式，兼容市面上绝大多数 AI 模型（如 OpenAI，Claude，DeepSeek，Qwen，Kimi，GLM 等），默认使用 DeepSeek V4 Flash。
- **BYOK** - 你可以使用自己的 API Key，不受限于任何特定平台。
- **实时流式输出** — Token 级实时渲染，体验与原对话一致。
- **智能上下文管理** — 自动提取页面可见文字作为系统提示词；上下文缓存后仅在页面变化时重新发送，节省 Token。
- **自有密钥** — 无后端、无代理。API Key 仅存储在浏览器本地。

### 富文本渲染
- **完整 Markdown** — 标题、列表、表格、任务列表、引用块、代码块、链接、图片、`<details>` 折叠块等 GFM 特性。
- **LaTeX 数学公式** — 行内 (`$...$`) 和独立 (`$$...$$`) 公式，由 KaTeX 渲染。
- **代码高亮** — 使用 highlight.js 的 GitHub Dark 主题。

### 历史管理
- **会话历史** — 所有会话按来源页面归类，存储在本地。
- **重命名与删除会话** — 可重命名会话标题，清理无用记录。

### 个性化配置
- **URL 白名单** — 控制在哪些页面启用（默认：ChatGPT、DeepSeek）。
- **可拖拽缩放** — 面板可拖拽移动、四边自由缩放。

---

## 安装

### 前置条件
- **Chrome 114** 及以上版本
- 至少一个 AI 厂商的 API Key（暂时支持 OpenAI 与 Anthropic API 格式）

### 安装步骤

<details>
<summary><strong>1. 获取插件</strong></summary>

克隆本仓库或下载 ZIP：

```bash
git clone https://github.com/Phantom-Algo/Anytime-Ask-Chrome.git
```
</details>

<details>
<summary><strong>2. 加载到 Chrome</strong></summary>

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 开启右上角的 **开发者模式**
3. 点击 **加载未打包的扩展程序**
4. 选择 `Anytime-Ask-Chrome` 文件夹（即包含 `manifest.json` 的那个目录）

加载成功后，工具栏会出现插件图标。
</details>

<details>
<summary><strong>3. 配置 API Key</strong></summary>

1. 点击工具栏的插件图标 → 点击 **设置**
2. 或右键插件图标 → **选项**
3. 在「厂商」下拉框中选择你的 AI 服务商
4. 填入 API Key，必要时修改模型名称 / Base URL
5. （可选）编辑 URL 前缀白名单，控制插件在哪些页面生效
6. 点击 **保存** → 再点击 **测试配置** 验证连通性

</details>

<details>
<summary><strong>4. 开始使用</strong></summary>

1. 打开一个匹配白名单的页面（如 `https://chatgpt.com/`）（若无反应，尝试 **刷新页面** / **检查** 是否在白名单中）
2. 用鼠标选中一段文字
3. 浮出的 **「追问」** 按钮出现 → 点击它
4. 输入你的问题，按 `Ctrl+Enter`（ Mac 上 `Cmd+Enter`）发送

</details>

---

## 使用指南

### 浮动面板布局

| 区域 | 说明 |
|---|---|
| **头部** | 显示当前会话标题，可拖拽移动面板位置 |
| **引用栏** | 显示你划选的文字，作为本次对话的上下文 |
| **消息区** | 你的问题（右侧青色气泡）与 AI 回复（左侧白底气泡，完整 Markdown + LaTeX 渲染） |
| **输入区** | 输入你的问题，`Ctrl+Enter` / `Cmd+Enter` 发送，直接按 `Enter` 换行 |

### 面板按钮

| 按钮 | 功能 |
|---|---|
| 🕐 | 展开/收起历史侧边栏 |
| ✏️ | 重命名当前会话 |
| ⚙️ | 打开设置页面 |
| ✕ | 关闭面板 |
| ＋ | 新建会话（同一页面） |

### 输入快捷键
- `Ctrl+Enter` / `Cmd+Enter` — 发送消息
- `Enter` — 换行

### 历史侧边栏
- 会话按来源页面分组（「当前页面会话」/「其他页面会话」）
- 点击任意会话即可加载到面板中
- 每项显示标题、划选摘要、日期
- 点击 **×** 按钮可删除单条会话

### 全局历史页
在弹出窗口点击 🕐 可打开完整历史页面，支持：
- 按标题、URL、消息内容全文搜索
- 查看完整对话线程（含 Markdown + LaTeX 渲染）
- 删除单条或一键清空
- 跳转至会话的原始页面

---

## 支持的 AI 厂商

| 厂商 | API 格式 | 默认模型 | 备注 |
|---|---|---|---|
| **OpenAI 兼容** | `POST /chat/completions` | `gpt-5.5` | 支持任意 OpenAI 兼容端点（Ollama、vLLM、LM Studio 等） |
| **Anthropic 兼容** | `POST /messages` | `claude-sonnet-4-5` | 原生 Anthropic API 格式 |
| **DeepSeek V4** | `POST /chat/completions` | `deepseek-v4-flash` | 支持深度思考模式，可配置推理力度 |

所有厂商均支持：
- 自定义 Base URL（含 `http://localhost` 本地模型）
- 独立的 API Key
- 可调整 `max_tokens` 和 `temperature`

---

## Markdown & LaTeX 支持

### Markdown
基于 [markdown-it](https://github.com/markdown-it/markdown-it) 实现完整 GFM（GitHub Flavored Markdown）支持：
- 标题（H1–H6）、段落、换行
- 有序/无序列表、任务列表（`- [ ]` / `- [x]`）
- 表格（隔行条纹样式，横向滚动）
- 围栏代码块（自动语言检测）
- 引用块（支持嵌套）
- 链接（自动 `target="_blank"`，带 `noreferrer`）
- 图片、水平线、强调（粗体、斜体、删除线）
- `<details>` / `<summary>` 折叠区域

### 代码高亮
所有代码块使用 [highlight.js](https://highlightjs.org/) + GitHub Dark 主题进行语法高亮。

### LaTeX 数学公式
使用 [KaTeX](https://katex.org/) 渲染数学公式：

| 定界符 | 模式 | 示例 |
|---|---|---|
| `$...$` | 行内公式 | `$E = mc^2$` 在文本行内渲染 |
| `$$...$$` | 独立公式 | `$$\sum_{i=1}^{n} x_i$$` 居中独占一行 |
| `\(...\)` | 行内公式（LaTeX 风格） | `\(\alpha + \beta\)` |
| `\[...\]` | 独立公式（LaTeX 风格） | `\[\int_{0}^{\infty} e^{-x^2} dx\]` |

美元金额如 `$100`、`$50.00` 不会被误识别为公式 —— 解析器会跳过 `$` 后紧跟数字或空格的情况。

---

## 隐私与安全

- **零遥测** — 无埋点、无分析、无外部服务器。所有逻辑在浏览器本地运行。
- **API Key** 仅存储在 `chrome.storage.local` 中，除向您配置的 AI 厂商发起请求外绝不出站。
- **对话历史** 仅存储在本地 `chrome.storage.local`。
- **内容脚本** 仅在您配置的 URL 白名单页面生效。
- **Markdown 渲染** 关闭原始 HTML（`html: false`），防止 XSS 攻击。
- **所有链接** 自动添加 `rel="noreferrer noopener"`，新标签页打开。
- **页面上下文提取** 明确排除脚本、样式、导航等敏感元素。

---

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    Chrome 扩展                            │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │  Popup   │  │ Options  │  │  History Page         │  │
│  │  (状态概览)│  │ (设置页)  │  │  (全局历史页)         │  │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
│       │              │                  │                │
│       └──────────────┼──────────────────┘                │
│                      │ chrome.runtime.sendMessage        │
│                      ▼                                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Background Service Worker               │   │
│  │  • 消息路由                                       │   │
│  │  • 厂商 API 调用 (OpenAI / Anthropic / DS)       │   │
│  │  • SSE 流式中转 (chrome.runtime.connect)         │   │
│  │  • 会话 CRUD + 存储                               │   │
│  └──────────────────────────────────────────────────┘   │
│                      │ chrome.runtime.connect (流式)     │
│                      ▼                                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Content Script (注入页面)               │   │
│  │  • 划选检测 + 浮动按钮                            │   │
│  │  • Shadow DOM 面板注入                            │   │
│  │  • 页面上下文提取（结构化 + 通用）                  │   │
│  │  • Markdown + LaTeX 渲染                          │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Shared Modules (共享模块)               │   │
│  │  • constants.js    • providers.js                 │   │
│  │  • storage.js      • markdown-render.js           │   │
│  │  • vendor/ (markdown-it, highlight.js, KaTeX)     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 开发

### 快速开始
无需构建步骤 —— 纯原生 JavaScript（ES Modules）。

1. 克隆仓库
2. 在 `chrome://extensions` 中加载项目目录（开发者模式下）
3. 修改代码后点击插件卡片上的刷新图标
4. 修改内容脚本后需同时刷新目标页面

### 目录结构
```
src/
├── background/
│   └── service-worker.js    # 后台脚本（消息路由、API 调用）
├── content/
│   ├── content-script.js    # 内容脚本（面板、划选、渲染）
│   └── content.css          # 触发按钮 + 面板宿主样式
├── options/
│   ├── options.html         # 设置页面
│   ├── options.js           # 设置逻辑
│   └── options.css          # 设置样式
├── popup/
│   ├── popup.html           # 工具栏弹窗
│   ├── popup.js             # 弹窗逻辑
│   └── popup.css            # 弹窗样式
├── history/
│   ├── history.html         # 全局历史页
│   ├── history.js           # 历史逻辑
│   └── history.css          # 历史样式
└── shared/
    ├── constants.js          # 消息类型、厂商 ID、默认值
    ├── providers.js          # 厂商 API 逻辑
    ├── storage.js            # chrome.storage.local 抽象层
    ├── markdown-render.js    # markdown-it + KaTeX + highlight.js
    └── vendor/               # 第三方库
        ├── markdown-it.min.js
        ├── highlight.min.js + highlight-github-dark.min.css
        └── katex/            # KaTeX JS、CSS、字体
```

### 调试
- **内容脚本日志**：打开目标页面的 DevTools → 搜索 `[AnytimeAsk]` 前缀
- **后台日志**：在 `chrome://extensions` 中点击插件的 Service Worker 链接
- **弹窗日志**：右键插件图标 → 「审查弹出内容」
- **历史页 / 设置页**：标准 DevTools 即可

---

## 常见问题

<details>
<summary><strong>能用本地模型吗？</strong></summary>

完全可以！选择「OpenAI Compatible」厂商，填入本地 Base URL，例如 Ollama 填 `http://localhost:11434/v1`，vLLM 填 `http://127.0.0.1:8000/v1`。首次使用时插件会请求 localhost 访问权限。
</details>

<details>
<summary><strong>能在任意网站上使用吗？</strong></summary>

是的，但你需要通过设置中的「URL 前缀白名单」来控制。默认仅在 `https://chatgpt.com/` 和 `https://chat.deepseek.com/` 生效。添加 `https://claude.ai/` 等前缀即可在对应网站启用。
</details>

<details>
<summary><strong>页面上下文会捕捉多少内容？</strong></summary>

最多 12,000 字符的页面可见文字，自动排除脚本、样式、导航栏等无关元素。在 ChatGPT 页面上，会使用结构化提取保留消息角色标注。上下文会被缓存，仅当页面内容变化时才重新发送，避免浪费 Token。
</details>

<details>
<summary><strong>我的数据安全吗？</strong></summary>

安全。API Key、设置、对话历史全部仅存储在 Chrome 本地。数据仅在您向配置的 AI 厂商发送消息时才离开浏览器。无遥测、无埋点、无第三方服务器。
</details>

---

## 开源协议

[MIT](LICENSE) — 自由使用、修改，欢迎贡献。

---

## 致谢

Anytime Ask 基于以下优秀开源项目构建：

- [markdown-it](https://github.com/markdown-it/markdown-it) — Markdown 解析器（MIT）
- [highlight.js](https://highlightjs.org/) — 代码语法高亮（BSD-3-Clause）
- [KaTeX](https://katex.org/) — LaTeX 数学公式渲染（MIT）
