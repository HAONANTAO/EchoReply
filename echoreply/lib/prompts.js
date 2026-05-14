// Prompt templates. Kept in plain strings so they are easy to tweak without
// rebuilding anything. All "JSON-returning" prompts state that explicitly so
// the model doesn't wrap the response in code fences or prose.

// Two system prompts: pick the one that matches what we expect back.
// The shared rule: never wrap output in markdown fences, never add preamble.
// JSON-mode prompts also forbid ANY prose around the JSON object.
// Plain-text prompts forbid ANY JSON wrapper.

export const SYSTEM_PROMPT_JSON = `You are EchoReply, an AI email coach. Analyze emails with the intelligence of a senior communication expert. Be concise, direct, and emotionally intelligent. Respond with valid JSON only — no markdown fences, no preamble, no commentary.`;

export const SYSTEM_PROMPT_TEXT = `You are EchoReply, an AI email coach. Be concise, direct, and emotionally intelligent. Respond with plain text only — never wrap your output in JSON, never use markdown fences, never add a preamble or commentary. Output the email reply text and nothing else.`;

// Back-compat alias (older callers).
export const SYSTEM_PROMPT = SYSTEM_PROMPT_JSON;

// Per-message char budget when there are many messages in a thread. We keep
// the FIRST message (kicked off the thread) and LAST message (being replied
// to) at full length, and aggressively truncate the middle ones.
const PRESERVED_HEAD = 1200;
const PRESERVED_TAIL = 4000;
const COMPRESSED_MIDDLE = 350;
const MAX_FULL_MESSAGES = 4; // below this many messages, no compression

function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + " […truncated]";
}

// Build a compact text representation of the thread history. The latest
// message is the one being replied to; older messages give the model the
// context it needs to read tone shifts and unresolved threads.
//
// Long threads are compressed: first + last messages keep full text; middle
// messages are heavily truncated so we don't blow the context window on a
// 20-message argument chain.
function recipientHint(email) {
  let hint = "";
  if (email?.recipientRole === "cc") {
    hint += "\nRECIPIENT-ROLE: The user is CC'd, NOT the primary recipient. A reply is often optional. If a reply is warranted, it should be SHORTER than usual and acknowledge they're not the primary audience.";
  } else if (email?.recipientRole === "to") {
    hint += "\nRECIPIENT-ROLE: The user is the primary recipient (To). A reply is expected.";
  }
  if (email?.isAutomated) {
    hint += "\nSENDER-TYPE: This is from an automated / no-reply address (newsletter, alert, notification, receipt). replyStrategy should almost certainly be DONT_REPLY, and actionItems should usually be empty.";
  }
  return hint;
}

function formatThread(email) {
  if (!email.isThread || !Array.isArray(email.threadMessages) || email.threadMessages.length <= 1) {
    return `FROM: ${email.sender}\nSUBJECT: ${email.subject}${recipientHint(email)}\nBODY: ${truncate(email.body, PRESERVED_TAIL)}`;
  }

  const msgs = email.threadMessages;
  const latest = msgs[msgs.length - 1];
  const older = msgs.slice(0, -1);

  const renderMsg = (m, idx, body) =>
    `[#${idx + 1} ${m.sender}]\n${body}`;

  let history;
  if (msgs.length <= MAX_FULL_MESSAGES) {
    history = older.map((m, i) => renderMsg(m, i, truncate(m.body, PRESERVED_TAIL))).join("\n\n");
  } else {
    const first = older[0];
    const middle = older.slice(1, -1);
    const lastOlder = older[older.length - 1];

    const parts = [renderMsg(first, 0, truncate(first.body, PRESERVED_HEAD))];
    if (middle.length) {
      parts.push(
        `[${middle.length} middle message${middle.length > 1 ? "s" : ""} compressed]`,
      );
      for (const m of middle) {
        const idx = older.indexOf(m);
        parts.push(renderMsg(m, idx, truncate(m.body, COMPRESSED_MIDDLE)));
      }
    }
    parts.push(renderMsg(lastOlder, older.length - 1, truncate(lastOlder.body, PRESERVED_TAIL)));
    history = parts.join("\n\n");
  }

  return `THREAD HISTORY (older → newer, ${msgs.length} messages total):\n${history}\n\n---\nLATEST MESSAGE (the one to analyze):\nFROM: ${latest.sender}\nSUBJECT: ${email.subject}${recipientHint(email)}\nBODY: ${truncate(latest.body, PRESERVED_TAIL)}`;
}

