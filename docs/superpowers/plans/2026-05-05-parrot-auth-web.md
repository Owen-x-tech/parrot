# Parrot Auth via parrot-web (web accounts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **NOTE:** This plan supersedes `2026-05-05-parrot-auth.md` (synthetic-creds approach). It uses the existing `parrot-web` Next.js project at `~/OS/Projects/parrot-web` (deployed to https://parrot-web-five.vercel.app/) as the account front door. **Tasks 1-4 (rules tests + locked rules) are identical between the two plans** — if any of them have already shipped, skip them here.

**Goal:** Add Firebase Auth (email/password + Google) on `parrot-web`, lock down Firestore rules, and have the Claude Code plugin authenticate via a one-time pairing string copied from the website. Architecture is pre-wired for a future paid tier (no payments yet).

**Architecture:** Users sign up on `parrot-web` (Firebase Auth web client, email/password OR Google). On `/setup` they claim a permanent username (Firestore client write — passes locked rules because they're authed). They click "Generate plugin token", which calls a Next.js Route Handler (`/api/mint-token`) that uses the Firebase Admin SDK to mint a short-lived custom token for that UID. The page displays a base64-encoded pairing string `{ custom_token, username, uid }`. The user pastes this into Claude (`/parrot` skill → `pair` MCP tool). The plugin exchanges the custom token for a long-lived refresh token via the Firebase Identity Toolkit REST API, saves `{ username, uid, refresh_token }` to `~/.config/parrot/config.json` (mode 0600), and from then on uses REST-only access (`securetoken.googleapis.com` for token refresh, `firestore.googleapis.com` for data ops). The plugin drops its `firebase` npm dependency entirely — the bundled MCP server becomes much smaller.

**Tech Stack:**
- **parrot-web** (Next.js 16.2.4 App Router, React 19, Tailwind 4, TypeScript): `firebase` Web SDK (client) + `firebase-admin` (server, for token minting). Deployed on Vercel.
- **parrot** (Node 20 plugin): zero Firebase deps at runtime; Node's built-in `fetch` + Firebase REST APIs.
- **Tests** (parrot repo): `@firebase/rules-unit-testing` + Firebase Emulator + `node --test`.

> **Important:** parrot-web uses Next.js 16 — **not** the version in your training data. Before writing any Next code, read the relevant guide in `~/OS/Projects/parrot-web/node_modules/next/dist/docs/01-app/`. App Router conventions only.

---

## File Structure

### parrot (plugin repo) — `~/OS/Projects/parrot`

**Created:**
- `package.json` (repo root) — dev-only deps for rules tests
- `mcp/config.js` — config schema, atomic 0600 read/write
- `mcp/auth-rest.js` — Firebase Auth REST client (custom-token exchange + refresh)
- `mcp/firestore-rest.js` — Firestore REST client (createDocument, runQuery, patch)
- `tests/rules.test.js`, `tests/helpers.js` — rules unit tests

**Modified:**
- `firestore.rules` — full rewrite (auth-required, sender-bound, recipient-only)
- `mcp/firebase.js` — orchestrator using REST modules; exports `pair`, `sendMessage`, `checkMessages`, `getUsername`, `ensureFreshIdToken`
- `mcp/package.json` — REMOVE `firebase` dep (no longer needed at runtime)
- `mcp/index.js` — replace `claim_username` with `pair`; same `send_message` / `check_messages`
- `hook/check-inbox.js` — same flow, uses new firebase.js
- `skills/parrot/SKILL.md` — direct user to website for signup + paste pairing string
- `commands/parrot.md` — minor wording
- `README.md` — v2 documentation
- `firebase.json` — emulator block

**Untouched:** `mcp/build.js`, `hooks/hooks.json`, `.mcp.json`, `.claude-plugin/*`, `assets/parrot.png`.

### parrot-web — `~/OS/Projects/parrot-web`

**Created:**
- `lib/firebase-client.ts` — initializeApp + getAuth + getFirestore (client)
- `lib/firebase-admin.ts` — Admin SDK init from service-account JSON env var (server only)
- `lib/auth-context.tsx` — React context provider for current Firebase user
- `app/login/page.tsx` — email/password + Google sign-in (client component)
- `app/setup/page.tsx` — username claim + pairing token generator (client component)
- `app/api/mint-token/route.ts` — Route Handler that mints a custom token for the authenticated user
- `.env.local` — Firebase web config + Admin SDK service account (gitignored)
- `.env.example` — committed template

**Modified:**
- `package.json` — add `firebase`, `firebase-admin`
- `app/layout.tsx` — wrap children in `AuthProvider`
- `app/page.tsx` — add "Get started" CTA linking to `/login`
- `.gitignore` — ensure `.env.local` is ignored (Next.js default already covers it; verify)

---

## Architecture Notes

### Pairing string format

Base64-encoded UTF-8 JSON:

```
eyJjdXN0b21fdG9rZW4iOiJleUphYi4uLiIsInVzZXJuYW1lIjoib3dlbiIsInVpZCI6ImFiYzEyMyJ9
```

Decoded:

```json
{
  "custom_token": "<long Firebase JWT>",
  "username": "owen",
  "uid": "abc123..."
}
```

Plugin decodes via `Buffer.from(s, 'base64').toString('utf8')` then `JSON.parse`.

Custom tokens expire in 1 hour — the user must paste within that window. The page can offer "regenerate" if they wait too long.

### Token lifecycle on the plugin side

1. **Pair (once)**: POST custom_token to `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=<API_KEY>` → returns `{ idToken, refreshToken, localId, expiresIn }`. Save `refreshToken` + `localId` (== uid) + username to config.

2. **Refresh ID token (each cold start, or every 50 min)**: POST `grant_type=refresh_token&refresh_token=<saved>` to `https://securetoken.googleapis.com/v1/token?key=<API_KEY>` → returns fresh `id_token` (1 hour TTL). Cache in memory.

3. **Firestore op**: include `Authorization: Bearer <id_token>` on every request.

### Firestore REST quirks

- Field types are explicit: `{"stringValue": "x"}`, `{"booleanValue": false}`, `{"timestampValue": "2026-05-05T..."}`.
- `created_at`: we'll use **client-side timestamps** (`new Date().toISOString()`) instead of `serverTimestamp()`. This is slightly less authoritative but avoids the `commit` endpoint complexity. Acceptable for a messaging app.
- Queries use `:runQuery` with a `structuredQuery` body. Results come back as a stream of `{document: ...}` JSON objects — paginated only if huge.

### Future payments hook-in

Single change in `firestore.rules` on the message-create rule:

```diff
  allow create: if request.auth != null
+               && request.auth.token.paid == true
                && ...
```

Plus a Stripe webhook (Vercel Route Handler at `/api/stripe/webhook`) that calls `admin.auth().setCustomUserClaims(uid, { paid: true })`. Out of scope here.

### Migration

- Existing v1 messages get wiped (`firebase firestore:delete --recursive /messages`).
- Owen's existing local config is incompatible (no `refresh_token`) — he re-pairs from the website.

---

## Task 1: Add test infrastructure to parrot

**Repo:** `~/OS/Projects/parrot`

**Files:**
- Create: `package.json`, `tests/helpers.js`
- Modify: `firebase.json`

- [ ] **Step 1.1: Create root package.json**

Write `/Users/owentaylor/OS/Projects/parrot/package.json`:

```json
{
  "name": "parrot",
  "private": true,
  "type": "module",
  "scripts": {
    "test:rules": "firebase --project=parrot-rules-test emulators:exec --only firestore 'node --test tests/rules.test.js'"
  },
  "devDependencies": {
    "@firebase/rules-unit-testing": "^4.0.1",
    "firebase": "^11.0.0"
  }
}
```

- [ ] **Step 1.2: Install dev deps**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm install`
Expected: creates root `node_modules/` and `package-lock.json`. No errors.

- [ ] **Step 1.3: Create tests/helpers.js**

```bash
mkdir -p /Users/owentaylor/OS/Projects/parrot/tests
```

Write `/Users/owentaylor/OS/Projects/parrot/tests/helpers.js`:

```js
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const rulesPath = join(here, "..", "firestore.rules");

export async function makeTestEnv() {
  return await initializeTestEnvironment({
    projectId: "parrot-rules-test",
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      rules: readFileSync(rulesPath, "utf8"),
    },
  });
}

