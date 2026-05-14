# Build EchoReply Chrome Extension

Build a complete, production-ready Manifest V3 Chrome extension called **EchoReply** that injects an AI assistant sidebar into Gmail. Build it now — don't ask questions, follow this spec exactly.

## What It Does

Inside Gmail, an open email triggers a sidebar that shows:
1. **AI analysis** of the email (intent / emotional tone / reply strategy)
2. **3 AI-generated reply drafts** in different tones
3. **Tone Check** — user pastes their draft, AI flags problems

User brings their own Claude or OpenAI API key. No backend.

## Tech Constraints — Follow Strictly

- Manifest V3
- **Vanilla JavaScript only** — NO React, NO TypeScript, NO build step
- **No external libraries** at all
- All files must work directly when loaded as unpacked extension
- `chrome.storage.local` for state
- Target Chrome 120+

## File Structure — Create Exactly This

```
echoreply/
├── manifest.json
├── background.js
├── content.js
├── sidebar/
│   ├── sidebar.html
│   ├── sidebar.css
│   └── sidebar.js
├── lib/
│   ├── gmailParser.js
│   ├── aiProvider.js
│   ├── prompts.js
│   └── insertDraft.js
├── options/
│   ├── options.html
│   ├── options.css
│   └── options.js
├── icons/icon16.png, icon48.png, icon128.png (use simple purple ✦ for now)
└── README.md
```

## manifest.json

```json
{
  "manifest_version": 3,
  "name": "EchoReply",
  "version": "1.0.0",
  "description": "Understand the email. Then reply. AI-powered email coach for Gmail.",
  "icons": {"16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png"},
  "action": {"default_icon": "icons/icon48.png", "default_title": "EchoReply"},
  "background": {"service_worker": "background.js"},
  "content_scripts": [{
    "matches": ["https://mail.google.com/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "permissions": ["storage"],
  "host_permissions": ["https://api.anthropic.com/*", "https://api.openai.com/*"],
  "options_page": "options/options.html",
  "web_accessible_resources": [{
    "resources": ["sidebar/sidebar.html", "sidebar/sidebar.css", "sidebar/sidebar.js"],
    "matches": ["https://mail.google.com/*"]
  }]
}
```

## Design System

- Primary color: `#5B6CF0`
- Gradient: `linear-gradient(135deg, #5B6CF0, #7B5BF0)`
- Background: `#FAFAFA` (sidebar), `linear-gradient(180deg, #FAFAFF, #F4F4FA)` (cards container)
- Text: `#1A1A1A` primary, `rgba(0,0,0,0.6)` secondary
- Cards: white background, `0 1px 4px rgba(0,0,0,0.04)` shadow, `8px` radius
- Borders: `rgba(91,108,240,0.15)`
- Font: `'Inter', system-ui, sans-serif`
- Labels: `9-11px, uppercase, letter-spacing 1.5px`
- Body: `12-13px, line-height 1.6`

## Sidebar Layout (sidebar.html structure)

```
[Header: ✦ EchoReply           ›]
[Card: Real Intent             ]
[Card: Emotional Temperature   ]
[Card: Reply Strategy          ]
[Drafted Replies section]
  [🎩 Professional →]
  [🤝 Warm →]
  [⚡ Confident →]
[Tone Check section]
  [Textarea]
  [Check My Draft button]
  [Result area, hidden by default]
[Footer: ⚙  Powered by Claude]
```

Sidebar is positioned `fixed` on right side, `320px` wide, full height.

## AI Prompts (in lib/prompts.js)

```javascript
export const SYSTEM_PROMPT = `You are EchoReply, an AI email coach. Analyze emails with the intelligence of a senior communication expert. Always respond in valid JSON only — no markdown, no preamble. Be concise, direct, and emotionally intelligent.`;

export function decoderPrompt(email) {
  return `Analyze this email and return ONLY JSON.

FROM: ${email.sender}
SUBJECT: ${email.subject}
BODY: ${email.body}

