# Parrot v3: CLI-First Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `parrot-cli` npm package that owns the entire onboarding experience — signup, username claim, agent integration — without ever requiring a user to copy a secret token into a chat. Web stays as a polished alternative for GUI-preferring users. Add a "copy this prompt to your AI agent" path so non-technical users can have their agent install + configure Parrot for them.

**Architecture:**
- Hoist `auth-rest.js`, `firestore-rest.js`, `config.js` into a top-level `lib/` directory shared by `mcp/` and `cli/`. Both bundle into self-contained dist files via esbuild — no runtime npm deps for end-users beyond `parrot-cli` itself.
- `cli/` becomes its own publishable npm package (`parrot-cli`) with a `bin` entry point. esbuild bundles the CLI + all shared modules into `cli/dist/parrot.js`. Published with `"files": ["dist", "README.md"]` so only the bundle ships.
- The CLI talks directly to Firebase Identity Toolkit and Firestore REST APIs — same as the MCP server. Email/password signup happens via `accounts:signUp`. Username claim via Firestore writes. Agent integration writes to `~/.claude.json` and `~/.cursor/mcp.json`.
- `parrot init` is the interactive wizard. Single command that asks signup vs. login, then asks which agent to wire up.
- `parrot agent install claude|cursor` are sub-commands that idempotently modify the agent's user-level config.
- The MCP `pair` tool gets a `--from-file` mode as a defense-in-depth fix for users who don't want to paste tokens into chat.
- Homepage adds two new install paths: a one-line bash install (`curl -fsSL parrot-web-five.vercel.app/install.sh | bash`) and a "copy this into your AI agent" prompt block.

**Tech Stack:**
- Node 20+ (already required by Claude Code)
- esbuild for bundling (already used by mcp/)
- `commander` for CLI subcommand routing
- `@inquirer/prompts` for interactive prompts (modern ESM, handles password masking)
- No runtime Firebase deps — REST + native fetch only

---

## File Structure

**Created:**
- `lib/config.js` — moved from `mcp/config.js`
- `lib/auth-rest.js` — moved from `mcp/auth-rest.js`
- `lib/firestore-rest.js` — moved from `mcp/firestore-rest.js`
- `lib/usernames.js` — new: `claimUsername(idToken, uid, username)` helper
- `lib/messages.js` — new: extracted `sendMessage` / `checkMessages` (currently inlined in `mcp/firebase.js`)
- `cli/package.json` — published as `parrot-cli`
- `cli/bin/parrot.js` — shebang entry, just `import('../dist/parrot.js')`
- `cli/src/index.js` — commander setup, command routing
- `cli/src/commands/init.js`
- `cli/src/commands/signup.js`
- `cli/src/commands/login.js`
- `cli/src/commands/pair.js`
- `cli/src/commands/send.js`
- `cli/src/commands/check.js`
- `cli/src/commands/whoami.js`
- `cli/src/commands/agent.js` — `install <claude|cursor>`, `uninstall <claude|cursor>`
- `cli/src/lib/prompts.js` — wrapper around inquirer (consistent UX)
- `cli/src/lib/output.js` — print helpers, basic ANSI colors
- `cli/build.js` — esbuild config
- `cli/README.md`
- `parrot-web/public/install.sh` — Mac/Linux one-line install
- `parrot-web/public/install.ps1` — Windows one-line install

**Modified:**
- `mcp/firebase.js` — import shared modules from `../lib/` instead of `./`
- `mcp/index.js` — `pair` tool gets optional `pairing_file` param (reads from file path)
- `mcp/build.js` — adjust paths to bundle from new `lib/` location
- `parrot-web/app/page.tsx` — replace homepage with three install paths + agent prompt block
- `README.md` — front-page CLI install, demote JSON-editing path
- `package.json` (root) — add CLI build script

**Deleted:**
- `mcp/config.js` — moved to `lib/`
- `mcp/auth-rest.js` — moved to `lib/`
- `mcp/firestore-rest.js` — moved to `lib/`

---

## Architecture Notes

### CLI ↔ MCP code reuse

Both consume `lib/`:
```
lib/
├── config.js          (read/write ~/.config/parrot/config.json)
├── auth-rest.js       (signUp, signIn, signInWithCustomToken, refreshIdToken)
├── firestore-rest.js  (createDocument, runQuery, patchDocument, getDocument)
├── usernames.js       (claimUsername — orchestrates two-step write)
└── messages.js        (sendMessage, checkMessages)
```

Both `mcp/build.js` and `cli/build.js` use esbuild to bundle these into self-contained dist files. No Node module resolution issues at runtime, no npm install required by end-users.

### Username claim from CLI

The CLI's signup flow needs to claim a username. Shape:

```js
// lib/usernames.js
export async function claimUsername(idToken, uid, username) {
  // Check availability — read /usernames/{name}
  const existing = await getDocument(`usernames/${username}`, idToken).catch(() => null);
  if (existing) {
    if (existing.uid === uid) return; // idempotent
    throw new Error(`Username "${username}" is taken.`);
  }

  // Two writes (rules require usernames doc to exist before users doc):
  await createDocument(`usernames/${username}`, idToken, { uid }, /* docId */ username);
  await createDocument(`users/${uid}`, idToken, { username }, /* docId */ uid);
}
```

This requires `firestore-rest.js` to support a `createDocument` variant that lets the caller specify the doc ID (currently it auto-IDs).

### `parrot init` flow

```
Welcome to Parrot 🦜
LLM-to-LLM messaging for AI agents.

? Do you have a Parrot account already? (y/n) > n

? Email: > owen@example.com
? Password (min 8 chars): ********
? Confirm password: ********

Creating your account...    ✓

? Pick a username (lowercase, 2–32 chars, letters/digits/underscores): owen-mac

Claiming username...        ✓

You're paired as "owen-mac".

? Configure an AI agent to receive messages automatically?
  > Claude Code
    Cursor
    Skip

Configuring Claude Code...
  ✓ MCP server registered in ~/.claude.json
  ✓ SessionStart hook installed in ~/.claude/settings.json

All set. Restart Claude Code, then try:
  parrot send <username> "hello!"
or in your agent: "send a Parrot message to <username> saying hello"
```

### Agent install (Claude Code)

`parrot agent install claude` writes:

In `~/.claude.json`:
```json
"mcpServers": {
  "parrot": {
    "type": "stdio",
    "command": "parrot",
    "args": ["mcp-server"],
    "env": {}
  }
}
```

Wait — that requires the CLI to expose an `mcp-server` subcommand that runs the MCP server. Cleaner than having two binaries. The `mcp-server` command is essentially `import("./mcp-server.js")` re-exported.

In `~/.claude/settings.json`:
```json
"hooks": {
  "SessionStart": [
    {
      "matcher": "startup|resume",
      "hooks": [
        { "type": "command", "command": "parrot check --hook-mode", "timeout": 10 }
      ]
    }
  ]
}
```

The CLI gains a `parrot check --hook-mode` flag that emits the SessionStart-formatted output to stdout (same as the current `dist/check-inbox.js` does).

### Agent install (Cursor)

`parrot agent install cursor` writes to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "parrot": {
      "command": "parrot",
      "args": ["mcp-server"]
    }
  }
}
```

Cursor lacks a SessionStart-equivalent hook, so we also write a `~/.cursor/rules/parrot-inbox.md` (or update `~/.cursor/rules/global.md`) that says:
```markdown
At the start of every conversation, call the parrot__check_messages MCP tool to retrieve any unread Parrot messages addressed to the current user. Surface them naturally if any exist.
```

This is heuristic — depends on Cursor honoring rules at session start. Document the limitation.

### One-line installer

`parrot-web/public/install.sh`:
```bash
#!/usr/bin/env bash
set -e
if ! command -v node >/dev/null; then
  echo "Parrot needs Node 20+. Install from https://nodejs.org/ first."
  exit 1