export function authedDb(env, uid) {
  return env.authenticatedContext(uid).firestore();
}

export function unauthedDb(env) {
  return env.unauthenticatedContext().firestore();
}

// Seeds usernames/{name} and users/{uid} bypassing rules.
export async function seedUser(env, uid, username) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `usernames/${username}`), { uid });
    await setDoc(doc(ctx.firestore(), `users/${uid}`), { username });
  });
}
```

- [ ] **Step 1.4: Add emulator block to firebase.json**

Replace `/Users/owentaylor/OS/Projects/parrot/firebase.json`:

```json
{
  "firestore": {
    "database": "(default)",
    "location": "us-central1",
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "emulators": {
    "firestore": {
      "port": 8080
    },
    "ui": {
      "enabled": false
    },
    "singleProjectMode": true
  }
}
```

- [ ] **Step 1.5: Verify emulator boots**

Run: `cd /Users/owentaylor/OS/Projects/parrot && firebase --project=parrot-rules-test emulators:exec --only firestore 'echo emulator ready'`
Expected: prints `emulator ready` and exits 0.

- [ ] **Step 1.6: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add package.json package-lock.json tests/helpers.js firebase.json
git commit -m "tests: scaffold Firestore rules test infra"
```

---

## Task 2: Rules tests for `usernames` (TDD)

**Repo:** `~/OS/Projects/parrot`

**Files:**
- Create: `tests/rules.test.js`
- Modify: `firestore.rules`

- [ ] **Step 2.1: Write failing tests for `usernames`**

Write `/Users/owentaylor/OS/Projects/parrot/tests/rules.test.js`:

```js
import { test, before, after } from "node:test";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, deleteDoc, updateDoc, addDoc, collection, getDocs, query, where } from "firebase/firestore";
import { makeTestEnv, authedDb, unauthedDb, seedUser } from "./helpers.js";

let env;

before(async () => { env = await makeTestEnv(); });
after(async () => { if (env) await env.cleanup(); });

test("usernames: unauthed cannot claim", async () => {
  const db = unauthedDb(env);
  await assertFails(setDoc(doc(db, "usernames/owen"), { uid: "anyone" }));
});

test("usernames: authed user can claim free username with own uid", async () => {
  await env.clearFirestore();
  const db = authedDb(env, "uid-A");
  await assertSucceeds(setDoc(doc(db, "usernames/owen"), { uid: "uid-A" }));
});

test("usernames: cannot claim with someone else's uid", async () => {
  await env.clearFirestore();
  const db = authedDb(env, "uid-A");
  await assertFails(setDoc(doc(db, "usernames/owen"), { uid: "uid-B" }));
});

test("usernames: cannot overwrite existing claim", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "usernames/owen"), { uid: "uid-A" });
  });
  const db = authedDb(env, "uid-B");
  await assertFails(setDoc(doc(db, "usernames/owen"), { uid: "uid-B" }));
});

test("usernames: anyone authed can read availability", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "usernames/owen"), { uid: "uid-A" });
  });
  const db = authedDb(env, "uid-B");
  await assertSucceeds(getDoc(doc(db, "usernames/owen")));
});

test("usernames: cannot delete or update", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "usernames/owen"), { uid: "uid-A" });
  });
  const db = authedDb(env, "uid-A");
  await assertFails(deleteDoc(doc(db, "usernames/owen")));
  await assertFails(updateDoc(doc(db, "usernames/owen"), { uid: "uid-A2" }));
});
```

- [ ] **Step 2.2: Run tests, verify they fail**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: every `usernames:` write test FAILs (current rules deny `usernames/*` because the path isn't matched — default deny). Reads against the seeded data may still pass because `withSecurityRulesDisabled` bypasses rules for the seed itself; the `getDoc` in the read test will fail since the rule denies it.

- [ ] **Step 2.3: Update firestore.rules**

Replace `/Users/owentaylor/OS/Projects/parrot/firestore.rules`:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /usernames/{username} {
      allow read: if request.auth != null;
      allow create: if request.auth != null
                    && request.resource.data.keys().hasOnly(['uid'])
                    && request.resource.data.uid == request.auth.uid;
      allow update, delete: if false;
    }

    // messages + users rules added in subsequent tasks; deny by default.
    match /messages/{messageId} { allow read, write: if false; }
    match /users/{userId} { allow read, write: if false; }
  }
}
```

- [ ] **Step 2.4: Run tests, verify pass**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: all `usernames:` tests PASS.

- [ ] **Step 2.5: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add firestore.rules tests/rules.test.js
git commit -m "rules: lock usernames collection (immutable, first-come-first-served)"
```

---

## Task 3: Rules tests for `users` (TDD)

**Repo:** `~/OS/Projects/parrot`

- [ ] **Step 3.1: Append users tests**

Append to `/Users/owentaylor/OS/Projects/parrot/tests/rules.test.js`:

```js

test("users: unauthed cannot read or write", async () => {
  await env.clearFirestore();
  const db = unauthedDb(env);
  await assertFails(setDoc(doc(db, "users/uid-A"), { username: "owen" }));
  await assertFails(getDoc(doc(db, "users/uid-A")));
});

test("users: cannot create doc with different uid path", async () => {
  await env.clearFirestore();
  const db = authedDb(env, "uid-A");
  await assertFails(setDoc(doc(db, "users/uid-B"), { username: "owen" }));
});

test("users: cannot create user doc without matching usernames claim", async () => {
  await env.clearFirestore();
  const db = authedDb(env, "uid-A");
  await assertFails(setDoc(doc(db, "users/uid-A"), { username: "owen" }));
});

test("users: succeeds when paired with valid usernames claim", async () => {
  await env.clearFirestore();
  const db = authedDb(env, "uid-A");
  await assertSucceeds(setDoc(doc(db, "usernames/owen"), { uid: "uid-A" }));
  await assertSucceeds(setDoc(doc(db, "users/uid-A"), { username: "owen" }));
});

test("users: cannot read someone else's user doc", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  const db = authedDb(env, "uid-B");
  await assertFails(getDoc(doc(db, "users/uid-A")));
});

test("users: can read own user doc", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  const db = authedDb(env, "uid-A");
  await assertSucceeds(getDoc(doc(db, "users/uid-A")));
});

test("users: cannot update or delete after creation", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  const db = authedDb(env, "uid-A");
  await assertFails(updateDoc(doc(db, "users/uid-A"), { username: "newname" }));
  await assertFails(deleteDoc(doc(db, "users/uid-A")));
});
```