export function decoderPrompt(email) {
  const isThread = email.isThread && Array.isArray(email.threadMessages) && email.threadMessages.length > 1;

  const threadSummaryField = isThread
    ? `,
  "threadSummary": "2-3 sentence summary of the whole conversation arc so far: who said what, where things stand, what's unresolved. Useful when the thread is too long to re-read."`
    : "";

  return `Analyze this email and return ONLY JSON. If a thread history is provided, use it for context, but focus your analysis on the LATEST message.

${formatThread(email)}

Return:
{
  "realIntent": "1-2 sentence summary of what the sender actually wants",
  "temperature": "WARM" | "COOL" | "NEUTRAL" | "URGENT" | "FRUSTRATED",
  "temperatureNote": "One-line tone description",
  "replyStrategy": "MUST_REPLY" | "SHOULD_REPLY" | "OPTIONAL" | "DONT_REPLY",
  "strategyAdvice": "One-line recommendation",
  "clarifyBeforeReplying": ["2-3 things the user should confirm or decide BEFORE writing a reply — concrete, specific, max 12 words each. Empty array if nothing needs clarifying."],
  "actionItems": [
    {
      "text": "Concise description of the task/event/deadline, max 12 words",
      "type": "task" | "event" | "deadline",
      "date": "ISO 8601 datetime or date string if explicit (e.g. 2026-05-15 or 2026-05-15T14:00) — null if none mentioned",
      "title": "Short title for calendar event, max 8 words (only for type=event)"
    }
  ]${threadSummaryField}
}

STRICT RULES FOR actionItems:
- ONLY include a genuine, concrete commitment the USER must personally act on: a real task with a clear deliverable, a meeting/call the user is expected to attend, or a hard deadline.
- DO NOT invent filler. Vague items like "review the email", "consider the offer", "look at the listings", "read the attachment", "be aware of X" are NOT action items — exclude them.
- If the email is a newsletter, job alert, notification, receipt, or any automated/no-reply message, actionItems MUST be an empty array.
- When in doubt, leave it OUT. An empty array is the correct and common answer.`;
}

// Renders the user's saved writing samples as few-shot context for drafting.
// The point is to teach the model the user's habitual register, sign-off,
// sentence length, etc. — not to copy phrases verbatim.
function formatStyleSamples(styleSamples) {
  if (!Array.isArray(styleSamples) || !styleSamples.length) return "";
  const lines = styleSamples
    .slice(0, 6) // cap to keep prompts cheap
    .map((s, i) => `--- SAMPLE ${i + 1} ---\n${String(s).slice(0, 800)}`)
    .join("\n\n");
  return `

USER'S OWN WRITING SAMPLES (study the user's habitual tone, length, sign-off, sentence rhythm — DO NOT copy phrases, just adopt the register):
${lines}
`;
}

function signatureBlock(signature) {
  if (!signature || typeof signature !== "string" || !signature.trim()) return "";
  return `

REQUIRED SIGN-OFF (the reply MUST end with exactly this block on its own lines, verbatim — do not rewrite or paraphrase it):
${signature.trim()}`;
}

const LANGUAGE_NAMES = {
  auto: null,
  en: "English",
  zh: "Simplified Chinese (简体中文)",
  es: "Spanish",
  ja: "Japanese",
  fr: "French",
  de: "German",
};

function languageBlock(lang) {
  if (!lang || lang === "auto") return "";
  const name = LANGUAGE_NAMES[lang];
  if (!name) return "";
  return `

REPLY LANGUAGE: Write the entire reply in ${name}, even if the incoming email is in a different language. Match the formality level of the original email but in ${name}.`;
}

export function draftPrompt(email, style, { styleSamples, signature, language } = {}) {
  const styles = {
    professional:
      "Formal, business-appropriate, safe. Proper salutation and signoff.",
    warm:
      "Human, sincere, relationship-first. Acknowledges the person.",
    confident:
      "Direct, assertive. No over-thanking, no hedging.",
  };

  return `Generate a ${style} reply to the LATEST message in this thread.

${formatThread(email)}${formatStyleSamples(styleSamples)}${signatureBlock(signature)}${languageBlock(language)}

STYLE: ${styles[style]}

Rules:
- 40-100 words
- No clichés like "Looking forward to your reply"
- No over-polite phrases like "I would be very grateful"
- Sound natural and human — if writing samples are provided, match the user's tone
- If this is a thread, do NOT repeat info the sender already knows from earlier messages

Return ONLY the reply text. No JSON. No explanation.`;
}

// Maps the 3 preset chips to a concrete instruction. Custom instructions
// (typed into the input box) are passed through verbatim.
const REFINE_PRESETS = {
  shorter: "Make this reply noticeably shorter while preserving the core message. Cut filler, soften only as much as needed.",
  softer: "Soften the tone a step — same content, but warmer and less direct. Don't become sycophantic.",
  direct: "Make this reply more direct and confident. Remove hedging like 'just', 'maybe', 'I think'. Keep it polite, not blunt.",
};

