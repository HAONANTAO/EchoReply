# EchoReply — Privacy Policy

_Last updated: 2026-05-14_

EchoReply is a Chrome extension that adds an AI-powered assistant sidebar to
Gmail. This policy explains what data the extension touches and where it goes.

## What EchoReply accesses

- **Email content in Gmail.** When you open an email, EchoReply reads the
  sender, subject, and body of the currently open message (and the thread it
  belongs to) so it can analyze the email and draft replies.
- **Your API key.** You provide your own Claude (Anthropic) or OpenAI API key.
- **Optional writing samples.** If you choose to, EchoReply can save copies of
  your own past emails as "style samples" to make drafts sound like you.

## Where your data goes

- **To the AI provider you choose.** Email content, your writing samples, and
  your drafts are sent over HTTPS directly from your browser to Anthropic
  (`api.anthropic.com`) or OpenAI (`api.openai.com`) — whichever provider you
  configured — solely to generate analysis and reply drafts. Your API key is
  sent only to that provider for authentication.
- **Nowhere else.** EchoReply has no backend server. The developer does not
  receive, store, or have access to your emails, drafts, API key, or any other
  data.

## Where your data is stored

All extension data — your API key, settings, writing samples, cached analysis,
draft history, and usage counts — is stored **locally in your browser** using
`chrome.storage.local`. It never leaves your device except for the API calls
described above. Uninstalling the extension removes this data.

## What EchoReply does NOT do

- It does not log, transmit, or sell your email content.
- It does not use analytics or tracking.
- It does not send data to any third party other than the AI provider you
  explicitly configure.

## Permissions

- `storage` — to save your settings and cached data locally.
- Host access to `mail.google.com` — to show the sidebar inside Gmail.
- Host access to `api.anthropic.com` and `api.openai.com` — to call the AI
  provider you chose.

## Contact

For questions about this policy, open an issue at
<https://github.com/HAONANTAO/EchoReply/issues>.