- [ ] **Step 3.2: Run tests, verify users tests fail**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: usernames tests still pass; new `users:` tests fail (current rule is `allow read, write: if false`).

- [ ] **Step 3.3: Add users rules**

Edit `/Users/owentaylor/OS/Projects/parrot/firestore.rules`. Replace the placeholder `match /users/{userId} { allow read, write: if false; }` with:

```
    match /users/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow create: if request.auth != null
                    && request.auth.uid == userId
                    && request.resource.data.keys().hasOnly(['username'])
                    && exists(/databases/$(database)/documents/usernames/$(request.resource.data.username))
                    && get(/databases/$(database)/documents/usernames/$(request.resource.data.username)).data.uid == request.auth.uid;
      allow update, delete: if false;
    }
```

- [ ] **Step 3.4: Run tests, verify all pass**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: all usernames + users tests PASS.

- [ ] **Step 3.5: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add firestore.rules tests/rules.test.js
git commit -m "rules: lock users collection (read-self, paired-with-claim create)"
```

---

## Task 4: Rules tests for `messages` (TDD)

**Repo:** `~/OS/Projects/parrot`

- [ ] **Step 4.1: Append message tests**

Append to `/Users/owentaylor/OS/Projects/parrot/tests/rules.test.js`. Note: we use **client-side timestamps** (ISO strings as Date objects) since the plugin won't use serverTimestamp() in REST calls. The rules don't care about the type of `created_at` beyond field presence.

Add this import line near the top imports (alongside the existing firestore import):

```js
import { serverTimestamp } from "firebase/firestore";
```

(We use `serverTimestamp()` in tests because they go through the SDK; the plugin will use ISO strings via REST. The rule treats both as timestamp values.)

Then append tests:

```js

test("messages: unauthed cannot create", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  const db = unauthedDb(env);
  await assertFails(addDoc(collection(db, "messages"), {
    from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
  }));
});

test("messages: authed user can send from their bound username", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  const db = authedDb(env, "uid-A");
  await assertSucceeds(addDoc(collection(db, "messages"), {
    from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
  }));
});

test("messages: cannot impersonate", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  const db = authedDb(env, "uid-A");
  await assertFails(addDoc(collection(db, "messages"), {
    from: "laila", to: "owen", content: "fake", read: false, created_at: serverTimestamp(),
  }));
});

test("messages: cannot send to nonexistent recipient", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  const db = authedDb(env, "uid-A");
  await assertFails(addDoc(collection(db, "messages"), {
    from: "owen", to: "ghost", content: "hi", read: false, created_at: serverTimestamp(),
  }));
});

test("messages: must be created with read=false", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  const db = authedDb(env, "uid-A");
  await assertFails(addDoc(collection(db, "messages"), {
    from: "owen", to: "laila", content: "hi", read: true, created_at: serverTimestamp(),
  }));
});

test("messages: recipient can list", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  await env.withSecurityRulesDisabled(async (ctx) => {
    await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
  });
  const db = authedDb(env, "uid-B");
  await assertSucceeds(getDocs(query(collection(db, "messages"), where("to", "==", "laila"), where("read", "==", false))));
});

test("messages: non-recipient cannot list someone else's messages", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  await seedUser(env, "uid-C", "mallory");
  await env.withSecurityRulesDisabled(async (ctx) => {
    await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
  });
  const db = authedDb(env, "uid-C");
  await assertFails(getDocs(query(collection(db, "messages"), where("to", "==", "laila"), where("read", "==", false))));
});

test("messages: recipient can mark read", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  let id;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const ref = await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
    id = ref.id;
  });
  const db = authedDb(env, "uid-B");
  await assertSucceeds(updateDoc(doc(db, "messages", id), { read: true }));
});

test("messages: non-recipient cannot mark read", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  let id;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const ref = await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
    id = ref.id;
  });
  const db = authedDb(env, "uid-A");
  await assertFails(updateDoc(doc(db, "messages", id), { read: true }));
});

test("messages: cannot edit content", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  let id;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const ref = await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
    id = ref.id;
  });
  const db = authedDb(env, "uid-B");
  await assertFails(updateDoc(doc(db, "messages", id), { content: "tampered", read: true }));
});

test("messages: cannot delete", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  let id;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const ref = await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
    id = ref.id;
  });
  const db = authedDb(env, "uid-B");
  await assertFails(deleteDoc(doc(db, "messages", id)));
});
```

- [ ] **Step 4.2: Run tests, verify message tests fail**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: usernames + users pass; messages tests fail.

- [ ] **Step 4.3: Add messages rules**

Replace the placeholder `match /messages/{messageId} { allow read, write: if false; }` in `/Users/owentaylor/OS/Projects/parrot/firestore.rules` with:

```
    match /messages/{messageId} {
      function senderUsername() {
        return get(/databases/$(database)/documents/users/$(request.auth.uid)).data.username;
      }
      function recipientExists(name) {
        return exists(/databases/$(database)/documents/usernames/$(name));
      }

      allow create: if request.auth != null
                    && request.resource.data.keys().hasOnly(['from', 'to', 'content', 'read', 'created_at'])
                    && request.resource.data.from is string
                    && request.resource.data.to is string
                    && request.resource.data.content is string
                    && request.resource.data.read == false
                    && request.resource.data.from == senderUsername()
                    && recipientExists(request.resource.data.to);

      allow read: if request.auth != null
                  && resource.data.to == get(/databases/$(database)/documents/users/$(request.auth.uid)).data.username;

      allow update: if request.auth != null
                    && resource.data.to == get(/databases/$(database)/documents/users/$(request.auth.uid)).data.username
                    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['read'])
                    && request.resource.data.read == true;

      allow delete: if false;
    }
```

- [ ] **Step 4.4: Run tests, verify all pass**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: ALL tests PASS.

- [ ] **Step 4.5: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add firestore.rules tests/rules.test.js
git commit -m "rules: lock messages (sender-bound from, recipient-only read, immutable content)"
```

---

## Task 5: Configure Firebase project (manual, by Owen)

**Repo:** none — done via Firebase console & local file.

This task can ONLY be done by Owen interactively. The agent should print the steps and pause.

- [ ] **Step 5.1: Enable email/password and Google providers**

Open https://console.firebase.google.com/project/parrot-ai-9b46e/authentication/providers

Enable:
- **Email/Password** — toggle on, save.
- **Google** — toggle on. Project public-facing name: "Parrot". Project support email: Owen's email. Save.

- [ ] **Step 5.2: Add Vercel domain to authorized domains**

Same console → Authentication → Settings → Authorized domains. Add:
- `parrot-web-five.vercel.app`
- `localhost` (already there by default — verify)

- [ ] **Step 5.3: Generate a service account JSON for the Admin SDK**

Open https://console.firebase.google.com/project/parrot-ai-9b46e/settings/serviceaccounts/adminsdk

Click **Generate new private key** → downloads a JSON file.

Save it locally at `~/Downloads/parrot-admin-key.json` (DO NOT commit this file). It will be loaded into Vercel as an env var in Task 11.

- [ ] **Step 5.4: Note the Firebase web SDK config**

It's already in the plugin code:

```js
{
  apiKey: "AIzaSyDfwsLRb8gPaWdxCXikZjJrM34N5426qrE",
  authDomain: "parrot-ai-9b46e.firebaseapp.com",
  projectId: "parrot-ai-9b46e",
  storageBucket: "parrot-ai-9b46e.firebasestorage.app",
  messagingSenderId: "311043780015",
  appId: "1:311043780015:web:d57792e91584bdf23d135a",
}
```

