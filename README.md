# Parrot

LLM-to-LLM messaging. Tell your Claude to send a message to someone; their Claude surfaces it at the start of their next session.

> *"Reach people through their LLM, not their inbox."*

Parrot is distributed as a Claude Code plugin. It ships with one shared Firebase backend — everyone who installs Parrot is on the same network.

## Install

### Via marketplace (recommended, no cloning)

Add the Parrot marketplace to your Claude config, then enable the plugin.

In `~/.claude/settings.json`:

```jsonc
{
  "extraKnownMarketplaces": {
    "parrot": {
      "source": {
        "source": "github",
        "repo": "<YOUR_GITHUB_USERNAME>/parrot"
      }
    }
  },
  "enabledPlugins": {
    "parrot@parrot": true
  }
}
```

Restart Claude Code. The plugin will be downloaded, its MCP server registered, and its SessionStart hook installed automatically.

### Local install (development)

Clone this repo, then point Claude at it manually:

```bash
git clone https://github.com/<YOUR_USERNAME>/parrot ~/Projects/parrot
cd ~/Projects/parrot/mcp && npm install
claude mcp add --scope user parrot node ~/Projects/parrot/mcp/index.js
```

And add a SessionStart hook to `~/.claude/settings.json`:

```json
"hooks": {
  "SessionStart": [
    {
      "matcher": "startup|resume",
      "hooks": [
        { "type": "command", "command": "node /Users/<USER>/Projects/parrot/hook/check-inbox.js" }
      ]
    }
  ]
}
```

## First-time setup

Run `/parrot` in any Claude Code session. The skill will ask for your username and write it to `~/.config/parrot/config.json`. That's the only config you need — Firebase credentials are bundled.

## Usage

**Send a message:**
> "Send a Parrot message to laila saying the memo is ready for review."

Claude calls the `send_message` tool, which writes to Firestore.

**Receive a message:**
- **Automatic:** when you start a new Claude Code session, the SessionStart hook pulls any unread messages and injects them as context. Claude will naturally surface them.
- **Manual:** ask "any Parrot messages?" — Claude calls the `check_messages` tool.

## What's in v1

- Shared Firebase Firestore backend (same for all users)
- Two MCP tools: `send_message`, `check_messages`
- SessionStart hook that auto-pulls unread messages
- `/parrot` skill + slash command for setup

## What's not in v1

- Accounts / auth — username is just a string; anyone claiming a username can read their mail
- Web or mobile UI
- System notifications
- Scheduled polling
- Group messages, attachments, threading/replies

## Architecture

```
your Claude → send_message MCP tool → Firestore messages collection
                                                ↓
                                      (Firestore security rules: open for v1)
                                                ↓
their Claude → SessionStart hook → check-inbox.js → injected context
```

See `docs/superpowers/specs/2026-04-17-parrot-design.md` for the full design.

## Repo layout

```
.claude-plugin/plugin.json    # plugin metadata
.mcp.json                     # MCP server registration
hooks/hooks.json              # SessionStart hook
skills/parrot/SKILL.md        # onboarding skill
commands/parrot.md            # /parrot slash command
mcp/                          # MCP server (Node.js)
  index.js
  firebase.js                 # Firebase config bundled here
  package.json
hook/check-inbox.js           # SessionStart hook script
assets/parrot.png             # logo

firebase.json                 # Firebase project config (for the project admin)
firestore.rules
firestore.indexes.json
```

## License

MIT.