Return:
{
  "realIntent": "1-2 sentence summary of what the sender actually wants",
  "temperature": "WARM" | "COOL" | "NEUTRAL" | "URGENT" | "FRUSTRATED",
  "temperatureNote": "One-line tone description",
  "replyStrategy": "MUST_REPLY" | "SHOULD_REPLY" | "OPTIONAL" | "DONT_REPLY",
  "strategyAdvice": "One-line recommendation"
}`;
}

export function draftPrompt(email, style) {
  const styles = {
    professional: "Formal, business-appropriate, safe. Proper salutation and signoff.",
    warm: "Human, sincere, relationship-first. Acknowledges the person.",
    confident: "Direct, assertive. No over-thanking, no hedging."
  };
  return `Generate a ${style} reply.

FROM: ${email.sender}
SUBJECT: ${email.subject}
BODY: ${email.body}

STYLE: ${styles[style]}

Rules:
- 40-100 words
- No clichés like "Looking forward to your reply"
- No over-polite phrases like "I would be very grateful"
- Sound natural and human

Return ONLY the reply text. No JSON. No explanation.`;
}

export function toneCheckPrompt(userDraft, originalEmail) {
  return `Analyze this email draft and return ONLY JSON.

USER'S DRAFT: ${userDraft}
ORIGINAL EMAIL: ${originalEmail.body}

Return:
{
  "toneFingerprint": "1-2 sentences describing tone, flagging problems",
  "flaggedPhrases": [{"phrase": "exact phrase", "issue": "why problematic", "suggestion": "natural rewrite"}],
  "lengthFeedback": "Comment on length appropriateness",
  "overallScore": 1-10,
  "rewrittenDraft": "Natural rewrite of full draft"
}`;
}
```

## AI Provider (lib/aiProvider.js)

```javascript
// Single unified function — provider determined by stored settings
export async function callAI(prompt, returnsJSON = true) {
  const { provider, apiKey } = await chrome.storage.local.get(['provider', 'apiKey']);
  
  if (!apiKey) throw new Error('NO_API_KEY');
  
  if (provider === 'openai') {
    return callOpenAI(apiKey, prompt, returnsJSON);
  }
  return callClaude(apiKey, prompt, returnsJSON); // default
}

async function callClaude(apiKey, prompt, returnsJSON) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      temperature: 0.7,
      system: 'You are EchoReply, an AI email coach. Be concise and emotionally intelligent.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  
  if (!res.ok) throw new Error(`API_ERROR_${res.status}`);
  
  const data = await res.json();
  const text = data.content[0].text;
  
  return returnsJSON ? JSON.parse(text.replace(/```json\s*|\s*```/g, '').trim()) : text;
}

async function callOpenAI(apiKey, prompt, returnsJSON) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      temperature: 0.7,
      messages: [
        { role: 'system', content: 'You are EchoReply, an AI email coach.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  
  if (!res.ok) throw new Error(`API_ERROR_${res.status}`);
  
  const data = await res.json();
  const text = data.choices[0].message.content;
  
  return returnsJSON ? JSON.parse(text.replace(/```json\s*|\s*```/g, '').trim()) : text;
}
```

## Gmail Parser (lib/gmailParser.js)

```javascript
export function extractCurrentEmail() {
  // Multiple selector fallbacks since Gmail DOM changes
  const openEmail = document.querySelector('[role="main"] [data-message-id]') ||
                    document.querySelector('.adn.ads');
  
  if (!openEmail) return null;
  
  const sender = openEmail.querySelector('[email]')?.getAttribute('email') ||
                 openEmail.querySelector('.gD')?.getAttribute('email') ||
                 openEmail.querySelector('.go')?.textContent ||
                 'unknown';
  
  const senderName = openEmail.querySelector('.gD')?.getAttribute('name') ||
                     openEmail.querySelector('[email]')?.getAttribute('name') ||
                     sender;
  
  const subject = document.querySelector('h2.hP')?.textContent?.trim() || '';
  
  const body = openEmail.querySelector('.a3s.aiL')?.innerText?.trim() ||
               openEmail.querySelector('.ii.gt')?.innerText?.trim() ||
               '';
  
  if (!body) return null;
  
  return {
    id: openEmail.dataset.messageId || `email-${Date.now()}`,
    sender,
    senderName,
    subject,
    body: body.slice(0, 4000) // truncate huge emails
  };
}

export function onEmailOpened(callback) {
  // MutationObserver watches for email opens
  const observer = new MutationObserver(() => {
    const email = extractCurrentEmail();
    if (email && email.id !== window.__lastEmailId) {
      window.__lastEmailId = email.id;
      callback(email);
    }
  });
  
  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}
```