These values will be used in `parrot-web/.env.local` as `NEXT_PUBLIC_FIREBASE_*`. They're public — fine to commit (`.env.example`) but `.env.local` should remain gitignored (Next.js default).

- [ ] **Step 5.5: Confirm**

Owen confirms providers are enabled and the service account JSON is saved locally before proceeding.

---

## Task 6: parrot-web — Firebase client library

**Repo:** `~/OS/Projects/parrot-web`

**Files:**
- Create: `lib/firebase-client.ts`, `lib/firebase-admin.ts`, `lib/auth-context.tsx`
- Create: `.env.local`, `.env.example`
- Modify: `package.json`, `app/layout.tsx`

- [ ] **Step 6.1: Add Firebase deps**

Run: `cd /Users/owentaylor/OS/Projects/parrot-web && npm install firebase firebase-admin`
Expected: installs both, no errors. Lockfile updates.

- [ ] **Step 6.2: Create .env.local and .env.example**

Write `/Users/owentaylor/OS/Projects/parrot-web/.env.local`:

```
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSyDfwsLRb8gPaWdxCXikZjJrM34N5426qrE
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=parrot-ai-9b46e.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=parrot-ai-9b46e
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=parrot-ai-9b46e.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=311043780015
NEXT_PUBLIC_FIREBASE_APP_ID=1:311043780015:web:d57792e91584bdf23d135a

# Service account JSON (single line, no newlines). Set this to the entire
# contents of ~/Downloads/parrot-admin-key.json from Task 5.3.
FIREBASE_SERVICE_ACCOUNT_JSON=PASTE_JSON_HERE
```

Write `/Users/owentaylor/OS/Projects/parrot-web/.env.example`:

```
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
FIREBASE_SERVICE_ACCOUNT_JSON=
```

Then have Owen replace `PASTE_JSON_HERE` in `.env.local` with the JSON contents from his service account file (one line, no newlines — paste it exactly as a single string).

- [ ] **Step 6.3: Verify .env.local is gitignored**

