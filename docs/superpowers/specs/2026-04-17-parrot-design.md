# Parrot — Design Spec

**Date:** 2026-04-17
**Status:** Approved (brainstorm) — pending implementation plan

## Vision

Parrot is a messaging layer for LLMs. Instead of emailing a person, you tell your Claude to send a message to them. Their Claude surfaces it naturally when they next open Claude.

Tagline: *"Reach people through their LLM, not their inbox."*

Origin: writing a memo in Claude that will be reviewed in Claude — the copy-paste loop between LLMs is the friction Parrot removes.

## Scope (v1)

**In:**
- Send a text message from one Parrot user to another
- Recipient's Claude auto-surfaces unread messages at session start (opt-in)
- Manual `check_messages` tool for on-demand pulls
- Onboarding flow: pick username, opt into auto-check
- Target: Claude Code on macOS (single-user, single-machine per username)

**Out (defer to v2 or later):**
- Web / mobile dashboard
- System notifications
- Scheduled background polling
- Accounts / authentication
- Group messages, file attachments, replies/threading
- Claude Desktop support (separate hook model)

## Architecture

Three components sharing one `.env`:

1. **MCP server** — exposes `send_message` and `check_messages` tools to Claude
2. **SessionStart hook** — small Node script that Claude Code runs at session start; prints unread messages to stdout (context injection) and marks them read
3. **Skill** — markdown that runs one-time onboarding: sets username, installs the hook in `~/.claude/settings.json`

Storage: Firebase Firestore (already initialized). Single `messages` collection:

```json
{
  "from": "owen",
  "to": "laila",
  "content": "...",
  "read": false,
  "created_at": <serverTimestamp>
}
```

## Components

### MCP server (`mcp/`)

- `index.js` — MCP server, two tools
- `firebase.js` — Firestore client, exports `sendMessage`, `checkMessages`
- `.env` — Firebase creds + `PARROT_USERNAME` (gitignored)

**`send_message(to, content)`** — writes new document to `messages` with `from = PARROT_USERNAME`, `read = false`, server timestamp. Returns `"Message sent to {to}."`

**`check_messages()`** — queries `messages where to == PARROT_USERNAME and read == false`, marks results as read in a batch write, returns `[{from, content}]`. No username argument — username comes from env (prevents accidentally reading someone else's mail).

### SessionStart hook (`hook/check-inbox.js`)

- Reads same `.env` as MCP server
- Queries Firestore for unread messages addressed to `PARROT_USERNAME`
- If any found: prints formatted output to stdout, marks them read
- If none or on error: exits silently (no output) — must not block session startup

Output format (injected as session context):
```
You have N unread Parrot message(s):

From owen (2026-04-17 20:30):
[content]

From james (2026-04-17 19:12):
[content]
```

**Delivery semantics:** mark-as-read happens in the hook itself. Rationale: the content is now in Claude's session context, which is "delivered." Firestore still retains the message with `read: true` — nothing is destroyed, just no longer in the inbox.

### Skill (`skill/parrot/SKILL.md`)

Invoked when the user says `/parrot-setup` or asks Claude to set up Parrot.

Onboarding flow:
1. Ask for username → write `PARROT_USERNAME` to `.env`
2. Ask: "Auto-surface messages at session start? (recommended)"
   - If yes → append SessionStart hook entry to `~/.claude/settings.json`
3. Confirm setup, show example of sending a message

Also handles reconfiguration (change username, toggle auto-check, uninstall).

## Data flow

**Send:**
```
Owen: "send Laila the memo"
→ Claude calls send_message(to="laila", content=...)
→ MCP writes to Firestore
→ returns confirmation
```

**Receive (auto, the magic path):**
```
Laila opens Claude Code
→ SessionStart hook runs check-inbox.js
→ prints unread + marks read
→ output injected as session context
→ Claude naturally says "Owen sent you a memo — want help reviewing it?"
```

**Receive (manual):**
```
Laila: "any Parrot messages?"
→ Claude calls check_messages() tool
→ same query + mark-read logic, returns messages
```

## Error handling

- **Firebase unreachable** — MCP tools return error string so Claude tells user. Hook silently no-ops (never block session startup).
- **Missing `PARROT_USERNAME`** — MCP tools error with "Run /parrot-setup to configure". Hook silently no-ops.
- **Race on simultaneous check** — Firestore batch writes are atomic per document; worst case one caller sees empty results because another already consumed them. Acceptable.

## Identity & trust (v1)

Username is a free-text string. No verification. Anyone who sets `PARROT_USERNAME=laila` on their machine can read laila's messages. Acceptable for trusted pairs / small invited groups where participants share usernames out-of-band. A real auth layer is v2 (likely Firebase Auth with email sign-in, then username = authenticated uid).

## Testing

Manual end-to-end smoke test (the MVP definition of done):

1. Owen's Claude Code: "send a test message to laila saying hello"
2. Verify document appears in Firestore console
3. Laila's Claude Code (separate config, `PARROT_USERNAME=laila`): start new session → message surfaces in first assistant turn
4. Laila asks "any Parrot messages?" → returns "no unread messages"

## File structure

```
~/Projects/parrot/
  firebase.json                       # existing
  firestore.rules                     # existing
  firestore.indexes.json              # existing
  mcp/
    index.js                          # MCP server
    firebase.js                       # shared Firestore client
    .env                              # creds + username (gitignored)
    .env.example
    package.json
  hook/
    check-inbox.js                    # SessionStart hook script
  skill/
    parrot/
      SKILL.md                        # onboarding instructions
  docs/
    superpowers/specs/
      2026-04-17-parrot-design.md     # this file
  .gitignore
  README.md
```

`firebase.js` lives in `mcp/` and is imported from `hook/check-inbox.js` via relative path. If this feels ugly later, we move it to a shared `lib/`.

## Open questions (deferred, not blockers)

- Claude Desktop parity — different hook model, revisit if users ask
- Web inbox UI — obvious v2 surface
- Peek vs consume — should `check_messages` mark read, or should a separate "ack" tool do it? Current design: consume = read. Simple, possibly lossy if Claude session is closed before user engages. Revisit if we see real loss.
- Spam / unsolicited messages — no defense in v1; fine while invite-only.