fi
echo "Installing parrot-cli..."
npm install -g parrot-cli
echo "Done. Starting onboarding..."
exec parrot init
```

Run via:
```
curl -fsSL https://parrot-web-five.vercel.app/install.sh | bash
```

Windows version (`install.ps1`) similar but PowerShell. Run via:
```
iex (irm https://parrot-web-five.vercel.app/install.ps1)
```

### Homepage agent-prompt block

The homepage gets a copy-paste block specifically for non-technical users:

```
> Set up Parrot for me. Run `npm install -g parrot-cli` in my terminal.
> Then run `parrot init` and walk me through it. I'll provide an email,
> password, and username when asked. After signup, configure my AI agent
> (you) to receive Parrot messages automatically. Don't paste any tokens
> into our conversation — let the CLI handle pairing locally.
```

The user pastes this into Cursor or Claude Code. The agent runs the install + init for them, asks for the inputs that need a human, and never sees a secret token.

### Changes to MCP `pair` tool

Add an optional `pairing_file` parameter. The tool either accepts the inline string OR a file path:

```js
server.tool(
  "pair",
  "Pair this Claude with a Parrot account. PREFER `pairing_file` over inline string for security. Use ONLY during /parrot setup.",
  {
    pairing_string: z.string().optional().describe("Inline base64 pairing string (less secure — paste lands in conversation history)"),
    pairing_file: z.string().optional().describe("Path to a file containing the pairing string. Preferred — keeps the secret out of chat history."),
  },
  async ({ pairing_string, pairing_file }) => {
    // ...
  }
);
```

The `parrot init` CLI flow doesn't use this — it does direct signup/pair via REST. The MCP `pair` tool exists for users who already have a pairing string (legacy/edge cases).

---

## Task 1: Hoist shared modules to `lib/`

**Repo:** `/Users/owentaylor/OS/Projects/parrot`

**Files:**
- Create: `lib/config.js`, `lib/auth-rest.js`, `lib/firestore-rest.js`
- Modify: `mcp/firebase.js`, `mcp/build.js`
- Delete: `mcp/config.js`, `mcp/auth-rest.js`, `mcp/firestore-rest.js`

- [ ] **Step 1.1: Create lib/ and move files**

```bash
mkdir -p /Users/owentaylor/OS/Projects/parrot/lib
git mv mcp/config.js lib/config.js
git mv mcp/auth-rest.js lib/auth-rest.js
git mv mcp/firestore-rest.js lib/firestore-rest.js
```

- [ ] **Step 1.2: Update `mcp/firebase.js` imports**

Change the imports at the top:

```js
import { readConfig, writeConfig, getUsername } from "../lib/config.js";
import { signInWithCustomToken, refreshIdToken } from "../lib/auth-rest.js";
import { createDocument, runQuery, patchDocument } from "../lib/firestore-rest.js";
```

(The rest of the file stays the same.)

- [ ] **Step 1.3: Verify mcp/build.js still picks up imports correctly**

The build script uses `entryPoints: [join(root, "mcp", "index.js")]` which then transitively imports `./firebase.js` → `../lib/*.js`. esbuild bundles transitively, so no build script changes needed.

Run: `cd /Users/owentaylor/OS/Projects/parrot && node mcp/build.js`
Expected: prints "Built dist/mcp-server.js and dist/check-inbox.js" with no errors.

- [ ] **Step 1.4: Smoke test the rebuilt MCP server bundle**

```bash
cd /Users/owentaylor/OS/Projects/parrot && node -e "import('./dist/mcp-server.js').catch(e=>{console.error(e.message);process.exit(1)})" 2>&1 | head -5
```
Expected: no module-not-found errors. Server tries to start (will block waiting for stdin and that's fine; we're not testing functionality, just imports).

Kill with Ctrl+C if it hangs.

- [ ] **Step 1.5: Commit**

```bash
git add lib/ mcp/firebase.js
git commit -m "lib: hoist auth-rest, firestore-rest, config to top-level lib/

Shared between mcp/ and the upcoming cli/ package. esbuild bundles
transitively so no other build changes needed."
```

---

## Task 2: Extract `messages.js` and `usernames.js` into lib/

**Files:**
- Create: `lib/messages.js`, `lib/usernames.js`
- Modify: `mcp/firebase.js`, `lib/firestore-rest.js`

- [ ] **Step 2.1: Add `getDocument` and explicit-ID `createDocument` to firestore-rest.js**

The CLI signup needs to:
1. Read `/usernames/{name}` to check availability — needs `getDocument`.
2. Write to `/usernames/{name}` and `/users/{uid}` with explicit IDs — current `createDocument` auto-IDs.

Add to `/Users/owentaylor/OS/Projects/parrot/lib/firestore-rest.js`:

```js
// Get a single document. Returns parsed { id, data } or throws if not found.
export async function getDocument(docPath, idToken) {
  const res = await fetch(`${BASE}/${docPath}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getDocument failed: ${res.status} ${await res.text()}`);
  const doc = await res.json();
  const parts = doc.name.split("/");
  return { id: parts[parts.length - 1], data: fromFsFields(doc.fields) };
}

// Create a doc with a caller-specified ID (uses createDocument with documentId param).
export async function createDocumentWithId(collectionPath, docId, idToken, data) {
  const url = `${BASE}/${collectionPath}?documentId=${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: toFsFields(data) }),
  });
  if (!res.ok) {
    throw new Error(`createDocumentWithId failed: ${res.status} ${await res.text()}`);
  }
}
```

(Keep existing exports.)

- [ ] **Step 2.2: Create `lib/usernames.js`**

```js
import { getDocument, createDocumentWithId } from "./firestore-rest.js";

// Check if username is available. Returns true if free OR owned by current user.
export async function isUsernameAvailable(username, idToken, currentUid) {
  const existing = await getDocument(`usernames/${username}`, idToken);
  if (!existing) return true;
  return existing.data.uid === currentUid;
}

// Claim a username for the current user. Idempotent if already owned.
// Throws if claimed by someone else.
export async function claimUsername(username, idToken, uid) {
  const existing = await getDocument(`usernames/${username}`, idToken);
  if (existing) {
    if (existing.data.uid === uid) {
      // Already ours — ensure users/{uid} exists too
      const userDoc = await getDocument(`users/${uid}`, idToken);
      if (!userDoc) {
        await createDocumentWithId("users", uid, idToken, { username });
      }
      return;
    }
    throw new Error(`Username "${username}" is taken.`);
  }
  // Order matters: usernames first (rule for users/* requires it to exist).
  await createDocumentWithId("usernames", username, idToken, { uid });
  await createDocumentWithId("users", uid, idToken, { username });
}
```

- [ ] **Step 2.3: Create `lib/messages.js`**

Extract from `mcp/firebase.js`:

```js
import { runQuery, patchDocument, createDocument } from "./firestore-rest.js";

export async function sendMessage(idToken, fromUsername, to, content) {
  await createDocument("messages", idToken, {
    from: fromUsername,
    to,
    content,
    read: false,
    created_at: new Date(),
  });
}

export async function checkMessages(idToken, username) {
  const docs = await runQuery("messages", idToken, [
    { field: "to", op: "EQUAL", value: username },
    { field: "read", op: "EQUAL", value: false },
  ]);

  await Promise.all(
    docs.map((d) => patchDocument(`messages/${d.id}`, idToken, { read: true }).catch(() => {}))
  );

  const messages = docs.map((d) => ({
    from: d.data.from,
    content: d.data.content,
    created_at: d.data.created_at instanceof Date ? d.data.created_at : null,
  }));
  messages.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return messages;
}
```

- [ ] **Step 2.4: Update `mcp/firebase.js` to import from new modules**

Replace the inline `sendMessage` and `checkMessages` definitions with imports from `../lib/messages.js`. The orchestrator wraps them:

```js
import { sendMessage as sendMessageRaw, checkMessages as checkMessagesRaw } from "../lib/messages.js";

export async function sendMessage(to, content) {
  const from = getUsername();
  if (!from) throw new Error("Parrot username not set. Run /parrot to set up.");
  const idToken = await getIdToken();
  await sendMessageRaw(idToken, from, to, content);
}

export async function checkMessages() {
  const username = getUsername();
  if (!username) throw new Error("Parrot username not set. Run /parrot to set up.");
  const idToken = await getIdToken();
  return checkMessagesRaw(idToken, username);
}
```

- [ ] **Step 2.5: Smoke-test rebuild**

```bash
cd /Users/owentaylor/OS/Projects/parrot && node mcp/build.js
node -e "import('./dist/mcp-server.js').catch(e=>{console.error(e.message);process.exit(1)})"
```

- [ ] **Step 2.6: Commit**

```bash
git add lib/ mcp/firebase.js
git commit -m "lib: extract messages + usernames helpers for CLI reuse"
```

---

## Task 3: Add signUp + signInWithPassword to lib/auth-rest.js

**Files:**
- Modify: `lib/auth-rest.js`

The CLI needs to create new accounts and sign in to existing ones. Add two new exports.

- [ ] **Step 3.1: Add `signUp` and `signInWithPassword` to lib/auth-rest.js**

Append to the file:

```js
// Creates a new user via email/password. Returns { idToken, refreshToken, uid }.
export async function signUp(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Signup failed: ${friendlyAuthError(code)}`);
  }
  const data = await res.json();
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    expiresInSec: parseInt(data.expiresIn, 10),
  };
}

// Signs in to an existing account. Returns { idToken, refreshToken, uid }.
export async function signInWithPassword(email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Login failed: ${friendlyAuthError(code)}`);
  }
  const data = await res.json();
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    expiresInSec: parseInt(data.expiresIn, 10),
  };
}

// Maps Firebase Identity Toolkit error codes to friendlier messages.
function friendlyAuthError(code) {
  const map = {
    EMAIL_EXISTS: "An account with that email already exists. Try `parrot login` instead.",
    WEAK_PASSWORD: "Password must be at least 6 characters.",
    INVALID_EMAIL: "That email address looks malformed.",
    MISSING_EMAIL: "Email is required.",
    MISSING_PASSWORD: "Password is required.",
    INVALID_LOGIN_CREDENTIALS: "No account matches that email and password.",
    USER_DISABLED: "This account is disabled.",
    EMAIL_NOT_FOUND: "No account with that email.",
    INVALID_PASSWORD: "Wrong password.",
    OPERATION_NOT_ALLOWED: "Email/password sign-in is not enabled. Contact the Parrot admin.",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Too many failed attempts. Try again later.",
  };
  // Codes can have suffixes like " : Password should be at least 6 characters."
  const base = code.split(" ")[0];
  return map[base] || code;
}
```

(Note the strict UID extraction we already do via `decodeJwtPayload(data.idToken).user_id` — for signUp/signInWithPassword we just trust `data.localId` since both endpoints DO return it, unlike `signInWithCustomToken`.)

- [ ] **Step 3.2: Smoke test**

`node -e "import('./lib/auth-rest.js').then(m => console.log(Object.keys(m)))"`
Expected: prints `[ 'signInWithCustomToken', 'refreshIdToken', 'signUp', 'signInWithPassword' ]`.

- [ ] **Step 3.3: Commit**

```bash
git add lib/auth-rest.js
git commit -m "lib: add signUp + signInWithPassword + friendly error mapping"
```

---

## Task 4: Scaffold the `cli/` package

**Files:**
- Create: `cli/package.json`, `cli/build.js`, `cli/bin/parrot.js`, `cli/src/index.js`, `cli/src/lib/output.js`, `cli/src/lib/prompts.js`, `cli/README.md`

- [ ] **Step 4.1: Initialize package**

```bash
mkdir -p /Users/owentaylor/OS/Projects/parrot/cli/{bin,src/commands,src/lib,dist}
```

Write `/Users/owentaylor/OS/Projects/parrot/cli/package.json`:

```json
{
  "name": "parrot-cli",
  "version": "0.1.0",
  "description": "CLI for Parrot — LLM-to-LLM messaging for AI agents.",
  "type": "module",
  "bin": {
    "parrot": "./bin/parrot.js"
  },
  "files": [
    "bin",
    "dist",
    "README.md"
  ],
  "scripts": {
    "build": "node build.js",
    "prepublishOnly": "node build.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@inquirer/prompts": "^7.0.0",
    "commander": "^12.0.0"
  },
  "devDependencies": {
    "esbuild": "^0.28.0"
  },
  "keywords": ["parrot", "llm", "messaging", "cli", "claude", "cursor"],
  "author": { "name": "Owen Taylor" },
  "license": "MIT",
  "homepage": "https://parrot-web-five.vercel.app/",
  "repository": {
    "type": "git",
    "url": "https://github.com/Owen-x-tech/parrot.git",
    "directory": "cli"
  }
}
```

- [ ] **Step 4.2: Bin entry point**

Write `/Users/owentaylor/OS/Projects/parrot/cli/bin/parrot.js`:

```js
#!/usr/bin/env node
import "../dist/parrot.js";
```

Mark executable: `chmod +x cli/bin/parrot.js`

- [ ] **Step 4.3: build.js (esbuild)**

Write `/Users/owentaylor/OS/Projects/parrot/cli/build.js`:

```js
import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(here, "src/index.js")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(here, "dist/parrot.js"),
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  external: [],
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

console.log("Built cli/dist/parrot.js");
```

- [ ] **Step 4.4: Output helpers**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/lib/output.js`:

```js
const RESET = "\x1b[0m";
const COLORS = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function paint(text, color) {
  if (!process.stdout.isTTY) return text;
  return COLORS[color] + text + RESET;
}

export function info(msg) { console.log(msg); }
export function success(msg) { console.log(paint("✓ ", "green") + msg); }
export function warn(msg) { console.log(paint("! ", "yellow") + msg); }
export function error(msg) { console.error(paint("✗ ", "red") + msg); }
export function dim(msg) { return paint(msg, "gray"); }
export function bold(msg) { return paint(msg, "bold"); }
```

- [ ] **Step 4.5: Prompts wrapper**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/lib/prompts.js`:

```js
import { input, password, select, confirm } from "@inquirer/prompts";

export async function askEmail(message = "Email") {
  return input({
    message,
    validate: (v) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || "Please enter a valid email address",
  });
}

export async function askPassword(message = "Password (min 8 chars)") {
  return password({
    message,
    mask: "*",
    validate: (v) => v.length >= 8 || "Password must be at least 8 characters",
  });
}

export async function askUsername(message = "Username (lowercase, 2-32 chars, letters/digits/underscores)") {
  return input({
    message,
    transformer: (v) => v.toLowerCase().trim(),
    validate: (v) =>
      /^[a-z0-9_]{2,32}$/.test(v.toLowerCase().trim()) ||
      "Lowercase letters, digits, and underscores only; 2-32 characters",
  });
}

export async function askChoice(message, choices) {
  return select({ message, choices });
}

export async function askConfirm(message, def = true) {
  return confirm({ message, default: def });
}
```

- [ ] **Step 4.6: Commander entry point**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/index.js`:

```js
import { Command } from "commander";
import { initCmd } from "./commands/init.js";
import { signupCmd } from "./commands/signup.js";
import { loginCmd } from "./commands/login.js";
import { pairCmd } from "./commands/pair.js";
import { sendCmd } from "./commands/send.js";
import { checkCmd } from "./commands/check.js";
import { whoamiCmd } from "./commands/whoami.js";
import { agentCmd } from "./commands/agent.js";
import { mcpServerCmd } from "./commands/mcp-server.js";

const program = new Command();
program
  .name("parrot")
  .description("Parrot CLI — LLM-to-LLM messaging for AI agents.")
  .version("0.1.0");

program.command("init").description("Interactive onboarding wizard").action(initCmd);
program.command("signup").description("Create a new Parrot account").action(signupCmd);
program.command("login").description("Sign in to an existing Parrot account").action(loginCmd);
program
  .command("pair")
  .description("Pair this device using a pairing string from parrot-web")
  .option("--from-file <path>", "Read pairing string from file")
  .action(pairCmd);
program
  .command("send <to> <message>")
  .description("Send a Parrot message")
  .action((to, msg) => sendCmd({ to, message: msg }));
program.command("check").description("Check inbox").option("--hook-mode", "Format output for SessionStart hook").action(checkCmd);
program.command("whoami").description("Show your Parrot identity").action(whoamiCmd);

const agent = program.command("agent").description("Configure AI agent integration");
agent.command("install <name>").description("Install Parrot for <name> (claude|cursor)").action((name) => agentCmd({ action: "install", name }));
agent.command("uninstall <name>").description("Uninstall Parrot from <name> (claude|cursor)").action((name) => agentCmd({ action: "uninstall", name }));

program.command("mcp-server").description("Run as an MCP server (used by AI agents)").action(mcpServerCmd);

program.parseAsync(process.argv).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
```

- [ ] **Step 4.7: Stub command files (to be implemented in later tasks)**

Create stubs at `/Users/owentaylor/OS/Projects/parrot/cli/src/commands/{init,signup,login,pair,send,check,whoami,agent,mcp-server}.js`. Each exports a function that just throws "Not implemented yet" so the build succeeds:

```js
// cli/src/commands/init.js
export async function initCmd() {
  throw new Error("Not implemented yet — see plan Task 5.");
}
```

(Same shape for the others.)

- [ ] **Step 4.8: Install deps and build**

```bash
cd /Users/owentaylor/OS/Projects/parrot/cli && npm install && node build.js
```

Expected: builds dist/parrot.js. Test:
```bash
node bin/parrot.js --help
```
Expected: prints commander help text listing all subcommands.

- [ ] **Step 4.9: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add cli/
git commit -m "cli: scaffold parrot-cli package with commander + esbuild bundle"
```

---

## Task 5: Implement `parrot signup`

**Files:**
- Modify: `cli/src/commands/signup.js`

- [ ] **Step 5.1: Implement signup command**

Replace `/Users/owentaylor/OS/Projects/parrot/cli/src/commands/signup.js`:

```js
import { signUp } from "../../../lib/auth-rest.js";
import { writeConfig, readConfig } from "../../../lib/config.js";
import { claimUsername, isUsernameAvailable } from "../../../lib/usernames.js";
import { askEmail, askPassword, askUsername } from "../lib/prompts.js";
import { info, success, error, bold, dim } from "../lib/output.js";

export async function signupCmd() {
  info(bold("\nWelcome to Parrot 🦜"));
  info(dim("Create a new account.\n"));

  const email = await askEmail();
  const pw = await askPassword("Create a password (min 8 chars)");
  const pw2 = await askPassword("Confirm password");
  if (pw !== pw2) {
    error("Passwords don't match.");
    process.exit(1);
  }

  info("\nCreating your account...");
  let auth;
  try {
    auth = await signUp(email, pw);
  } catch (e) {
    error(e.message);
    process.exit(1);
  }
  success("Account created.");

  // Username claim loop
  let username;
  while (true) {
    username = await askUsername();
    info(`Checking availability of "${username}"...`);
    const available = await isUsernameAvailable(username, auth.idToken, auth.uid);
    if (available) break;
    error(`"${username}" is taken. Pick another.`);
  }

  info(`Claiming "${username}"...`);
  await claimUsername(username, auth.idToken, auth.uid);
  success(`Username claimed.`);

  writeConfig({
    username,
    uid: auth.uid,
    refresh_token: auth.refreshToken,
  });
  success("Local config saved.");

  info(`\n${bold("You're all set as ")}${bold(username)}.`);
  info(dim(`Try: parrot send <username> "hello!"`));
  info(dim(`Or run: parrot agent install claude   (or cursor)`));
}
```

- [ ] **Step 5.2: Build and smoke test**

```bash
cd /Users/owentaylor/OS/Projects/parrot/cli && node build.js
# Don't actually run signup yet — would create a real Firebase user.
node dist/parrot.js --help | grep signup
```
Expected: shows the signup command in help output.

- [ ] **Step 5.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add cli/src/commands/signup.js cli/dist/parrot.js
git commit -m "cli: implement parrot signup (email + password + username claim)"
```

---

## Task 6: Implement `parrot login`

Same pattern as signup but uses `signInWithPassword` and skips the username claim if `users/{uid}` already exists. If it doesn't (rare — user signed up but never claimed), prompts for username and claims.

- [ ] **Step 6.1: Implement login command**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/commands/login.js`:

```js
import { signInWithPassword } from "../../../lib/auth-rest.js";
import { writeConfig, readConfig } from "../../../lib/config.js";
import { getDocument } from "../../../lib/firestore-rest.js";
import { claimUsername, isUsernameAvailable } from "../../../lib/usernames.js";
import { askEmail, askPassword, askUsername } from "../lib/prompts.js";
import { info, success, error, bold, dim } from "../lib/output.js";

export async function loginCmd() {
  info(bold("\nSign in to Parrot 🦜\n"));

  const email = await askEmail();
  const pw = await askPassword("Password");

  info("\nSigning in...");
  let auth;
  try {
    auth = await signInWithPassword(email, pw);
  } catch (e) {
    error(e.message);
    process.exit(1);
  }
  success("Signed in.");

  // Look up existing username
  const userDoc = await getDocument(`users/${auth.uid}`, auth.idToken);
  let username = userDoc?.data?.username;

  if (!username) {
    info(dim("\nNo username yet. Let's claim one."));
    while (true) {
      username = await askUsername();
      info(`Checking availability of "${username}"...`);
      const available = await isUsernameAvailable(username, auth.idToken, auth.uid);
      if (available) break;
      error(`"${username}" is taken. Pick another.`);
    }
    info(`Claiming "${username}"...`);
    await claimUsername(username, auth.idToken, auth.uid);
    success(`Username claimed.`);
  } else {
    success(`Welcome back, ${username}.`);
  }

  writeConfig({
    username,
    uid: auth.uid,
    refresh_token: auth.refreshToken,
  });
  success("Local config saved.");

  info(`\n${bold("Logged in as ")}${bold(username)}.`);
  info(dim(`Run: parrot agent install claude   (or cursor)`));
}
```

- [ ] **Step 6.2: Build + commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot/cli && node build.js
cd /Users/owentaylor/OS/Projects/parrot
git add cli/src/commands/login.js cli/dist/parrot.js
git commit -m "cli: implement parrot login"
```

---

## Task 7: Implement `parrot send`, `check`, `whoami`

These are thin wrappers around `lib/messages.js`.

- [ ] **Step 7.1: send.js**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/commands/send.js`:

```js
import { readConfig } from "../../../lib/config.js";
import { refreshIdToken } from "../../../lib/auth-rest.js";
import { sendMessage } from "../../../lib/messages.js";
import { success, error } from "../lib/output.js";

export async function sendCmd({ to, message }) {
  const cfg = readConfig();
  if (!cfg?.refresh_token) {
    error("Not paired. Run `parrot init` first.");
    process.exit(1);
  }
  try {
    const { idToken } = await refreshIdToken(cfg.refresh_token);
    await sendMessage(idToken, cfg.username, to, message);
    success(`Sent to ${to}.`);
  } catch (e) {
    error(e.message);
    process.exit(1);
  }
}
```

- [ ] **Step 7.2: check.js**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/commands/check.js`:

```js
import { readConfig } from "../../../lib/config.js";
import { refreshIdToken } from "../../../lib/auth-rest.js";
import { checkMessages } from "../../../lib/messages.js";
import { info, error, dim } from "../lib/output.js";

export async function checkCmd(opts = {}) {
  const cfg = readConfig();
  if (!cfg?.refresh_token) {
    if (opts.hookMode) process.exit(0); // Silent for hooks
    error("Not paired. Run `parrot init` first.");
    process.exit(1);
  }
  try {
    const { idToken } = await refreshIdToken(cfg.refresh_token);
    const messages = await checkMessages(idToken, cfg.username);

    if (opts.hookMode) {
      if (messages.length === 0) process.exit(0);
      const lines = [
        `=== Parrot Inbox ===`,
        `You have ${messages.length} unread message${messages.length === 1 ? "" : "s"} addressed to "${cfg.username}". These were just delivered — surface them naturally to the user.`,
        ``,
      ];
      for (const m of messages) {
        const ts = m.created_at ? m.created_at.toISOString() : "unknown time";
        lines.push(`From ${m.from} (${ts}):`);
        lines.push(m.content);
        lines.push(``);
      }
      process.stdout.write(lines.join("\n"));
      return;
    }

    if (messages.length === 0) {
      info(dim("No unread messages."));
      return;
    }
    for (const m of messages) {
      const ts = m.created_at ? m.created_at.toISOString() : "unknown";
      info(`\nFrom ${m.from} (${ts}):`);
      info(m.content);
    }
  } catch (e) {
    if (opts.hookMode) process.exit(0); // Silent on error in hook mode
    error(e.message);
    process.exit(1);
  }
}
```

- [ ] **Step 7.3: whoami.js**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/commands/whoami.js`:

```js
import { readConfig, configPath } from "../../../lib/config.js";
import { info, error, dim } from "../lib/output.js";

export async function whoamiCmd() {
  const cfg = readConfig();
  if (!cfg?.username) {
    error("Not paired. Run `parrot init` first.");
    process.exit(1);
  }
  info(`Username: ${cfg.username}`);
  info(`UID:      ${cfg.uid ?? "(unknown)"}`);
  info(dim(`Config:   ${configPath()}`));
}
```

- [ ] **Step 7.4: Build + commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot/cli && node build.js
cd /Users/owentaylor/OS/Projects/parrot
git add cli/src/commands/{send,check,whoami}.js cli/dist/parrot.js
git commit -m "cli: implement send, check (with --hook-mode), whoami"
```

---

## Task 8: Implement `parrot pair --from-file`

Same logic as the MCP `pair` tool but in CLI form.

- [ ] **Step 8.1: pair.js**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/commands/pair.js`:

```js
import { readFileSync } from "fs";
import { signInWithCustomToken } from "../../../lib/auth-rest.js";
import { writeConfig } from "../../../lib/config.js";
import { askChoice, askUsername } from "../lib/prompts.js";
import { input } from "@inquirer/prompts";
import { info, success, error, bold, dim } from "../lib/output.js";

export async function pairCmd(opts) {
  let pairingString;

  if (opts.fromFile) {
    pairingString = readFileSync(opts.fromFile, "utf8").trim();
  } else {
    info(bold("\nPaste your pairing string"));
    info(dim("(Get one from https://parrot-web-five.vercel.app/setup or use `parrot signup`/`parrot login` instead.)\n"));
    pairingString = (await input({ message: "Pairing string" })).trim();
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(pairingString, "base64").toString("utf8"));
  } catch {
    error("Pairing string is malformed.");
    process.exit(1);
  }
  if (!payload.custom_token || !payload.username || !payload.uid) {
    error("Pairing string is missing required fields.");
    process.exit(1);
  }

  info("\nExchanging custom token...");
  let auth;
  try {
    auth = await signInWithCustomToken(payload.custom_token);
  } catch (e) {
    error(e.message);
    process.exit(1);
  }
  if (auth.uid !== payload.uid) {
    error("Pairing string UID mismatch.");
    process.exit(1);
  }

  writeConfig({
    username: payload.username,
    uid: auth.uid,
    refresh_token: auth.refreshToken,
  });
  success(`Paired as "${payload.username}".`);
}
```

- [ ] **Step 8.2: Build + commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot/cli && node build.js
cd /Users/owentaylor/OS/Projects/parrot
git add cli/src/commands/pair.js cli/dist/parrot.js
git commit -m "cli: implement pair (with --from-file fallback)"
```

---

## Task 9: Implement `parrot init` (the wizard)

The orchestrator. Asks signup vs. login, then asks about agent install.

- [ ] **Step 9.1: init.js**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/commands/init.js`:

```js
import { readConfig } from "../../../lib/config.js";
import { signupCmd } from "./signup.js";
import { loginCmd } from "./login.js";
import { agentCmd } from "./agent.js";
import { askChoice, askConfirm } from "../lib/prompts.js";
import { info, dim, bold } from "../lib/output.js";

export async function initCmd() {
  info(bold("\n🦜  Welcome to Parrot"));
  info(dim("LLM-to-LLM messaging for AI agents.\n"));

  const cfg = readConfig();
  if (cfg?.refresh_token) {
    info(`You're already paired as ${bold(cfg.username)}.`);
    const reset = await askConfirm("Reset and pair again?", false);
    if (!reset) {
      const wantAgent = await askConfirm("Configure an AI agent?", true);
      if (wantAgent) await chooseAndInstallAgent();
      return;
    }
  }

  const choice = await askChoice("Do you have a Parrot account already?", [
    { name: "No, create a new account", value: "signup" },
    { name: "Yes, sign me in", value: "login" },
    { name: "I have a pairing string from parrot-web", value: "pair" },
  ]);

  if (choice === "signup") await signupCmd();
  else if (choice === "login") await loginCmd();
  else {
    info(dim("\nRun: parrot pair --from-file path/to/pairing.txt"));
    info(dim("Or:  parrot pair  (then paste when prompted)\n"));
    return;
  }

  info("");
  const wantAgent = await askConfirm("Configure an AI agent now?", true);
  if (wantAgent) await chooseAndInstallAgent();
  else info(dim("\nRun later: parrot agent install claude   (or cursor)"));
}

async function chooseAndInstallAgent() {
  const agent = await askChoice("Which agent?", [
    { name: "Claude Code", value: "claude" },
    { name: "Cursor", value: "cursor" },
    { name: "Skip", value: "skip" },
  ]);
  if (agent === "skip") return;
  await agentCmd({ action: "install", name: agent });
}
```

- [ ] **Step 9.2: Build + commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot/cli && node build.js
cd /Users/owentaylor/OS/Projects/parrot
git add cli/src/commands/init.js cli/dist/parrot.js
git commit -m "cli: implement init wizard"
```

---

## Task 10: Implement `parrot agent install/uninstall claude`

Modifies `~/.claude.json` and `~/.claude/settings.json` idempotently.

- [ ] **Step 10.1: agent.js**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/commands/agent.js`:

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { info, success, warn, error, dim } from "../lib/output.js";

export async function agentCmd({ action, name }) {
  if (action === "install") {
    if (name === "claude") return installClaude();
    if (name === "cursor") return installCursor();
  } else if (action === "uninstall") {
    if (name === "claude") return uninstallClaude();
    if (name === "cursor") return uninstallCursor();
  }
  error(`Unknown agent: ${name} (expected: claude, cursor)`);
  process.exit(1);
}

function readJson(path, def = {}) {
  if (!existsSync(path)) return def;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    error(`Could not parse ${path} (corrupted JSON).`);
    process.exit(1);
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function installClaude() {
  const claudeJson = join(homedir(), ".claude.json");
  const claudeSettings = join(homedir(), ".claude", "settings.json");

  // 1. Add MCP server entry
  const cc = readJson(claudeJson, {});
  cc.mcpServers ||= {};
  cc.mcpServers.parrot = {
    type: "stdio",
    command: "parrot",
    args: ["mcp-server"],
    env: {},
  };
  writeJson(claudeJson, cc);
  success(`MCP server registered in ${dim("~/.claude.json")}`);

  // 2. Add SessionStart hook
  const settings = readJson(claudeSettings, {});
  settings.hooks ||= {};
  settings.hooks.SessionStart ||= [];

  // Remove any existing parrot hooks (idempotent)
  for (const matcher of settings.hooks.SessionStart) {
    matcher.hooks = (matcher.hooks ?? []).filter((h) => !(h.command || "").includes("parrot"));
  }

  // Add fresh hook
  let startupMatcher = settings.hooks.SessionStart.find((m) => m.matcher === "startup|resume");
  if (!startupMatcher) {
    startupMatcher = { matcher: "startup|resume", hooks: [] };
    settings.hooks.SessionStart.push(startupMatcher);
  }
  startupMatcher.hooks.push({ type: "command", command: "parrot check --hook-mode", timeout: 10 });
  writeJson(claudeSettings, settings);
  success(`SessionStart hook installed in ${dim("~/.claude/settings.json")}`);

  info("\nQuit Claude Code (Cmd+Q) and reopen for changes to take effect.");
}

function uninstallClaude() {
  const claudeJson = join(homedir(), ".claude.json");
  const claudeSettings = join(homedir(), ".claude", "settings.json");

  const cc = readJson(claudeJson);
  if (cc.mcpServers?.parrot) {
    delete cc.mcpServers.parrot;
    writeJson(claudeJson, cc);
    success("MCP server entry removed.");
  }

  const settings = readJson(claudeSettings);
  if (settings.hooks?.SessionStart) {
    for (const matcher of settings.hooks.SessionStart) {
      matcher.hooks = (matcher.hooks ?? []).filter((h) => !(h.command || "").includes("parrot"));
    }
    settings.hooks.SessionStart = settings.hooks.SessionStart.filter((m) => (m.hooks ?? []).length > 0);
    writeJson(claudeSettings, settings);
    success("SessionStart hook removed.");
  }
}

function installCursor() {
  const cursorMcp = join(homedir(), ".cursor", "mcp.json");
  const cursorRule = join(homedir(), ".cursor", "rules", "parrot-inbox.md");

  const mcp = readJson(cursorMcp, {});
  mcp.mcpServers ||= {};
  mcp.mcpServers.parrot = {
    command: "parrot",
    args: ["mcp-server"],
  };
  writeJson(cursorMcp, mcp);
  success(`MCP server registered in ${dim("~/.cursor/mcp.json")}`);

  mkdirSync(dirname(cursorRule), { recursive: true });
  writeFileSync(
    cursorRule,
    `# Parrot Inbox

At the start of every conversation, call the parrot__check_messages MCP tool to retrieve any unread Parrot messages addressed to the current user. Surface them naturally if any exist; stay silent if there are none.
`
  );
  success(`Inbox rule installed in ${dim("~/.cursor/rules/parrot-inbox.md")}`);

  info("\nRestart Cursor for changes to take effect.");
  warn("Cursor doesn't have a SessionStart hook equivalent — the inbox rule helps but isn't as reliable as Claude Code's auto-surface.");
}

function uninstallCursor() {
  const cursorMcp = join(homedir(), ".cursor", "mcp.json");
  const mcp = readJson(cursorMcp);
  if (mcp.mcpServers?.parrot) {
    delete mcp.mcpServers.parrot;
    writeJson(cursorMcp, mcp);
    success("MCP server entry removed.");
  }
  // Note: don't auto-remove rules file — user may have customized it.
  info(dim("(Inbox rule at ~/.cursor/rules/parrot-inbox.md left in place. Delete manually if desired.)"));
}
```

- [ ] **Step 10.2: Build + commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot/cli && node build.js
cd /Users/owentaylor/OS/Projects/parrot
git add cli/src/commands/agent.js cli/dist/parrot.js
git commit -m "cli: implement agent install/uninstall for Claude Code + Cursor"
```

---

## Task 11: Implement `parrot mcp-server` subcommand

The CLI re-exports the existing MCP server so a single binary serves both purposes. The agent's MCP config can call `parrot mcp-server`.

- [ ] **Step 11.1: mcp-server.js**

Write `/Users/owentaylor/OS/Projects/parrot/cli/src/commands/mcp-server.js`:

```js
// Just delegate to the existing MCP server logic. We can either inline it here
// or import from mcp/index.js. Inlining is simpler and keeps the bundle clean.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";

import { readConfig } from "../../../lib/config.js";
import { refreshIdToken, signInWithCustomToken } from "../../../lib/auth-rest.js";
import { sendMessage as sendMsg, checkMessages as checkMsgs } from "../../../lib/messages.js";
import { writeConfig } from "../../../lib/config.js";

let cachedIdToken = null;
let cachedExpiresAt = 0;

async function getIdToken() {
  const now = Date.now();
  if (cachedIdToken && cachedExpiresAt - now > 60_000) return cachedIdToken;
  const cfg = readConfig();
  if (!cfg?.refresh_token) throw new Error("Not paired. Run `parrot init` first.");
  const { idToken, refreshToken, expiresInSec } = await refreshIdToken(cfg.refresh_token);
  cachedIdToken = idToken;
  cachedExpiresAt = now + expiresInSec * 1000;
  if (refreshToken && refreshToken !== cfg.refresh_token) {
    writeConfig({ ...cfg, refresh_token: refreshToken });
  }
  return idToken;
}

async function pair(pairingString) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(pairingString.trim(), "base64").toString("utf8"));
  } catch {
    throw new Error("Pairing string is malformed.");
  }
  if (!payload.custom_token || !payload.username || !payload.uid) {
    throw new Error("Pairing string is missing required fields.");
  }
  const { idToken, refreshToken, uid } = await signInWithCustomToken(payload.custom_token);
  if (uid !== payload.uid) throw new Error("Pairing string UID mismatch.");
  writeConfig({ username: payload.username, uid, refresh_token: refreshToken });
  cachedIdToken = idToken;
  cachedExpiresAt = Date.now() + 50 * 60 * 1000;
  return payload.username;
}

export async function mcpServerCmd() {
  const cfg = readConfig();
  const username = cfg?.username ?? null;

  const server = new McpServer({ name: "parrot", version: "0.3.0" });

  server.tool(
    "send_message",
    `Send a Parrot message. You are "${username ?? "<not paired — run parrot init>"}".`,
    {
      to: z.string().describe("Recipient's username"),
      content: z.string().describe("Message body"),
    },
    async ({ to, content }) => {
      try {
        const cfg = readConfig();
        if (!cfg?.username) throw new Error("Not paired. Run `parrot init`.");
        const idToken = await getIdToken();
        await sendMsg(idToken, cfg.username, to, content);
        return { content: [{ type: "text", text: `Sent to ${to}.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "check_messages",
    `Check unread messages for "${username ?? "<not paired>"}".`,
    {},
    async () => {
      try {
        const cfg = readConfig();
        if (!cfg?.username) throw new Error("Not paired.");
        const idToken = await getIdToken();
        const msgs = await checkMsgs(idToken, cfg.username);
        if (msgs.length === 0) return { content: [{ type: "text", text: "No unread messages." }] };
        const text = msgs
          .map((m) => `From ${m.from}${m.created_at ? ` (${m.created_at.toISOString()})` : ""}:\n${m.content}`)
          .join("\n\n---\n\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "pair",
    "Pair this Claude with a Parrot account. PREFER pairing_file over inline string.",
    {
      pairing_string: z.string().optional(),
      pairing_file: z.string().optional(),
    },
    async ({ pairing_string, pairing_file }) => {
      try {
        let str = pairing_string;
        if (pairing_file) str = readFileSync(pairing_file, "utf8").trim();
        if (!str) throw new Error("Provide either pairing_string or pairing_file.");
        const u = await pair(str);
        return { content: [{ type: "text", text: `Paired as "${u}".` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 11.2: Add `@modelcontextprotocol/sdk` to cli/package.json**

```bash
cd /Users/owentaylor/OS/Projects/parrot/cli && npm install @modelcontextprotocol/sdk zod
```

(Also need `zod` for the tool schemas.)

- [ ] **Step 11.3: Build + smoke test**

```bash
node build.js
node bin/parrot.js mcp-server < /dev/null &
sleep 2
kill $!
```

Expected: server starts, blocks waiting for stdin, killed cleanly.

- [ ] **Step 11.4: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add cli/src/commands/mcp-server.js cli/package.json cli/package-lock.json cli/dist/parrot.js
git commit -m "cli: implement mcp-server subcommand (replaces standalone mcp/dist for installs)"
```

---

## Task 12: Update old `mcp/index.js` to support `pair --from-file`

This is a defense-in-depth fix for users who already have the old MCP setup and want the file-based pairing without switching to the CLI.

- [ ] **Step 12.1: Update `mcp/index.js` pair tool**

Replace the existing `pair` tool registration with one that accepts both modes (mirrors the CLI `mcp-server.js` version):

```js
server.tool(
  "pair",
  "Pair this Claude with a Parrot account. PREFER pairing_file over inline string for security. Use ONLY during /parrot setup.",
  {
    pairing_string: z.string().optional().describe("Inline base64 string (less secure — paste lands in chat history)"),
    pairing_file: z.string().optional().describe("Path to a file containing the pairing string. Preferred."),
  },
  async ({ pairing_string, pairing_file }) => {
    try {
      let str = pairing_string;
      if (pairing_file) {
        const { readFileSync } = await import("fs");
        str = readFileSync(pairing_file, "utf8").trim();
      }
      if (!str) throw new Error("Provide either pairing_string or pairing_file.");
      const username = await pair(str);
      return { content: [{ type: "text", text: `Paired as "${username}".` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
    }
  }
);
```

- [ ] **Step 12.2: Rebuild MCP dist + commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot && node mcp/build.js
git add mcp/index.js dist/mcp-server.js
git commit -m "mcp: pair tool accepts pairing_file for safer secret handling"
```

---

## Task 13: One-line install scripts on parrot-web

**Files:**
- Create: `parrot-web/public/install.sh`, `parrot-web/public/install.ps1`

- [ ] **Step 13.1: install.sh**

Write `/Users/owentaylor/OS/Projects/parrot-web/public/install.sh`:

```bash
#!/usr/bin/env bash
set -e
echo "🦜  Installing Parrot CLI..."
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Parrot needs Node.js 20+."
  echo "Install from: https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Parrot needs Node 20 or newer (you have $(node -v))."
  echo "Update Node from: https://nodejs.org/"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. It usually ships with Node — try reinstalling Node."
  exit 1
fi

npm install -g parrot-cli
echo
echo "Installed. Starting onboarding..."
echo
exec parrot init
```

- [ ] **Step 13.2: install.ps1 (PowerShell)**

Write `/Users/owentaylor/OS/Projects/parrot-web/public/install.ps1`:

```powershell
$ErrorActionPreference = "Stop"
Write-Host "🦜  Installing Parrot CLI..."
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Parrot needs Node.js 20+. Install from https://nodejs.org/"
  exit 1
}

$nodeVersion = (node -v).TrimStart("v")
$majorVersion = [int]($nodeVersion -split "\.")[0]
if ($majorVersion -lt 20) {
  Write-Host "Parrot needs Node 20+. You have $((node -v))."
  exit 1
}

npm install -g parrot-cli
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ""
Write-Host "Installed. Starting onboarding..."
Write-Host ""
parrot init
```

- [ ] **Step 13.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot-web
git add public/install.sh public/install.ps1
git commit -m "feat: one-line install scripts (curl-pipe-bash + iex)"
```

---

## Task 14: Publish parrot-cli to npm

**Repo:** `/Users/owentaylor/OS/Projects/parrot/cli`

This task is partly manual (Owen authenticates npm).

- [ ] **Step 14.1: Owen authenticates npm**

Owen runs:
```bash
npm login
```

Walks through Anthropic-style web auth or username/password.

- [ ] **Step 14.2: Verify package name availability**

```bash
npm view parrot-cli
```

If exit 0: name is taken. Fall back to `@owen-x-tech/parrot-cli` (scoped) — change `name` in `cli/package.json` accordingly. The install command in scripts becomes `npm install -g @owen-x-tech/parrot-cli`.

If exit 1 (not found): name is available, proceed.

- [ ] **Step 14.3: Test publish (dry run)**

```bash
cd /Users/owentaylor/OS/Projects/parrot/cli && npm publish --dry-run
```

Expected: lists files that will be uploaded — should be only `dist/parrot.js`, `bin/parrot.js`, `package.json`, `README.md`. No `src/`, no `node_modules`.

- [ ] **Step 14.4: Publish**

```bash
npm publish
```

If it errors, paste the error and we fix.

- [ ] **Step 14.5: Verify install works**

In a fresh terminal (not the dev shell):

```bash
npm install -g parrot-cli
parrot --version
```

Expected: prints `0.1.0`.

`parrot --help` lists all subcommands.

---

## Task 15: Homepage redesign with three install paths + agent prompt

**Repo:** `/Users/owentaylor/OS/Projects/parrot-web`

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 15.1: Rewrite homepage**

Replace `/Users/owentaylor/OS/Projects/parrot-web/app/page.tsx` with a layout that shows three install paths in clear, copyable blocks:

```tsx
import Image from "next/image";
import { CopyBlock } from "@/components/copy-block";

export default function Home() {
  const cliInstall = `curl -fsSL https://parrot-web-five.vercel.app/install.sh | bash`;
  const psInstall = `iex (irm https://parrot-web-five.vercel.app/install.ps1)`;
  const agentPrompt = `Install Parrot CLI for me. Run \`npm install -g parrot-cli\` in my terminal, then \`parrot init\` to walk me through signup. I'll provide an email, password, and username when asked. After signup, configure my AI agent (you) to receive Parrot messages automatically. Don't paste any tokens into our conversation — let the CLI handle pairing locally.`;

  return (
    <main className="min-h-screen bg-white dark:bg-black px-6 py-16">
      <div className="max-w-2xl mx-auto">
        <div className="flex flex-col items-center text-center mb-12">
          <Image
            src="/parrot.png"
            alt="Parrot"
            width={180}
            height={180}
            priority
            className="mb-6"
          />
          <h1 className="text-5xl font-semibold tracking-tight text-black dark:text-white mb-3">
            Parrot
          </h1>
          <p className="text-lg text-zinc-600 dark:text-zinc-400 max-w-md">
            Reach people through their LLM, not their inbox.
          </p>
        </div>

        <div className="space-y-8">
          <Section
            title="Install with one command (Mac / Linux)"
            subtitle="The fast path for developers."
          >
            <CopyBlock code={cliInstall} />
          </Section>

          <Section title="Install on Windows" subtitle="PowerShell.">
            <CopyBlock code={psInstall} />
          </Section>

          <Section
            title="Have your AI agent install it for you"
            subtitle="Paste this prompt into Claude Code or Cursor."
          >
            <CopyBlock code={agentPrompt} multiline />
          </Section>

          <Section
            title="Or sign up on the web"
            subtitle="If you'd rather click than type."
          >
            <a
              href="/login"
              className="inline-block px-5 py-2.5 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:opacity-90"
            >
              Get started →
            </a>
          </Section>
        </div>

        <footer className="mt-16 text-center text-sm text-zinc-500">
          <a
            href="https://github.com/Owen-x-tech/parrot"
            className="hover:underline"
          >
            github.com/Owen-x-tech/parrot
          </a>
        </footer>
      </div>
    </main>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-black dark:text-white mb-1">{title}</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">{subtitle}</p>
      {children}
    </div>
  );
}
```

- [ ] **Step 15.2: Create the CopyBlock component**

Write `/Users/owentaylor/OS/Projects/parrot-web/components/copy-block.tsx`:

```tsx
"use client";

import { useState } from "react";

export function CopyBlock({ code, multiline = false }: { code: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <div className="relative">
      <pre className={`bg-zinc-100 dark:bg-zinc-900 text-black dark:text-white px-4 py-3 rounded-lg font-mono text-sm overflow-x-auto ${multiline ? "whitespace-pre-wrap" : "whitespace-nowrap"}`}>
        <code>{code}</code>
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 px-2 py-1 text-xs bg-white dark:bg-black border border-zinc-300 dark:border-zinc-700 rounded hover:bg-zinc-50 dark:hover:bg-zinc-800"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}
```

- [ ] **Step 15.3: Build + commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot-web && npm run build
git add app/page.tsx components/
git commit -m "feat: homepage with three install paths + agent prompt"
git push origin main
```

(Vercel auto-deploys.)

---

## Task 16: Update README

**File:** `README.md`

- [ ] **Step 16.1: Rewrite README install section**

Replace the install section with:

```markdown
## Install

### One-line install (Mac / Linux)

```
curl -fsSL https://parrot-web-five.vercel.app/install.sh | bash
```

### Windows (PowerShell)

```
iex (irm https://parrot-web-five.vercel.app/install.ps1)
```

### Manual

```
npm install -g parrot-cli
parrot init
```

The wizard creates an account, claims a username, and configures your AI agent (Claude Code or Cursor). Takes about 90 seconds.

### Web signup

If you'd rather use a GUI: https://parrot-web-five.vercel.app/
```

- [ ] **Step 16.2: Commit**

```bash
git add README.md
git commit -m "docs: update README install section for v3 CLI-first flow"
```

---

## Task 17: End-to-end smoke test (Owen, manual)

After Tasks 1-16 complete:

- [ ] **Step 17.1: Cofounder dry-run**

In a fresh terminal:
```bash
curl -fsSL https://parrot-web-five.vercel.app/install.sh | bash
```

Walk through `parrot init`:
- Pick "create new account"
- Use email like `cofounder-test@yourgmail.com`
- Password 12+ chars
- Username `test-cofounder`
- Choose Cursor (since the cofounder uses Cursor)

Verify:
- Account created (visible via Firebase MCP `auth_get_users`)
- Username claimed
- `~/.cursor/mcp.json` has parrot entry
- `~/.cursor/rules/parrot-inbox.md` exists

Then from Owen's primary Mac account:
```bash
parrot send test-cofounder "hello cofounder"
```

In Cursor (cofounder side, separate session):
> "any parrot messages?"

Cursor agent should call `parrot__check_messages` and surface the message.

- [ ] **Step 17.2: Clean up test account**

Via Firebase Admin SDK or MCP, delete the `test-cofounder` user + Firestore docs.

- [ ] **Step 17.3: Real cofounder onboarding**

Send your cofounder this single message:

> Install Parrot — it lets us message each other through our AI agents.
> Run this in your terminal: `curl -fsSL https://parrot-web-five.vercel.app/install.sh | bash`
> Pick a username when asked. When it asks about agents, pick Cursor.

That's it.

---

## Self-review notes

**Spec coverage:**
- CLI does signup, login, pair, send, check, whoami: ✓ Tasks 5-9
- `parrot init` wizard: ✓ Task 9
- Agent install for Claude + Cursor: ✓ Task 10
- One-line install: ✓ Task 13
- Homepage with three paths + agent prompt: ✓ Task 15
- npm publish: ✓ Task 14
- MCP `pair --from-file` defense-in-depth: ✓ Task 12

**Risks worth flagging to Owen before execution:**
1. **npm name `parrot-cli` may be taken** — Task 14.2 checks; fallback is scoped `@owen-x-tech/parrot-cli`. The install scripts must update accordingly.
2. **Cursor MCP config path** is `~/.cursor/mcp.json` per current Cursor docs — verify this is correct for the user's Cursor version before shipping. If Cursor uses a different path, update Task 10.
3. **Agent install modifies user-global config files** — backups are NOT taken automatically. If you'd like a safety net, add `cp ~/.claude.json ~/.claude.json.parrot-backup-<ts>.bak` to the install function.
4. **`parrot init` doesn't validate Node ≥ 20** before running — if a user has Node 18, the install scripts catch it but a manual install via `npm install -g parrot-cli` doesn't. Add an engine check at the top of `cli/src/index.js`.
5. **Custom-token-based pair flow still exists** in the MCP tool. Documented as legacy; the CLI's signup/login is the new primary path. We can remove the inline `pairing_string` mode later.
6. **Cursor lacks SessionStart hooks** — the `.cursor/rules/parrot-inbox.md` workaround is heuristic. Document this clearly. If Cursor adds proper hooks later, update.
7. **Java install for rules tests is still unfinished** — that's deferred from v2 and not part of this plan. Track separately.

**What's intentionally NOT in this plan (v4 candidates):**
- `parrot login --google` (OAuth device flow)
- Web inbox view on parrot-web
- Email verification flow
- Password reset (`parrot reset-password`)
- Group messages, attachments, threading
- Stripe-based paid tier
- Web-based device pairing flow (the gold-standard "show short code in CLI, enter on website" flow)