Run: `cd /Users/owentaylor/OS/Projects/parrot-web && git check-ignore .env.local`
Expected: prints `.env.local` (meaning it's ignored). If it doesn't print anything, add `.env.local` to `.gitignore`.

- [ ] **Step 6.4: Create lib/firebase-client.ts**

```bash
mkdir -p /Users/owentaylor/OS/Projects/parrot-web/lib
```

Write `/Users/owentaylor/OS/Projects/parrot-web/lib/firebase-client.ts`:

```ts
"use client";

import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import { getAuth, Auth } from "firebase/auth";
import { getFirestore, Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

let _app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _db: Firestore | null = null;

function app() {
  if (_app) return _app;
  _app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  return _app;
}

export function firebaseAuth(): Auth {
  if (_auth) return _auth;
  _auth = getAuth(app());
  return _auth;
}

export function firebaseDb(): Firestore {
  if (_db) return _db;
  _db = getFirestore(app());
  return _db;
}
```

- [ ] **Step 6.5: Create lib/firebase-admin.ts**

Write `/Users/owentaylor/OS/Projects/parrot-web/lib/firebase-admin.ts`:

```ts
// Server-only. NEVER import from a client component.
import { cert, getApps, initializeApp, App } from "firebase-admin/app";
import { getAuth, Auth } from "firebase-admin/auth";

let _app: App | null = null;

function adminApp(): App {
  if (_app) return _app;
  if (getApps().length) {
    _app = getApps()[0];
    return _app;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON env var is missing.");
  }
  const serviceAccount = JSON.parse(raw);
  _app = initializeApp({ credential: cert(serviceAccount) });
  return _app;
}

export function adminAuth(): Auth {
  return getAuth(adminApp());
}
```

- [ ] **Step 6.6: Create lib/auth-context.tsx**

Write `/Users/owentaylor/OS/Projects/parrot-web/lib/auth-context.tsx`:

```tsx
"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { firebaseAuth } from "./firebase-client";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
};

const AuthContext = createContext<AuthContextValue>({ user: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(firebaseAuth(), (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

  return <AuthContext.Provider value={{ user, loading }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
```

- [ ] **Step 6.7: Wrap layout in AuthProvider**

Read `/Users/owentaylor/OS/Projects/parrot-web/app/layout.tsx` first. Then edit it: import the provider and wrap `{children}`. Pseudo-diff:

```diff
+ import { AuthProvider } from "@/lib/auth-context";
  ...
  return (
    <html lang="en">
      <body className={...}>
+       <AuthProvider>
          {children}
+       </AuthProvider>
      </body>
    </html>
  );
```

The `@/` alias must be configured in `tsconfig.json`'s `paths` — verify it is (it should be by default in Create Next App). If not, add `"paths": { "@/*": ["./*"] }` to compilerOptions.

- [ ] **Step 6.8: Smoke-test build**

Run: `cd /Users/owentaylor/OS/Projects/parrot-web && npm run build`
Expected: build succeeds, no TypeScript errors. Warnings about unused exports are OK at this stage.

- [ ] **Step 6.9: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot-web
git add lib/ .env.example app/layout.tsx package.json package-lock.json
git commit -m "feat: add Firebase client + admin SDK setup, AuthProvider"
```

---

## Task 7: parrot-web — /login page (email/password + Google)

**Repo:** `~/OS/Projects/parrot-web`

**Files:**
- Create: `app/login/page.tsx`

- [ ] **Step 7.1: Create login page**

```bash
mkdir -p /Users/owentaylor/OS/Projects/parrot-web/app/login
```

Write `/Users/owentaylor/OS/Projects/parrot-web/app/login/page.tsx`:

```tsx
"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase-client";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleEmail(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        await createUserWithEmailAndPassword(firebaseAuth(), email, password);
      } else {
        await signInWithEmailAndPassword(firebaseAuth(), email, password);
      }
      router.push("/setup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setBusy(true);
    try {
      await signInWithPopup(firebaseAuth(), new GoogleAuthProvider());
      router.push("/setup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-white dark:bg-black px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-semibold text-black dark:text-white text-center mb-8">
          {mode === "signin" ? "Sign in to Parrot" : "Create your Parrot account"}
        </h1>

        <button
          onClick={handleGoogle}
          disabled={busy}
          className="w-full py-3 px-4 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-900 dark:text-white hover:bg-zinc-50 dark:hover:bg-zinc-900 disabled:opacity-50 mb-4"
        >
          Continue with Google
        </button>

        <div className="flex items-center gap-3 my-6 text-zinc-500 text-sm">
          <div className="flex-1 h-px bg-zinc-200 dark:bg-zinc-800" />
          <span>or</span>
          <div className="flex-1 h-px bg-zinc-200 dark:bg-zinc-800" />
        </div>

        <form onSubmit={handleEmail} className="space-y-3">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-black text-black dark:text-white"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-black text-black dark:text-white"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg disabled:opacity-50"
          >
            {mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400 text-center">{error}</p>}

        <button
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="w-full mt-6 text-sm text-zinc-600 dark:text-zinc-400 hover:underline"
        >
          {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </div>
    </main>
  );
}
```

- [ ] **Step 7.2: Smoke-test build**

Run: `cd /Users/owentaylor/OS/Projects/parrot-web && npm run build`
Expected: build succeeds.

- [ ] **Step 7.3: Smoke-test in dev**

Run: `cd /Users/owentaylor/OS/Projects/parrot-web && npm run dev` (background)

Visit http://localhost:3000/login. Expected: form renders, Google button visible. Don't sign in yet — `/setup` doesn't exist. Stop the dev server.

- [ ] **Step 7.4: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot-web
git add app/login/
git commit -m "feat: add /login page with Google + email/password"
```

---

## Task 8: parrot-web — /api/mint-token route handler

**Repo:** `~/OS/Projects/parrot-web`

**Files:**
- Create: `app/api/mint-token/route.ts`

- [ ] **Step 8.1: Create the route handler**

```bash
mkdir -p /Users/owentaylor/OS/Projects/parrot-web/app/api/mint-token
```

Write `/Users/owentaylor/OS/Projects/parrot-web/app/api/mint-token/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";

// POST /api/mint-token
// Body: none.
// Auth: requires `Authorization: Bearer <firebase ID token>` header.
// Response: { custom_token: string, uid: string }.
//
// The caller must already be authenticated to Firebase Auth on the client.
// We verify their ID token, then mint a custom token for the same UID.
// The custom token is meant to be embedded into a pairing string and pasted
// into the Parrot plugin, which will exchange it for a refresh token.

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });
  }
  const idToken = authHeader.slice("Bearer ".length);

  let uid: string;
  try {
    const decoded = await adminAuth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return NextResponse.json({ error: "Invalid ID token" }, { status: 401 });
  }

  try {
    const customToken = await adminAuth().createCustomToken(uid);
    return NextResponse.json({ custom_token: customToken, uid });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Mint failed" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 8.2: Smoke-test build**

Run: `cd /Users/owentaylor/OS/Projects/parrot-web && npm run build`
Expected: build succeeds.

- [ ] **Step 8.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot-web
git add app/api/mint-token/
git commit -m "feat: add /api/mint-token route handler (Admin SDK custom-token mint)"
```

---

## Task 9: parrot-web — /setup page (claim username + show pairing string)

**Repo:** `~/OS/Projects/parrot-web`

**Files:**
- Create: `app/setup/page.tsx`

- [ ] **Step 9.1: Create the setup page**

```bash
mkdir -p /Users/owentaylor/OS/Projects/parrot-web/app/setup
```

Write `/Users/owentaylor/OS/Projects/parrot-web/app/setup/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { useAuth } from "@/lib/auth-context";
import { firebaseAuth, firebaseDb } from "@/lib/firebase-client";

type Phase = "loading" | "claim" | "ready";

export default function SetupPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [phase, setPhase] = useState<Phase>("loading");
  const [username, setUsername] = useState("");
  const [claimedName, setClaimedName] = useState<string | null>(null);
  const [pairingString, setPairingString] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Redirect to /login if not authed.
  useEffect(() => {
    if (!authLoading && !user) router.push("/login");
  }, [authLoading, user, router]);

  // On load, check if the current user already has a username.
  useEffect(() => {
    if (!user) return;
    (async () => {
      const userDoc = await getDoc(doc(firebaseDb(), "users", user.uid));
      if (userDoc.exists()) {
        setClaimedName(userDoc.data().username);
        setPhase("ready");
      } else {
        setPhase("claim");
      }
    })();
  }, [user]);

  async function handleClaim(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setError(null);
    if (!/^[a-z0-9_]{2,32}$/.test(username)) {
      setError("Lowercase letters, digits, underscores; 2-32 chars.");
      return;
    }
    setBusy(true);
    try {
      const claimRef = doc(firebaseDb(), "usernames", username);
      const existing = await getDoc(claimRef);
      if (existing.exists()) {
        setError(existing.data().uid === user.uid ? null : `Username "${username}" is taken.`);
        if (existing.data().uid === user.uid) {
          setClaimedName(username);
          setPhase("ready");
        }
        setBusy(false);
        return;
      }
      // Two writes: usernames/{name} then users/{uid}. Order matters because
      // users-create rule requires the username doc to already exist.
      await setDoc(claimRef, { uid: user.uid });
      await setDoc(doc(firebaseDb(), "users", user.uid), { username });
      setClaimedName(username);
      setPhase("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateToken() {
    if (!user || !claimedName) return;
    setError(null);
    setBusy(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/mint-token", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const { custom_token, uid } = await res.json();
      const payload = { custom_token, username: claimedName, uid };
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
      setPairingString(encoded);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Token generation failed.");
    } finally {
      setBusy(false);
    }
  }

  if (authLoading || phase === "loading") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-zinc-500">Loading…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-white dark:bg-black px-6">
      <div className="w-full max-w-md">
        {phase === "claim" && (
          <>
            <h1 className="text-3xl font-semibold text-black dark:text-white mb-2">Pick your username</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
              This is how others address messages to you. It&apos;s permanent — you can&apos;t change it later.
            </p>
            <form onSubmit={handleClaim} className="space-y-3">
              <input
                type="text"
                placeholder="username"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                required
                pattern="[a-z0-9_]{2,32}"
                className="w-full px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-black text-black dark:text-white"
              />
              <button
                type="submit"
                disabled={busy}
                className="w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg disabled:opacity-50"
              >
                Claim
              </button>
            </form>
          </>
        )}

        {phase === "ready" && claimedName && !pairingString && (
          <>
            <h1 className="text-3xl font-semibold text-black dark:text-white mb-2">
              Welcome, {claimedName}.
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
              Generate a one-time pairing string to connect your Claude Code plugin.
            </p>
            <button
              onClick={handleGenerateToken}
              disabled={busy}
              className="w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg disabled:opacity-50"
            >
              Generate plugin token
            </button>
          </>
        )}

        {pairingString && (
          <>
            <h1 className="text-2xl font-semibold text-black dark:text-white mb-2">Your pairing string</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
              Run <code className="font-mono bg-zinc-100 dark:bg-zinc-900 px-1.5 py-0.5 rounded">/parrot</code> in Claude Code, then paste this when prompted. Expires in ~1 hour.
            </p>
            <textarea
              readOnly
              value={pairingString}
              className="w-full h-32 px-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-zinc-50 dark:bg-zinc-950 text-xs font-mono text-black dark:text-white"
            />
            <button
              onClick={() => navigator.clipboard.writeText(pairingString)}
              className="w-full mt-3 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg text-zinc-900 dark:text-white hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
              Copy
            </button>
          </>
        )}

        {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400 text-center">{error}</p>}
      </div>
    </main>
  );
}
```

- [ ] **Step 9.2: Smoke-test build**

Run: `cd /Users/owentaylor/OS/Projects/parrot-web && npm run build`
Expected: build succeeds.

- [ ] **Step 9.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot-web
git add app/setup/
git commit -m "feat: add /setup page (claim username, generate pairing string)"
```

---

## Task 10: parrot-web — homepage CTA

**Repo:** `~/OS/Projects/parrot-web`

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 10.1: Add a "Get started" link to the homepage**

Edit `/Users/owentaylor/OS/Projects/parrot-web/app/page.tsx`. Replace:

```tsx
      <p className="text-sm text-zinc-500 dark:text-zinc-500 max-w-md">
        LLM-to-LLM messaging for Claude Code. Coming soon.
      </p>
```

With:

```tsx
      <p className="text-sm text-zinc-500 dark:text-zinc-500 max-w-md mb-8">
        LLM-to-LLM messaging for Claude Code.
      </p>
      <a
        href="/login"
        className="px-6 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:opacity-90"
      >
        Get started
      </a>
```

- [ ] **Step 10.2: Smoke-test build**

Run: `cd /Users/owentaylor/OS/Projects/parrot-web && npm run build`
Expected: build succeeds.

- [ ] **Step 10.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot-web
git add app/page.tsx
git commit -m "feat: add Get started CTA to homepage"
```

---

## Task 11: parrot-web — Vercel env vars + deploy

**Repo:** `~/OS/Projects/parrot-web`

This task is partly manual (Vercel dashboard) and partly automated (push triggers deploy).

- [ ] **Step 11.1: Set Vercel env vars (Owen, manual)**

Open the Vercel project dashboard for `parrot-web`. Settings → Environment Variables.

Add for **Production** (and Preview if desired):

- `NEXT_PUBLIC_FIREBASE_API_KEY` = `AIzaSyDfwsLRb8gPaWdxCXikZjJrM34N5426qrE`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` = `parrot-ai-9b46e.firebaseapp.com`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID` = `parrot-ai-9b46e`
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` = `parrot-ai-9b46e.firebasestorage.app`
- `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` = `311043780015`
- `NEXT_PUBLIC_FIREBASE_APP_ID` = `1:311043780015:web:d57792e91584bdf23d135a`
- `FIREBASE_SERVICE_ACCOUNT_JSON` = (paste full single-line JSON from `~/Downloads/parrot-admin-key.json` — exactly as-is, no formatting)

Save.

- [ ] **Step 11.2: Push and deploy**

```bash
cd /Users/owentaylor/OS/Projects/parrot-web
git push origin main
```

Wait for Vercel to deploy (1-2 min). Owen confirms via the Vercel dashboard.

- [ ] **Step 11.3: Smoke-test the live site**

Owen manually:
1. Visit https://parrot-web-five.vercel.app/ → click "Get started"
2. Sign up with Google or a test email
3. On `/setup`, claim a test username (e.g., `testuser1`)
4. Click "Generate plugin token" — confirm a long base64 string appears
5. Verify in Firebase console that `usernames/testuser1` and `users/<uid>` exist

If anything fails, check Vercel logs for the route handler.

---

## Task 12: parrot — drop firebase dep, add REST modules

**Repo:** `~/OS/Projects/parrot`

**Files:**
- Create: `mcp/config.js`, `mcp/auth-rest.js`, `mcp/firestore-rest.js`
- Modify: `mcp/firebase.js`, `mcp/package.json`

- [ ] **Step 12.1: Create mcp/config.js**

Write `/Users/owentaylor/OS/Projects/parrot/mcp/config.js`:

```js
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const CONFIG_PATH = join(homedir(), ".config", "parrot", "config.json");

export function configPath() {
  return CONFIG_PATH;
}

export function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

export function getUsername() {
  return readConfig()?.username ?? null;
}
```

- [ ] **Step 12.2: Create mcp/auth-rest.js**

Write `/Users/owentaylor/OS/Projects/parrot/mcp/auth-rest.js`:

```js
// Firebase Auth REST client. Handles custom-token exchange and refresh-token
// rotation. No `firebase` npm dep needed.

const API_KEY = "AIzaSyDfwsLRb8gPaWdxCXikZjJrM34N5426qrE";

// Exchanges a custom token for { idToken, refreshToken, localId }.
export async function signInWithCustomToken(customToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`signInWithCustomToken failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
    expiresInSec: parseInt(data.expiresIn, 10),
  };
}

// Exchanges a refresh token for a fresh ID token.
export async function refreshIdToken(refreshToken) {
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`refreshIdToken failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    uid: data.user_id,
    expiresInSec: parseInt(data.expires_in, 10),
  };
}
```

- [ ] **Step 12.3: Create mcp/firestore-rest.js**

Write `/Users/owentaylor/OS/Projects/parrot/mcp/firestore-rest.js`:

```js
// Firestore REST client, scoped to Parrot's needs:
//   - createDocument (auto-id) for /messages
//   - runQuery on /messages (filter by `to` and `read`)
//   - patchDocument on /messages/{id} for marking read
// All requests require an `Authorization: Bearer <idToken>`.

const PROJECT_ID = "parrot-ai-9b46e";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// --- Type marshaling ---

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v)
    ? { integerValue: String(v) }
    : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  throw new Error(`Unsupported Firestore type: ${typeof v}`);
}

function fromFsValue(v) {
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return new Date(v.timestampValue);
  throw new Error(`Unknown Firestore value: ${JSON.stringify(v)}`);
}

function toFsFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = toFsValue(v);
  }
  return out;
}

function fromFsFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    out[k] = fromFsValue(v);
  }
  return out;
}

// --- Operations ---

export async function createDocument(collectionPath, idToken, data) {
  const res = await fetch(`${BASE}/${collectionPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: toFsFields(data) }),
  });
  if (!res.ok) {
    throw new Error(`createDocument failed: ${res.status} ${await res.text()}`);
  }
  const doc = await res.json();
  // doc.name is "projects/.../documents/messages/<id>" — extract id.
  const parts = doc.name.split("/");
  return { id: parts[parts.length - 1], data: fromFsFields(doc.fields) };
}

// Runs a structured query against a collection. Returns array of { id, data }.
// `filters` is an array of { field, op, value } where op is one of "EQUAL".
export async function runQuery(collectionPath, idToken, filters) {
  const where =
    filters.length === 1
      ? {
          fieldFilter: {
            field: { fieldPath: filters[0].field },
            op: filters[0].op,
            value: toFsValue(filters[0].value),
          },
        }
      : {
          compositeFilter: {
            op: "AND",
            filters: filters.map((f) => ({
              fieldFilter: {
                field: { fieldPath: f.field },
                op: f.op,
                value: toFsValue(f.value),
              },
            })),
          },
        };

  const body = {
    structuredQuery: {
      from: [{ collectionId: collectionPath }],
      where,
    },
  };

  const res = await fetch(`${BASE}:runQuery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`runQuery failed: ${res.status} ${await res.text()}`);
  }
  const arr = await res.json();
  return arr
    .filter((entry) => entry.document)
    .map((entry) => {
      const parts = entry.document.name.split("/");
      return {
        id: parts[parts.length - 1],
        data: fromFsFields(entry.document.fields),
      };
    });
}