## Insert Draft (lib/insertDraft.js)

```javascript
export function insertDraftIntoCompose(text) {
  const composeBox = document.querySelector('[role="textbox"][aria-label*="Message"]') ||
                     document.querySelector('[role="textbox"][aria-label*="Body"]');
  
  if (!composeBox) {
    alert('Please open the reply box first (click Reply).');
    return false;
  }
  
  composeBox.focus();
  
  // Use document.execCommand for contenteditable (still works in Chrome 2026)
  document.execCommand('insertText', false, text);
  
  composeBox.dispatchEvent(new InputEvent('input', { bubbles: true }));
  return true;
}
```

## content.js — Sidebar Mounting

```javascript
// Wait for Gmail to load, then inject sidebar
const SIDEBAR_ID = 'echoreply-sidebar-root';

function injectSidebar() {
  if (document.getElementById(SIDEBAR_ID)) return;
  
  const root = document.createElement('div');
  root.id = SIDEBAR_ID;
  
  // Fetch sidebar HTML and inject
  fetch(chrome.runtime.getURL('sidebar/sidebar.html'))
    .then(r => r.text())
    .then(html => {
      root.innerHTML = html;
      document.body.appendChild(root);
      
      // Load sidebar styles
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = chrome.runtime.getURL('sidebar/sidebar.css');
      document.head.appendChild(css);
      
      // Load sidebar logic
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('sidebar/sidebar.js');
      script.type = 'module';
      document.head.appendChild(script);
    });
}

// Inject when Gmail loads
if (document.readyState === 'complete') {
  injectSidebar();
} else {
  window.addEventListener('load', injectSidebar);
}
```

## sidebar.js — Main Logic

Use `import` syntax (sidebar.js is loaded as `type="module"`). Wire up:
- Listen for email opens → call decoder → render cards
- Click draft button → call AI → expand to show draft + Copy/Insert
- Click "Check My Draft" → call tone check → show results
- Settings gear → open chrome.runtime.openOptionsPage()
- Collapse chevron → toggle sidebar visibility, persist state

Cache AI responses per email ID in `chrome.storage.local` (`emailCache_${id}`).

## Options Page (options.html/css/js)

Simple form with:
- Provider toggle: [○ Claude] [○ OpenAI]
- API Key input (password type, show/hide toggle)
- Default Style dropdown: Professional / Warm / Confident
- Test Connection button (sends a 1-token ping)
- Save button

Style matches sidebar: purple primary, clean cards, Inter font.

## Error Handling

In sidebar, show inline error states:
- `NO_API_KEY` → "Set your API key in settings ⚙"
- `API_ERROR_401` → "Invalid API key"
- `API_ERROR_429` → "Rate limit hit, try again in a moment"
- `API_ERROR_5xx` → "Provider error, retry"
- Network error → "Connection failed"

Each error has a "Retry" button.

## Build Order — Execute in this exact sequence

1. Create folder structure + all empty files
2. Write `manifest.json`
3. Write `options/` (full settings page working)
4. Write `lib/gmailParser.js` + test with console
5. Write `lib/aiProvider.js` + `lib/prompts.js`
6. Write `lib/insertDraft.js`
7. Write `sidebar/sidebar.html` + `sidebar.css` (full UI, no logic yet)
8. Write `content.js` (mount sidebar into Gmail)
9. Write `sidebar/sidebar.js` — Decoder feature
10. Wire up 3 Draft Styles
11. Wire up Tone Check
12. Add error handling everywhere
13. Add caching layer
14. Create icons (simple purple ✦ on white, 16/48/128px)
15. Write README.md with install instructions

## Success Criteria

When done:
- Load extension in `chrome://extensions/` (Developer Mode → Load Unpacked)
- Set API key in options
- Open Gmail, open any email
- Sidebar slides in from right, shows analysis cards
- Click "Professional" → see draft → click "Insert" → reply appears in Gmail compose
- Open Tone Check, paste a draft → get feedback

## Final Quality Bar

- Zero console errors
- Sidebar loads in <500ms after email opens
- Privacy: never log email content
- All UI in English
- Clean, readable code with comments at key decision points

---

**Now build it. Start with Step 1.**
