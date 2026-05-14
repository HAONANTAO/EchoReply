# EchoReply

> Understand the email. Then reply.

EchoReply is a Manifest V3 Chrome extension that injects an AI-powered sidebar into Gmail. For any open email it shows:

1. **Real Intent** — what the sender actually wants
2. **Emotional Temperature** — `WARM` / `COOL` / `NEUTRAL` / `URGENT` / `FRUSTRATED`
3. **Reply Strategy** — `MUST_REPLY` / `SHOULD_REPLY` / `OPTIONAL` / `DONT_REPLY`
4. **Three reply drafts** in different tones (🎩 Professional, 🤝 Warm, ⚡ Confident)
5. **Tone Check** — paste your own draft, get flagged phrases and a natural rewrite

You bring your own Claude or OpenAI API key. No backend, no telemetry — your key and the emails you analyze stay between your browser and the provider you choose.

---

## Install (Developer Mode)

1. Clone or download this repo.
2. Open Chrome and go to `chrome://extensions/`.
3. Toggle **Developer mode** on (top-right corner).
4. Click **Load unpacked**.
5. Select the `echoreply/` folder (the one containing `manifest.json`).
6. The EchoReply ✦ icon should appear in your extensions bar.

## Set up your API key

1. Click the ✦ icon in your toolbar (or right-click → **Options**).
2. Pick a provider: **Claude** or **OpenAI**.
3. Paste your API key:
   - Claude — get one at <https://console.anthropic.com>
   - OpenAI — get one at <https://platform.openai.com/api-keys>
4. Click **Test Connection** to verify (sends a 1-token ping).
5. Click **Save**.

Your key is stored only in `chrome.storage.local` and is never sent anywhere except the provider you selected.

## Use it

1. Open <https://mail.google.com/>.
2. Open any email.
3. The EchoReply sidebar appears on the right and starts analyzing.
4. Click any draft style (🎩 Professional / 🤝 Warm / ⚡ Confident) to generate a reply.
5. Click **Insert** to drop the draft into Gmail's compose box (open Reply first), or **Copy** to put it on your clipboard.
6. Use **Tone Check** to paste your own draft and get tone feedback.

## Privacy

- The extension only runs on `https://mail.google.com/*`.
- Email contents are sent to the provider you chose (Anthropic or OpenAI) over HTTPS, and nowhere else.
- Decoder and draft results are cached locally for 24h per email so repeat views are instant and free.
- EchoReply never logs the email body, never sends data to any third-party server, and has no analytics.

## Tech notes

- Pure Manifest V3, vanilla JS, no build step, no external libraries.
- Models used: `claude-sonnet-4-5` (Anthropic) or `gpt-4o-mini` (OpenAI).
- Sidebar runtime is loaded as a dynamic ES module from the content script, so it runs in the ISOLATED world with full `chrome.*` API access.

## File layout

```
echoreply/
├── manifest.json
├── background.js          # service worker: routes toolbar click → options page
├── content.js             # injects sidebar into mail.google.com
├── sidebar/
│   ├── sidebar.html       # markup
│   ├── sidebar.css        # design system styles
│   └── sidebar.js         # runtime: decoder, drafts, tone check
├── lib/
│   ├── gmailParser.js     # extracts email + watches for opens
│   ├── aiProvider.js      # unified callAI() for Claude + OpenAI
│   ├── prompts.js         # decoder / draft / tone-check templates
│   └── insertDraft.js     # insert text into Gmail compose box
├── options/
│   ├── options.html       # settings form
│   ├── options.css
│   └── options.js         # save + test connection
└── icons/                 # 16/48/128 PNG, purple ✦
```

## Troubleshooting

- **"Set your API key" stays visible** — make sure you clicked **Save** in Options after entering the key, and refresh the Gmail tab.
- **"Invalid API key"** — double-check the key in the provider console; Claude keys start with `sk-ant-`, OpenAI keys start with `sk-`.
- **Sidebar doesn't appear** — open `chrome://extensions/` and click the **errors** indicator on the EchoReply card; reload the extension and the Gmail tab.
- **Insert button alerts "Open the reply box first"** — click Gmail's **Reply** button so the compose box exists, then click Insert again.

## License

MIT — do whatever you want, just don't blame me if the AI gives weird advice.
