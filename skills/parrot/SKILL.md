---
name: parrot
description: Use when the user asks to set up Parrot, pair a new Claude with their Parrot account, or manage their Parrot configuration. Also use when the user runs /parrot. Do not use this skill for sending or checking messages — those are MCP tools.
---

# Parrot Setup

Parrot is an LLM-to-LLM messaging layer. One user tells their Claude to send a message; the recipient's Claude surfaces it at the start of their next session.

This skill handles pairing a new Claude with the user's Parrot account. Sign-up and username claim happen on the Parrot website (https://parrot-web-five.vercel.app/) — not here.

## Config

User config lives at `~/.config/parrot/config.json` (mode 0600):

```json
{
  "username": "owen",
  "uid": "<firebase-uid>",
  "refresh_token": "<firebase refresh token>"
}
```

The MCP server and SessionStart hook both read this file. The refresh token grants long-lived access to the user's Parrot account, so the file is locked to mode 0600. Treat it like an SSH key.

## What to do

### First-time pairing

1. **Direct the user to the website.** Tell them: "Open https://parrot-web-five.vercel.app/ and click Get started. Sign up with Google or email/password, then claim a username. When you click 'Generate plugin token', copy the long string it shows you and paste it back here."

2. **Wait for the user to paste a pairing string.** It will be a long base64 blob.

3. **Call the `pair` MCP tool** with the pairing string. It returns the bound username on success or an error message.

4. **On success**, confirm: "Paired as `<username>`. Ask me to send a Parrot message to anyone and I'll deliver it. When you start a new Claude Code session, any unread messages will surface automatically."

### Re-pairing on a new device

Same flow as first-time pairing. Each `pair` call replaces the local config with new credentials. The user keeps their Firebase account and username — only the local refresh token changes.

### Change username

Not supported in v2 — usernames are bound to UID at first claim. Tell the user: "Username changes aren't supported yet. To use a different name you'd need to sign up for a new account on parrot-web."

### Uninstall

Tell the user to disable the Parrot plugin (or remove from `enabledPlugins` in `~/.claude/settings.json`). They can delete `~/.config/parrot/` to wipe local credentials. Their account on parrot-web persists but is harmless.

### Troubleshooting

- **"Parrot not paired"** → config file is missing or has no refresh_token. Run `/parrot` and paste a fresh pairing string.
- **"signInWithCustomToken failed"** → the pairing string is expired (custom tokens expire in 1 hour) or malformed. Get a fresh one from parrot-web.
- **"refreshIdToken failed"** → refresh token has been revoked (e.g. user deleted their Firebase account, or signed out everywhere on parrot-web). Re-pair from the website.
- **Permission denied on send/check** → the rules rejected something. Likely a stale config; re-pair.
- **Messages aren't auto-surfacing** → verify the plugin is enabled. Run `node ${CLAUDE_PLUGIN_ROOT}/dist/check-inbox.js` manually and see if it prints anything.

## What not to do

- Do not handle sign-up or username claim in this skill. That happens on parrot-web.
- Do not modify anything under `${CLAUDE_PLUGIN_ROOT}` — overwritten on plugin upgrade.
- Do not send or check messages from this skill — use the MCP tools.
- Do not relax file permissions on the config file.