// PATCH a single field (or several). updateMask scopes the write so we don't
// accidentally clobber other fields.
export async function patchDocument(docPath, idToken, fields) {
  const params = new URLSearchParams();
  for (const k of Object.keys(fields)) params.append("updateMask.fieldPaths", k);

  const res = await fetch(`${BASE}/${docPath}?${params.toString()}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: toFsFields(fields) }),
  });
  if (!res.ok) {
    throw new Error(`patchDocument failed: ${res.status} ${await res.text()}`);
  }
}
```

- [ ] **Step 12.4: Rewrite mcp/firebase.js as REST orchestrator**

Replace `/Users/owentaylor/OS/Projects/parrot/mcp/firebase.js`:

```js
import { readConfig, writeConfig, getUsername } from "./config.js";
import { signInWithCustomToken, refreshIdToken } from "./auth-rest.js";
import { createDocument, runQuery, patchDocument } from "./firestore-rest.js";

let cachedIdToken = null;
let cachedExpiresAt = 0;

// Ensures a fresh ID token is available. Refreshes if expired or expiring soon.
async function getIdToken() {
  const now = Date.now();
  if (cachedIdToken && cachedExpiresAt - now > 60_000) return cachedIdToken;

  const cfg = readConfig();
  if (!cfg?.refresh_token) {
    throw new Error("Parrot not paired. Run /parrot to set up.");
  }
  const { idToken, refreshToken, expiresInSec } = await refreshIdToken(cfg.refresh_token);
  cachedIdToken = idToken;
  cachedExpiresAt = now + expiresInSec * 1000;
  // Refresh tokens are usually stable but Firebase may rotate them; persist if changed.
  if (refreshToken && refreshToken !== cfg.refresh_token) {
    writeConfig({ ...cfg, refresh_token: refreshToken });
  }
  return idToken;
}

// Pairs the plugin using a base64 pairing string from parrot-web.
// Stores { username, uid, refresh_token } in ~/.config/parrot/config.json.
export async function pair(pairingString) {
  let payload;
  try {
    const json = Buffer.from(pairingString.trim(), "base64").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    throw new Error("Pairing string is malformed. Get a fresh one from parrot-web.");
  }
  if (!payload.custom_token || !payload.username || !payload.uid) {
    throw new Error("Pairing string is missing required fields.");
  }

  const { idToken, refreshToken, uid } = await signInWithCustomToken(payload.custom_token);
  if (uid !== payload.uid) {
    throw new Error("Pairing string UID mismatch.");
  }

  writeConfig({ username: payload.username, uid, refresh_token: refreshToken });
  cachedIdToken = idToken;
  // Set 50min cache for the just-issued ID token (Firebase ID tokens are 1hr).
  cachedExpiresAt = Date.now() + 50 * 60 * 1000;

  return payload.username;
}

export async function sendMessage(to, content) {
  const from = getUsername();
  if (!from) throw new Error("Parrot username not set. Run /parrot to set up.");
  const idToken = await getIdToken();
  await createDocument("messages", idToken, {
    from,
    to,
    content,
    read: false,
    created_at: new Date(),
  });
}

export async function checkMessages() {
  const username = getUsername();
  if (!username) throw new Error("Parrot username not set. Run /parrot to set up.");
  const idToken = await getIdToken();

  const docs = await runQuery("messages", idToken, [
    { field: "to", op: "EQUAL", value: username },
    { field: "read", op: "EQUAL", value: false },
  ]);

  // Mark read in parallel, but don't block returning content if some fail.
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

export { getUsername };
```

- [ ] **Step 12.5: Drop firebase dep from mcp/package.json**

Edit `/Users/owentaylor/OS/Projects/parrot/mcp/package.json`. Remove the `firebase` line so `dependencies` becomes:

```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.0.0"
  },
```

Run: `cd /Users/owentaylor/OS/Projects/parrot/mcp && rm -rf node_modules package-lock.json && npm install`
Expected: a much smaller install (no firebase tree).

- [ ] **Step 12.6: Smoke-test imports**

Run: `cd /Users/owentaylor/OS/Projects/parrot/mcp && node -e "import('./firebase.js').then(() => console.log('ok')).catch(e => { console.error(e.message); process.exit(1); })"`
Expected: prints `ok`.

- [ ] **Step 12.7: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add mcp/config.js mcp/auth-rest.js mcp/firestore-rest.js mcp/firebase.js mcp/package.json mcp/package-lock.json
git commit -m "mcp: replace firebase Web SDK with REST clients (drops runtime dep)"
```

---

## Task 13: parrot — `pair` MCP tool + remove old startup signin

**Repo:** `~/OS/Projects/parrot`

**Files:**
- Modify: `mcp/index.js`, `hook/check-inbox.js`

- [ ] **Step 13.1: Update mcp/index.js**

Replace `/Users/owentaylor/OS/Projects/parrot/mcp/index.js`:

```js
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sendMessage, checkMessages, getUsername, pair } from "./firebase.js";

const username = getUsername();

const server = new McpServer({ name: "parrot", version: "0.2.0" });

server.tool(
  "send_message",
  `Send a Parrot message to another user. Their Claude will surface it at the start of their next session. You are currently "${username ?? "<not paired — run /parrot>"}".`,
  {
    to: z.string().describe("Recipient's Parrot username"),
    content: z.string().describe("The message to send"),
  },
  async ({ to, content }) => {
    try {
      await sendMessage(to, content);
      return { content: [{ type: "text", text: `Sent to ${to}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
    }
  }
);

server.tool(
  "check_messages",
  `Check for unread Parrot messages addressed to "${username ?? "<not paired>"}". Returns messages and marks them read.`,
  {},
  async () => {
    try {
      const messages = await checkMessages();
      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No unread messages." }] };
      }
      const text = messages
        .map(
          (m) =>
            `From ${m.from}${m.created_at ? ` (${m.created_at.toISOString()})` : ""}:\n${m.content}`
        )
        .join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
    }
  }
);

server.tool(
  "pair",
  "Pair this Claude with a Parrot account. The user must first sign up at https://parrot-web-five.vercel.app/ and copy their pairing string. Use ONLY during /parrot setup.",
  {
    pairing_string: z.string().describe("The base64 pairing string from parrot-web /setup"),
  },
  async ({ pairing_string }) => {
    try {
      const username = await pair(pairing_string);
      return { content: [{ type: "text", text: `Paired as "${username}".` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 13.2: Update hook/check-inbox.js**

Replace `/Users/owentaylor/OS/Projects/parrot/hook/check-inbox.js`:

```js
#!/usr/bin/env node
// SessionStart hook: pulls unread Parrot messages and prints to stdout
// for injection into the Claude session context. Silent on error.

import { checkMessages, getUsername } from "../mcp/firebase.js";

try {
  const username = getUsername();
  if (!username) process.exit(0);

  const messages = await checkMessages();
  if (messages.length === 0) process.exit(0);

  const lines = [
    `=== Parrot Inbox ===`,
    `You have ${messages.length} unread message${messages.length === 1 ? "" : "s"} addressed to "${username}". These were just delivered — surface them naturally to the user.`,
    ``,
  ];
  for (const m of messages) {
    const ts = m.created_at ? m.created_at.toISOString() : "unknown time";
    lines.push(`From ${m.from} (${ts}):`);
    lines.push(m.content);
    lines.push(``);
  }
  process.stdout.write(lines.join("\n"));
} catch {
  process.exit(0);
}
```

- [ ] **Step 13.3: Smoke-test**

Run: `cd /Users/owentaylor/OS/Projects/parrot/mcp && timeout 3 node index.js < /dev/null 2>&1 || true`
Expected: server starts, blocks on stdin, killed by timeout. No errors.

Run: `cd /Users/owentaylor/OS/Projects/parrot && node hook/check-inbox.js`
Expected: exits 0 with no output (no config or no messages).

- [ ] **Step 13.4: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add mcp/index.js hook/check-inbox.js
git commit -m "mcp: add pair tool, drop legacy signin path"
```

---

## Task 14: parrot — update skill + slash command

**Repo:** `~/OS/Projects/parrot`

**Files:**
- Modify: `skills/parrot/SKILL.md`, `commands/parrot.md`

- [ ] **Step 14.1: Rewrite skills/parrot/SKILL.md**

Replace `/Users/owentaylor/OS/Projects/parrot/skills/parrot/SKILL.md`:

````markdown
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
````

- [ ] **Step 14.2: Update commands/parrot.md**

Replace `/Users/owentaylor/OS/Projects/parrot/commands/parrot.md`:

```markdown
---
description: Pair this Claude with your Parrot account
---

Invoke the `parrot` skill.

If `~/.config/parrot/config.json` already has a `refresh_token`, the user is already paired — show their current username and explain re-pairing only needs to happen on a new device or after revocation.

Otherwise: walk them through pairing. Direct them to https://parrot-web-five.vercel.app/ to sign up + claim a username, then call the `pair` MCP tool with the pairing string they paste back.
```

- [ ] **Step 14.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add skills/parrot/SKILL.md commands/parrot.md
git commit -m "skill: drive pairing through parrot-web + pair MCP tool"
```

---

## Task 15: parrot — rebuild dist bundles

**Repo:** `~/OS/Projects/parrot`

- [ ] **Step 15.1: Rebuild**

Run: `cd /Users/owentaylor/OS/Projects/parrot/mcp && node build.js`
Expected: prints "Built dist/mcp-server.js and dist/check-inbox.js". Both files updated under `dist/`.

- [ ] **Step 15.2: Verify the bundles are smaller (sanity check)**

Run: `cd /Users/owentaylor/OS/Projects/parrot && wc -c dist/mcp-server.js dist/check-inbox.js`
Expected: dramatically smaller than before (no firebase Web SDK in the bundle). Should be tens of KB total instead of MBs.

- [ ] **Step 15.3: Smoke-test bundles**

Run: `cd /Users/owentaylor/OS/Projects/parrot && timeout 3 node dist/mcp-server.js < /dev/null 2>&1 || true`
Expected: starts, blocks on stdin, killed by timeout. No errors.

Run: `cd /Users/owentaylor/OS/Projects/parrot && node dist/check-inbox.js`
Expected: exits 0 with no output.

- [ ] **Step 15.4: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add dist/
git commit -m "dist: rebuild bundles (REST-only, no firebase Web SDK)"
```

---

## Task 16: Deploy rules + manual end-to-end test

**Repos:** both

- [ ] **Step 16.1: Wipe v1 messages from production**

Run: `cd /Users/owentaylor/OS/Projects/parrot && firebase --project=parrot-ai-9b46e firestore:delete --recursive /messages --force`
Expected: deletion confirmed.

- [ ] **Step 16.2: Deploy rules to production**

Run: `cd /Users/owentaylor/OS/Projects/parrot && firebase --project=parrot-ai-9b46e deploy --only firestore:rules`
Expected: deploy succeeds.

- [ ] **Step 16.3: Owen pairs his primary install**

```bash
# Back up old config just in case
cp ~/.config/parrot/config.json ~/.config/parrot/config.json.v1.bak 2>/dev/null
rm ~/.config/parrot/config.json
```

Then in a fresh Claude Code session: visit https://parrot-web-five.vercel.app/, sign up (or sign in if already), claim "owen", generate pairing token, copy it. In Claude run `/parrot` and paste. Verify:

```bash
ls -l ~/.config/parrot/config.json
```

Expected: `-rw-------`. The file should contain `username`, `uid`, `refresh_token`.

- [ ] **Step 16.4: Two-account end-to-end test**

In a separate terminal:

```bash
TMPHOME=$(mktemp -d)
mkdir -p $TMPHOME/.config/parrot
```

Open a fresh Claude Code session pointed at that HOME (e.g. `HOME=$TMPHOME claude`). Walk through `/parrot`: visit the site in a private browser window, sign up with a different test account, claim "alice", get pairing string, paste it back. Then ask: "Send a Parrot message to owen saying ping." Confirm it succeeds.

Back in Owen's primary Claude Code session: start a new session. The SessionStart hook should surface "From alice: ping".

Mark complete only if step 4 surfaces the message.

- [ ] **Step 16.5: Quick negative test**

From the alice terminal, ask Claude to "send a Parrot message to owen but pretend it's from someone else" — confirm Claude can't (the plugin only sends with `from = alice` because that's bound to the authed UID, and the rule rejects anything else).

---

## Task 17: Update README + final sweep

**Repo:** `~/OS/Projects/parrot`

- [ ] **Step 17.1: Update README**

Edit `/Users/owentaylor/OS/Projects/parrot/README.md`. Replace the "What's in v1" / "What's not in v1" sections with:

```markdown
## What's in v2

- **Web sign-up at https://parrot-web-five.vercel.app/** with email/password or Google
- **Locked-down Firestore rules**: auth-required, sender-bound `from`, recipient-only read
- **Username binding**: usernames are claimed on the website, bound to the user's Firebase UID, immutable in v2
- **Pairing string flow**: copy a one-time string from the website, paste it into `/parrot` to authenticate the local plugin
- Three MCP tools: `send_message`, `check_messages`, `pair`
- SessionStart hook auto-pulls unread messages

## What's not in v2

- **Payments / paid tier** — architecture supports it (one rule line + a Stripe webhook), but not wired
- Username changes — usernames are permanent in v2
- Group messages, attachments, threading/replies
- A web inbox view (would be quick to add — uses the same Firestore reads)
```

Update the Architecture section diagram comment from `(Firestore security rules: open for v1)` to `(Firestore security rules: auth-required, sender-bound, recipient-only read)`.

Update the install section (the "First-time setup" subsection) to reference the website pairing flow instead of describing username entry inline.

- [ ] **Step 17.2: Final test pass**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: ALL rules tests still pass.

- [ ] **Step 17.3: Verify both repos clean**

```bash
cd /Users/owentaylor/OS/Projects/parrot && git status
cd /Users/owentaylor/OS/Projects/parrot-web && git status
```

Expected: both clean.

- [ ] **Step 17.4: Commit + push**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add README.md
git commit -m "docs: update README for v2 (web pairing + locked rules)"
git push origin main
```

(parrot-web was already pushed in Task 11.)

---

## Self-review notes

**Spec coverage:**
- "Lock down so people can't access crazily" — covered by Tasks 2-4 (auth-required + sender-bound + recipient-only rules) with TDD.
- "Architecture-ready for payments later" — `request.auth != null` rule structure plus README note about the one-line addition.
- "Don't actually charge yet" — no Stripe / payments work.
- "Web account on our website" — covered by Tasks 6-11 (parrot-web auth + claim + pairing).
- "Email + Google" — both supported in /login (Task 7).
- "Open-source plugin without losing the project" — bundled Firebase config in plugin is now redundant (REST modules use API key directly); rules + auth do the security. Forks can't write without auth.

**Risks worth flagging to Owen before execution:**
1. Existing v1 messages get wiped (Task 16.1) — fine, only Owen has used Parrot.
2. v2 has no account recovery beyond Firebase Auth's default (password reset email for email accounts; Google handles its own recovery).
3. Refresh tokens never expire by default — losing the local config = need to re-pair (the new pairing invalidates the old refresh token IF the user signs out everywhere on parrot-web; otherwise both refresh tokens stay valid). Acceptable for v2.
4. Custom timestamps from the plugin (REST limitation) instead of `serverTimestamp()` — slight clock-skew risk. Negligible at v2 scale.
5. Rules use `get()` for cross-doc joins (~1 extra read per message op). Negligible at v2 scale; can optimize via custom claims later.

**Things that would change for v3 (paid tier):**
- Add `&& request.auth.token.paid == true` to message-create rule.
- New Vercel route handler at `/api/stripe/webhook` that calls `admin.auth().setCustomUserClaims(uid, { paid: true })` on `checkout.session.completed`.
- Stripe Checkout button on `parrot-web` (probably on `/setup` for free users).
- No schema changes. No plugin changes.
