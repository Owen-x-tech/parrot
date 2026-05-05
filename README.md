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
        "repo": "Owen-x-tech/parrot"
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
git clone https://github.com/Owen-x-tech/parrot ~/Projects/parrot
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

Sign up at **https://parrot-web-five.vercel.app/** with email/password or Google, then claim a username. Click **Generate plugin token** to get a one-time pairing string.

In Claude Code, run `/parrot` and paste the pairing string when prompted. The plugin saves your refresh token to `~/.config/parrot/config.json` (mode 0600) and you're ready to send messages.

## Usage

**Send a message:**
> "Send a Parrot message to laila saying the memo is ready for review."

Claude calls the `send_message` tool, which writes to Firestore.

**Receive a message:**
- **Automatic:** when you start a new Claude Code session, the SessionStart hook pulls any unread messages and injects them as context. Claude will naturally surface them.
- **Manual:** ask "any Parrot messages?" — Claude calls the `check_messages` tool.

## What's in v2

- **Web sign-up at https://parrot-web-five.vercel.app/** with email/password or Google
- **Locked-down Firestore rules**: auth-required, sender-bound `from`, recipient-only read
- **Username binding**: usernames are claimed on the website, bound to the user's Firebase UID, immutable in v2
- **Pairing-string flow**: copy a one-time string from the website, paste into `/parrot` to authenticate the local plugin
- Three MCP tools: `send_message`, `check_messages`, `pair`
- SessionStart hook auto-pulls unread messages
- Plugin uses Firebase REST APIs only (no `firebase` npm dependency at runtime)

## What's not in v2

- **Payments / paid tier** — architecture supports it (one rule line + a Stripe webhook), but not wired
- Username changes — usernames are permanent in v2
- Group messages, attachments, threading/replies
- A web inbox view (would be quick to add — uses the same Firestore reads)

## Architecture

```
            parrot-web (Next.js on Vercel)
        ┌──────────────────────────────────┐
        │  /login → /setup → pairing string │
        └──────────────────┬────────────────┘
                           │
                  user pastes into Claude
                           │
your Claude → pair tool → exchange custom token via Firebase REST
                           │
                  refresh token saved at ~/.config/parrot/config.json (0600)
                           │
your Claude → send_message → Firestore REST (auth-required rules)
                                                ↓
                              (sender-bound, recipient-only read)
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
  index.js                    # MCP server entrypoint (send_message, check_messages, pair)
  firebase.js                 # orchestrator: pair, sendMessage, checkMessages
  config.js                   # local config read/write (mode 0600)
  auth-rest.js                # Firebase Identity Toolkit REST client
  firestore-rest.js           # Firestore REST client
  package.json
tests/                        # Firestore rules unit tests (emulator)
  rules.test.js
  helpers.js
hook/check-inbox.js           # SessionStart hook script
assets/parrot.png             # logo

firebase.json                 # Firebase project config (for the project admin)
firestore.rules
firestore.indexes.json
```

## License

MIT.
