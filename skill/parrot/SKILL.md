---
name: parrot
description: Use when the user asks to set up Parrot, configure their Parrot username, install or remove the Parrot session-start auto-check, or otherwise manage their Parrot messaging configuration. Also use when the user runs /parrot-setup.
---

# Parrot Setup

Parrot is an LLM-to-LLM messaging layer. One user tells their Claude to send a message; the recipient's Claude surfaces it at the start of their next session.

This skill handles onboarding and reconfiguration. Message sending and checking happens through the `parrot` MCP server's tools, not through this skill.

## Files and paths

- Config lives at `~/Projects/parrot/mcp/.env` (Firebase credentials + `PARROT_USERNAME`)
- Hook script: `~/Projects/parrot/hook/check-inbox.js`
- The auto-check hook is registered in `~/.claude/settings.json` under `hooks.SessionStart`

## What to do

### First-time setup

1. **Ask the user what username they want** (their Parrot handle). Short, memorable, lowercase, letters/digits/underscores only.
2. **Write `PARROT_USERNAME=<name>`** into `~/Projects/parrot/mcp/.env`. If the file doesn't exist, something is wrong — the Firebase credentials must already be there; abort and report.
3. **Ask:** "Want Claude to automatically surface incoming messages when you start a new session? (Recommended.)"
4. If yes → install the SessionStart hook (see below).
5. Confirm: "You're set up as `<username>`. Ask me to send a message to anyone else who's set up Parrot, and I'll handle it."

### Installing the SessionStart hook

Read `~/.claude/settings.json`. Add an entry under `hooks.SessionStart` (creating the object if missing):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/<USER>/Projects/parrot/hook/check-inbox.js"
          }
        ]
      }
    ]
  }
}
```

If a SessionStart entry already exists, append a new hook to the array rather than replacing.

### Reconfiguration

- **Change username** → rewrite `PARROT_USERNAME` in `.env`. Nothing else needs to change.
- **Disable auto-check** → remove the `check-inbox.js` entry from `~/.claude/settings.json`. Leave other SessionStart hooks alone.
- **Uninstall** → disable auto-check, then tell the user they can remove the project folder and MCP server entry from their Claude MCP config.

### Troubleshooting

- **Tools error "PARROT_USERNAME not set"** → rerun setup, check `.env`.
- **Messages aren't arriving on auto-check** → verify the hook entry in `~/.claude/settings.json`, run `node ~/Projects/parrot/hook/check-inbox.js` manually to see if it prints anything.
- **Firebase errors** → verify credentials in `.env`, confirm the Firestore `messages` collection is readable.

## What not to do

- Don't edit the Firebase credentials unless the user explicitly wants to switch Firebase projects.
- Don't attempt to send messages from within this skill — use the `send_message` MCP tool.
- Don't mark messages as read from within this skill — `check_messages` does that.
