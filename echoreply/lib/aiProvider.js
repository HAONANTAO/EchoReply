// Unified AI call. Reads provider+apiKey from storage, dispatches to Claude or
// OpenAI. Errors are normalised to "API_ERROR_<status>" strings so the UI layer
// can map them to inline messages without caring about provider differences.
//
// Two flavours:
//   - callAI(prompt, returnsJSON?)            — buffered, returns final value
//   - callAIStream(prompt, { onDelta })       — SSE streaming, onDelta(partial)
//                                                fires per token. Returns the
//                                                final accumulated string.
//
// Streaming is only used for plain-text drafts. JSON responses (decoder,
// tone-check) need the whole document before we can parse it, so they stick
// to the buffered path.

import { SYSTEM_PROMPT_JSON, SYSTEM_PROMPT_TEXT } from "./prompts.js";

const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Defaults — used when the user hasn't picked a model yet.
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

// Whitelist so a stale or malicious value in storage can't trigger weird
// API calls. Add new model IDs here as Anthropic/OpenAI ships them.
const CLAUDE_MODELS = new Set([
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
]);
const OPENAI_MODELS = new Set([
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4-turbo",
  "o1-mini",
]);

async function selectedModel(provider) {
  const { claudeModel, openaiModel } = await chrome.storage.local.get([
    "claudeModel",
    "openaiModel",
  ]);
  if (provider === "openai") {
    return OPENAI_MODELS.has(openaiModel) ? openaiModel : DEFAULT_OPENAI_MODEL;
  }
  return CLAUDE_MODELS.has(claudeModel) ? claudeModel : DEFAULT_CLAUDE_MODEL;
}

// ---------- Public API ----------

export async function callAI(prompt, returnsJSON = true) {
  const { provider, apiKey } = await getCreds();
  if (provider === "openai") return callOpenAIBuffered(apiKey, prompt, returnsJSON);
  return callClaudeBuffered(apiKey, prompt, returnsJSON);
}

export async function callAIStream(prompt, { onDelta } = {}) {
  const { provider, apiKey } = await getCreds();
  const handler = typeof onDelta === "function" ? onDelta : () => {};
  if (provider === "openai") return callOpenAIStream(apiKey, prompt, handler);
  return callClaudeStream(apiKey, prompt, handler);
}

// Multi-turn streaming. `messages` is an array of {role: "user"|"assistant",
// content: string}. Used for conversational draft refinement so the model
// can see the prior dialogue (original email → first draft → "shorter" →
// rewrite → "add a thank-you" → …).
export async function callAIChatStream(messages, { onDelta } = {}) {
  const { provider, apiKey } = await getCreds();
  const handler = typeof onDelta === "function" ? onDelta : () => {};
  if (provider === "openai") return callOpenAIChatStream(apiKey, messages, handler);
  return callClaudeChatStream(apiKey, messages, handler);
}

async function getCreds() {
  const { provider, apiKey } = await chrome.storage.local.get([
    "provider",
    "apiKey",
  ]);
  if (!apiKey) throw new Error("NO_API_KEY");
  return { provider: provider || "claude", apiKey };
}

// ---------- Buffered (non-streaming) ----------

async function callClaudeBuffered(apiKey, prompt, returnsJSON) {
  const model = await selectedModel("claude");
  const res = await safeFetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0.7,
      system: returnsJSON ? SYSTEM_PROMPT_JSON : SYSTEM_PROMPT_TEXT,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`API_ERROR_${res.status}`);

  const data = await res.json();
  const text = data?.content?.[0]?.text ?? "";
  return parseModelOutput(text, returnsJSON);
}

async function callOpenAIBuffered(apiKey, prompt, returnsJSON) {
  const model = await selectedModel("openai");
  const res = await safeFetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: returnsJSON ? SYSTEM_PROMPT_JSON : SYSTEM_PROMPT_TEXT,
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`API_ERROR_${res.status}`);

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return parseModelOutput(text, returnsJSON);
}

// ---------- Streaming (SSE) ----------

async function callClaudeStream(apiKey, prompt, onDelta) {
  const model = await selectedModel("claude");
  const res = await safeFetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0.7,
      stream: true,
      system: SYSTEM_PROMPT_TEXT,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`API_ERROR_${res.status}`);

  let full = "";
  await readSSE(res, (event) => {
    if (!event.data) return;
    try {
      const json = JSON.parse(event.data);
      if (
        json.type === "content_block_delta" &&
        json.delta?.type === "text_delta" &&
        typeof json.delta.text === "string"
      ) {
        full += json.delta.text;
        onDelta(full);
      }
    } catch {
      // Ignore malformed events — these are usually keep-alives.
    }
  });

  return unwrapPlainText(full);
}