export function refineDraftPrompt(currentDraft, originalEmail, instruction, { styleSamples, signature, language } = {}) {
  const instr = REFINE_PRESETS[instruction] || instruction;
  return `Rewrite the reply below following this instruction: ${instr}

ORIGINAL EMAIL CONTEXT:
${formatThread(originalEmail)}${formatStyleSamples(styleSamples)}${signatureBlock(signature)}${languageBlock(language)}

CURRENT REPLY DRAFT:
${currentDraft}

Rules:
- Apply the instruction faithfully. Don't drift to other changes the user didn't ask for.
- Keep the reply 40-100 words unless the instruction asks for a different length.
- Keep it natural, no clichés ("Looking forward to your reply"), no over-polite phrases.
- If writing samples are provided above, keep the rewrite consistent with the user's habitual tone.

Return ONLY the rewritten reply text. No JSON. No explanation.`;
}

// Heuristic: find the longest common trailing block across writing samples.
// Returns the signature string if confidence is high, else null.
//
// Strategy: take the last N non-empty lines of each sample, then walk
// backwards finding lines that are identical across ALL samples. That gives
// us the user's habitual sign-off (e.g. "Cheers,\nAaron Tao\n+1 555 1234").
//
// Variation-tolerant matching is intentionally NOT attempted — better to
// return null than a wrong signature.
export function extractSignatureFromSamples(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;

  const tails = samples.map((s) => {
    const lines = String(s).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.slice(-8); // last 8 non-empty lines
  });

  if (tails.some((t) => !t.length)) return null;

  const minDepth = Math.min(...tails.map((t) => t.length));
  const suffix = [];

  for (let depth = 1; depth <= minDepth; depth++) {
    const lineAtDepth = tails.map((t) => t[t.length - depth]);
    if (lineAtDepth.every((l) => l === lineAtDepth[0])) {
      suffix.unshift(lineAtDepth[0]);
    } else {
      break;
    }
  }

  if (!suffix.length) return null;
  const text = suffix.join("\n").trim();
  // Need at least a few characters AND more than just "thanks" or other
  // single short words to be useful.
  if (text.length < 5) return null;
  return text;
}

// Given a set of writing samples by the user, return a brief 1-sentence
// description of their style. Used to (a) show the user a fingerprint of
// what's being learned, and (b) make the "Use samples when drafting" toggle
// meaningful — they can read it and tell if the diagnosis is accurate.
export function styleDiagnosisPrompt(samples) {
  const blocks = samples
    .slice(0, 6)
    .map((s, i) => `--- SAMPLE ${i + 1} ---\n${String(s).slice(0, 800)}`)
    .join("\n\n");

  return `Read the following email samples written by one person. In ONE concise sentence (under 25 words), describe their writing style: typical register, sentence rhythm, sign-off style, and any distinctive habits (e.g. emoji use, salutation, length). Be specific and direct — not vague.

${blocks}

Return ONLY the one-sentence diagnosis. No JSON, no preamble, no quotes.`;
}

// Style-coach prompt: compares the user's *currently in-progress* draft
// against their style samples. Returns a quick yes/no + 1-3 flagged lines
// that drift from their usual voice.
export function styleCoachPrompt(userDraft, styleSamples) {
  const blocks = (styleSamples || [])
    .slice(0, 5)
    .map((s, i) => `--- SAMPLE ${i + 1} ---\n${String(s).slice(0, 600)}`)
    .join("\n\n");

  return `You are a writing coach who knows the user's personal email style from these samples:

${blocks}

The user is actively writing this draft (they may not be done yet):
"""
${String(userDraft).slice(0, 2000)}
"""

Does it sound like the user, based on the samples? Return ONLY JSON:
{
  "matches": true | false,
  "overallNote": "1 short sentence — what's working or off",
  "flaggedLines": [{"line": "exact phrase from draft", "issue": "why off-tone", "suggestion": "natural rewrite in user's voice"}]
}

Be specific. Empty flaggedLines array when the draft already sounds like the user.`;
}

export function toneCheckPrompt(userDraft, originalEmail) {
  return `Analyze this email draft and return ONLY JSON.

USER'S DRAFT: ${userDraft}
ORIGINAL EMAIL: ${originalEmail?.body || "(no original email available)"}

Return:
{
  "toneFingerprint": "1-2 sentences describing tone, flagging problems",
  "flaggedPhrases": [{"phrase": "exact phrase", "issue": "why problematic", "suggestion": "natural rewrite"}],
  "lengthFeedback": "Comment on length appropriateness",
  "overallScore": 1-10,
  "rewrittenDraft": "Natural rewrite of full draft"
}`;
}
