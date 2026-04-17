---
name: parrot
description: Use when the user asks to set up Parrot, change their Parrot username, or manage their Parrot messaging configuration. Also use when the user runs /parrot. Do not use this skill for sending or checking messages — those are MCP tools.
---

# Parrot Setup

Parrot is an LLM-to-LLM messaging layer. One user tells their Claude to send a message; the recipient's Claude surfaces it at the start of their next session.

This skill handles first-run setup and reconfiguration. Messaging itself goes through the `parrot` MCP server (`send_message`, `check_messages` tools) — do not handle messaging in this skill.

## Config

User config lives at `~/.config/parrot/config.json`:

```json
{ "username": "owen" }
```

The MCP server and SessionStart hook both read this file. The username is the only user-configurable value — Firebase credentials are bundled with the plugin.

## What to do

### First-time setup

1. **Ask the user what username they want.** Short, memorable, lowercase preferred. Letters, digits, underscores only. Tell them it needs to match what other Parrot users know them as — this is how messages are addressed.
2. **Write the config.** Create `~/.config/parrot/config.json` with `{"username": "<name>"}`. Create parent directory if missing.
3. **Confirm:** "You're set up as `<username>`. Ask me to send a Parrot message to anyone and I'll deliver it. When you start a new Claude Code session, any unread messages will surface automatically."

### Change username

Rewrite `~/.config/parrot/config.json` with the new username. Nothing else to change — the plugin picks it up on next invocation.

### Uninstall

Tell the user to disable the Parrot plugin in their Claude settings (or remove it from `enabledPlugins` in `~/.claude/settings.json`). They can also delete `~/.config/parrot/` if they want to wipe their local config.

### Troubleshooting

- **Tools report "Parrot username not set"** → the config file is missing or malformed. Rerun setup.
- **Messages aren't auto-surfacing on new sessions** → verify the plugin is enabled in `~/.claude/settings.json`. Run `node ${CLAUDE_PLUGIN_ROOT}/hook/check-inbox.js` manually and see if it prints anything.
- **Firebase errors** → likely a network issue; hook silently no-ops and MCP tools will return an error.

## What not to do

- Do not modify anything under `${CLAUDE_PLUGIN_ROOT}` — that's the plugin install and will be overwritten on upgrade.
- Do not send or check messages from within this skill — use the MCP tools.
- Do not attempt to bundle Firebase auth — v1 intentionally has no authentication.