async function callOpenAIStream(apiKey, prompt, onDelta) {
  const model = await selectedModel("openai");
  const res = await safeFetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0.7,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT_TEXT },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`API_ERROR_${res.status}`);

  let full = "";
  await readSSE(res, (event) => {
    if (!event.data || event.data === "[DONE]") return;
    try {
      const json = JSON.parse(event.data);
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        full += delta;
        onDelta(full);
      }
    } catch {
      // Ignore malformed events.
    }
  });

  return unwrapPlainText(full);
}

// ---------- Multi-turn (chat) streaming ----------

async function callClaudeChatStream(apiKey, messages, onDelta) {
  const model = await selectedModel("claude");
  const res = await safeFetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0.7,
      stream: true,
      system: SYSTEM_PROMPT_TEXT,
      messages,
    }),
  });

  if (!res.ok) throw new Error(`API_ERROR_${res.status}`);

  let full = "";
  await readSSE(res, (event) => {
    if (!event.data) return;
    try {
      const json = JSON.parse(event.data);
      if (
        json.type === "content_block_delta" &&
        json.delta?.type === "text_delta" &&
        typeof json.delta.text === "string"
      ) {
        full += json.delta.text;
        onDelta(full);
      }
    } catch {
      // Ignore malformed events.
    }
  });

  return unwrapPlainText(full);
}

async function callOpenAIChatStream(apiKey, messages, onDelta) {
  const model = await selectedModel("openai");
  const res = await safeFetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      temperature: 0.7,
      stream: true,
      messages: [{ role: "system", content: SYSTEM_PROMPT_TEXT }, ...messages],
    }),
  });

  if (!res.ok) throw new Error(`API_ERROR_${res.status}`);

  let full = "";
  await readSSE(res, (event) => {
    if (!event.data || event.data === "[DONE]") return;
    try {
      const json = JSON.parse(event.data);
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        full += delta;
        onDelta(full);
      }
    } catch {
      // Ignore malformed events.
    }
  });

  return unwrapPlainText(full);
}

// Minimal SSE reader. Pushes `{event, data}` per blank-line-separated block.
async function readSSE(response, onEvent) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE: events are separated by blank lines (\n\n).
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = parseSSEBlock(raw);
      if (event) onEvent(event);
    }
  }

  // Flush any trailing event.
  if (buffer.trim()) {
    const event = parseSSEBlock(buffer);
    if (event) onEvent(event);
  }
}

function parseSSEBlock(block) {
  const lines = block.split("\n");
  const out = { event: null, data: "" };
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") out.event = value;
    else if (field === "data") out.data += (out.data ? "\n" : "") + value;
  }
  return out.data || out.event ? out : null;
}

// ---------- Helpers ----------

// One retry on transient failures: network blip, 5xx, 408 timeout. Don't
// retry 401 (bad key), 429 (rate-limited — let the user back off), or 4xx.
async function safeFetch(url, init, attempt = 0) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (attempt < 1) {
      await sleep(400);
      return safeFetch(url, init, attempt + 1);
    }
    throw new Error("NETWORK_ERROR");
  }

  if (res.status >= 500 || res.status === 408) {
    if (attempt < 1) {
      await sleep(400);
      return safeFetch(url, init, attempt + 1);
    }
  }
  return res;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Defensive: even with SYSTEM_PROMPT_TEXT, occasionally a model still wraps
// its plain-text reply in JSON like {"reply": "..."} or {"text": "..."}.
// Detect that and unwrap to a clean string. If the value isn't a string, fall
// back to the raw text so we never lose content.
function unwrapPlainText(raw) {
  if (typeof raw !== "string") return String(raw ?? "");

  let text = raw.replace(/```json\s*|```\s*$/g, "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return text;

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      for (const key of ["reply", "text", "draft", "response", "content", "output", "message"]) {
        if (typeof parsed[key] === "string") return parsed[key];
      }
      for (const v of Object.values(parsed)) {
        if (typeof v === "string") return v;
      }
    }
  } catch {
    // Not valid JSON — fall through.
  }
  return text;
}

function parseModelOutput(text, returnsJSON) {
  if (!returnsJSON) return unwrapPlainText(text);

  const stripped = text.replace(/```json\s*|\s*```/g, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const firstBrace = stripped.indexOf("{");
    const lastBrace = stripped.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
      } catch {
        // fall through
      }
    }
    throw new Error("PARSE_ERROR");
  }
}
