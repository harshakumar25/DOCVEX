# DocVex — TeachMe Local 🎓

> **Select anything. Press one shortcut. Understand it out loud.**

DocVex is a lightweight, local-first technical voice tutor. Instead of reading technical jargon verbatim, DocVex acts as an intelligent professor sitting next to you. It reconstructs complex technical text into clear mental models, breaks down mechanisms, grounds claims with verified technical documentation, and speaks the explanation aloud naturally.

---

## ⚡ Key Features

- **One-Shortcut Workflow**: Select any text on a webpage and press `^ + Shift + S` (`Ctrl + Shift + S` on Windows/Linux).
- **Teaches Concepts, Doesn't Just Read**: Explains meaning, significance, mechanics, analogies, and practical examples.
- **Local-First & Private**: Powered by [Ollama](https://ollama.com) running locally (`qwen3:4b` by default). No API keys required.
- **Optional Fast Cloud Provider**: Support for Groq (`llama-3.1-8b-instant`) when ultra-low latency is desired.
- **Authoritative Source Verification**: Restricts external context retrieval strictly to an explicit allowlist of official documentation (`kubernetes.io`, `developer.mozilla.org`, `docs.python.org`, `ietf.org`, etc.).
- **Speech-Optimized Engine**: Strips code punctuation noise, markdown syntax, and raw URLs to produce smooth, conversational speech. Optional local Chatterbox audio is played from an MV3 offscreen document; Web Speech is fallback only.
- **Audio Controls & Floating HUD**: An isolated Shadow DOM floating HUD providing Play, Pause, Resume, Stop controls, status indicators, and verified source links.

---

## 🛠️ Prerequisites

- **macOS / Linux / Windows**
- **Node.js**: v18+ (tested on v24)
- **Google Chrome** (or Chromium-based browser)
- **Ollama**: [Download Ollama](https://ollama.com)

---

## 🚀 Installation & Setup

### 1. Clone & Setup Project

```bash
cd /path/to/DOCVEX
cp .env.example .env
```

Review `.env` (optional defaults are already configured):
```env
PORT=3000
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
DEFAULT_PROVIDER=ollama
```

Local Chatterbox sentence audio is opt-in. Before enabling it, select a
benchmarked model and set the exact origin of the loaded unpacked extension:

```env
CHATTERBOX_ENABLED=true
CHATTERBOX_MODEL=nano
EXTENSION_ORIGIN=chrome-extension://<your-loaded-extension-id>
```

The backend refuses to serve Chatterbox audio unless `EXTENSION_ORIGIN` is
configured exactly; this prevents arbitrary browser extensions from reading
generated audio files.

Chatterbox uses sentence-level pipelined synthesis, not native incremental
audio generation. The model stays loaded in a long-lived worker, and the MV3
service worker transports generated WAV files to the offscreen audio document.

### 2. Pull the Ollama Model

Make sure Ollama is running, then pull the default model:
```bash
ollama pull qwen3:4b
```

*(Optional: If you want to use Groq, add `GROQ_API_KEY=gsk_...` in `.env` and set `DEFAULT_PROVIDER=groq`)*

### 3. Start the Local Server

```bash
npm start
```
The server will start on `http://127.0.0.1:3000`.

To verify health:
```bash
curl http://127.0.0.1:3000/health
```

---

## 🧩 Installing the Chrome Extension

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top right corner).
3. Click **Load unpacked**.
4. Select the `extension/` folder inside the `DOCVEX` project directory (`/Users/harshkumar/Desktop/projects/DOCVEX/extension`).
5. The **DocVex — TeachMe Local** extension is now active!

---

## ⌨️ How to Use

1. Navigate to any technical documentation page (e.g., [Kubernetes Concepts](https://kubernetes.io/docs/concepts/overview/) or [MDN Web Docs](https://developer.mozilla.org)).
2. Select any sentence, paragraph, or code snippet.
3. Press **`^ + Shift + S`** (or right-click the selection and choose **🎓 Teach me this**).
4. A sleek floating tutor panel appears at the bottom right.
5. The local model reconstructs the explanation and automatically begins speaking aloud!
6. Use the on-screen buttons to **Pause**, **Resume**, or **Stop** audio playback at any time.

---

## 🧪 Testing & Verification

DocVex includes a comprehensive test suite using Node's native test runner (zero external dependencies):

```bash
# Run all unit, integration, and extension tests
npm test

# Run syntax lint check
npm run lint
```

### Test Coverage
- **Configuration**: Default values, environment variable parsing, positive integer and port validation.
- **Server**: Health check, CORS preflight, payload size limits, input validation, 404 handler.
- **Providers**: Ollama connection timeout & error handling, Groq API key security, prompt routing.
- **Teaching Prompt**: Speech text formatting (URL removal, markdown stripping), user prompt assembly.
- **Retrieval Engine**: Authoritative domain allowlist verification, HTML sanitization, stop-word filtering.
- **Extension**: Manifest V3 integrity, permissions, commands, icon assets existence.

---

## 🔍 Architecture Overview

```text
Chrome Extension (Manifest V3)
       │
 Selected Text + Page Context
       │
  ^ + Shift + S  /  Context Menu
       │
       ▼
Local Node.js Server (Port 3000)
       │
 ┌─────┴─────────────────────────┐
 │                               │
 ▼                               ▼
Verified Sources Engine     Model Router
(Domain Allowlist)               │
 │                               ▼
 └──────────────┬────────► Ollama / Groq
                │                │
                │         Teaching Engine
                │                │
                └────────► Spoken Output 🔊
```

---

## 🛡️ Security & Privacy

- **No Data Leaves Your Machine by Default**: All language model inference runs locally via Ollama.
- **Zero API Keys in Browser**: API keys (e.g., Groq) reside exclusively in the backend `.env` file and are never sent to the browser extension.
- **Safe Content Handling**: Model output is treated as plain text and never passed to `eval()` or executed. Retrieved web content is stripped of all `<script>` and HTML elements before use.
- **Isolated Extension UI**: The floating HUD uses Shadow DOM so webpage CSS cannot interfere with the tutor and vice versa.

---

## ❓ Troubleshooting

### 1. "Ollama is not running"
Ensure the Ollama application is started or run:
```bash
ollama serve
```

### 2. "Model qwen3:4b is unavailable"
Run:
```bash
ollama pull qwen3:4b
```

### 3. Shortcut does not trigger
- In Chrome, navigate to `chrome://extensions/shortcuts`.
- Verify that **Teach me the selected text** is mapped to `^ + Shift + S` (or assign your preferred shortcut).
- As a fallback, you can always right-click any selected text and click **🎓 Teach me this**.

### 4. "DocVex backend is not running"
Ensure the local server is running in terminal:
```bash
npm start
```
Check `http://127.0.0.1:3000/health` in your browser.
