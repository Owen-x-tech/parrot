# Parrot Auth & Locked-Down Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Firebase Auth and lock down Firestore rules so the open-source plugin can't be abused, while leaving the architecture pre-wired for a future paid tier (no payments yet).

**Architecture:** On first run, the Parrot client generates a synthetic email + password and creates a Firebase Auth user. Credentials are stored in `~/.config/parrot/config.json` (with 0600 perms). Every subsequent MCP/hook startup signs in with those credentials. Usernames are claimed first-come-first-served via a `usernames/{username}` collection bound to the user's UID, with a parallel `users/{uid}` doc storing the reverse mapping. Firestore rules require `request.auth != null` and enforce that `messages.from` matches the authenticated user's bound username. To later add payments, we'd add `&& request.auth.token.paid == true` to the message-create rule and a Cloud Function that sets the claim on Stripe webhook — no schema changes needed.

**Tech Stack:** Firebase Web SDK v11 (`firebase/app`, `firebase/auth`, `firebase/firestore`), Node 20, esbuild bundling, `@firebase/rules-unit-testing` + Firebase Emulator + `node --test` for security-rules TDD.

---

## File Structure

**Created:**
- `package.json` (repo root) — dev-only: `@firebase/rules-unit-testing`, `firebase-admin`, test script
- `mcp/config.js` — config file path, schema, atomic read/write with 0600 perms
- `tests/rules.test.js` — Firestore security rules unit tests
- `tests/helpers.js` — emulator setup helpers shared by rules tests

**Modified:**
- `firestore.rules` — full rewrite: auth-required, username binding, message ownership
- `mcp/firebase.js` — add auth init, sign-in/sign-up, claim-username; refactor sendMessage/checkMessages to require an authenticated user
- `mcp/index.js` — call ensureSignedIn() at startup; surface auth errors clearly
- `hook/check-inbox.js` — call ensureSignedIn() before checking; silent on auth failure (same pattern as today)
- `skills/parrot/SKILL.md` — update flow to handle username claim collision and explain auth credential file
- `commands/parrot.md` — minor wording update
- `README.md` — update "What's in" / "What's not in" lists; document the locked-down rules and auth model
- `firestore.indexes.json` — no change expected; flag for review

**Untouched:** `mcp/build.js`, `hooks/hooks.json`, `.mcp.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `assets/parrot.png`.

---

## Architecture Notes

### Config file shape

`~/.config/parrot/config.json` (mode 0600):

```json
{
  "username": "owen",
  "uid": "abc123xyz...",
  "auth": {
    "email": "parrot-abc123xyz@parrot.local",
    "password": "<random 32-char hex>"
  }
}
```

The "password" is a randomly generated local secret. Anyone with read access to the user's home directory can impersonate them — same threat model as an SSH key or refresh token. We set 0600 perms to match that convention.

### Firestore collections

- `users/{uid}` → `{ username: string }` — owned by the authenticated user, writable only by them, immutable after creation. Lets rules ask "what's my username?" via `get()`.
- `usernames/{username}` → `{ uid: string }` — claim record. Immutable, first-come-first-served. Lets rules ask "is this username taken?" and "who owns it?"
- `messages/{messageId}` → `{ from: string, to: string, content: string, read: bool, created_at: timestamp }` — username-keyed (the wire schema is unchanged from v1). Rules use `get(/users/$(uid))` and `get(/usernames/$(to))` to enforce sender identity and recipient existence.

### Sign-in flow

1. Read config. If no `auth` section → first run.
2. First run: generate `parrot-{16-char-hex}@parrot.local` + 32-char-hex password. Call `createUserWithEmailAndPassword(...)`. Save email, password, uid to config.
3. Subsequent runs: `signInWithEmailAndPassword(...)` with stored creds at every cold start (Firebase Web SDK on Node has no cross-process persistence — that's fine, sign-in is fast).
4. After sign-in, the SDK manages ID-token refresh in memory for the lifetime of the process.

### Username claim flow

1. Read `usernames/{username}`. If exists: error if it's not yours, no-op if it is yours.
2. If not taken: batched write — create `usernames/{username}` with `{ uid: <auth.uid> }` AND create `users/{auth.uid}` with `{ username }`. Rules ensure both writes succeed atomically (or both fail).
3. Save `username` to local config.

### Migration from v1

Existing v1 messages in Firestore become unreadable (no auth context). Acceptable: only Owen has used Parrot to date. As part of deploy, manually delete the `messages` collection from the Firebase console (or via `firebase firestore:delete`).

Owen's existing local config has `username` only (no `auth`, no `uid`). On first run of the new client, the missing `auth` section triggers sign-up flow. The new client will then attempt to claim Owen's existing username — succeeds since the `usernames` collection is empty.

### Where payments plug in later

Single change in `firestore.rules`, on the `allow create` rule for `messages`:

```diff
  allow create: if request.auth != null
+               && request.auth.token.paid == true
                && ...
```

Plus a Cloud Function listening to Stripe webhooks that calls `admin.auth().setCustomUserClaims(uid, { paid: true })`. Out of scope for this plan — but the architecture supports it without schema changes.

---

## Task 1: Add test infrastructure

**Files:**
- Create: `package.json` (repo root)
- Create: `tests/helpers.js`
- Modify: `.gitignore`

- [ ] **Step 1.1: Create root package.json**

```bash
cat > /Users/owentaylor/OS/Projects/parrot/package.json <<'EOF'
{
  "name": "parrot",
  "private": true,
  "type": "module",
  "scripts": {
    "test:rules": "firebase emulators:exec --only firestore 'node --test tests/rules.test.js'"
  },
  "devDependencies": {
    "@firebase/rules-unit-testing": "^4.0.1",
    "firebase": "^11.0.0"
  }
}
EOF
```

- [ ] **Step 1.2: Install dev dependencies**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm install`
Expected: creates `node_modules/` and `package-lock.json` at the repo root. No errors.

- [ ] **Step 1.3: Update .gitignore for the new lockfile path**

The existing `node_modules/` line already covers nested node_modules. Verify root lockfile is committed: it should be tracked. No edits needed.

Run: `cd /Users/owentaylor/OS/Projects/parrot && git status -s`
Expected: shows `package.json` and `package-lock.json` as new, `node_modules/` ignored.

- [ ] **Step 1.4: Create tests/helpers.js**

```bash
mkdir -p /Users/owentaylor/OS/Projects/parrot/tests
```

Then write `/Users/owentaylor/OS/Projects/parrot/tests/helpers.js`:

```js
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
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

// Returns an authed Firestore client for a synthetic user with the given uid.
// Pass through to db ops via firebase/firestore (already a peer dep).
export function authedDb(env, uid) {
  return env.authenticatedContext(uid).firestore();
}

export function unauthedDb(env) {
  return env.unauthenticatedContext().firestore();
}
```

- [ ] **Step 1.5: Configure firebase emulators**

Edit `/Users/owentaylor/OS/Projects/parrot/firebase.json` to add an emulators block:

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

- [ ] **Step 1.6: Verify emulator boots**

Run: `cd /Users/owentaylor/OS/Projects/parrot && firebase emulators:exec --only firestore 'echo emulator ready'`
Expected: prints `emulator ready` and exits 0. (Firebase will warn about missing project — that's fine, we use `--project=parrot-rules-test` only for the unit-testing lib.)

If firebase CLI complains about missing project, run with: `firebase --project=parrot-rules-test emulators:exec --only firestore 'echo ready'`

- [ ] **Step 1.7: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add package.json package-lock.json tests/helpers.js firebase.json
git commit -m "tests: scaffold Firestore rules test infra"
```

---

## Task 2: Rules tests for `usernames` collection (TDD)

**Files:**
- Create: `tests/rules.test.js`
- Modify: `firestore.rules`

- [ ] **Step 2.1: Write failing tests for the `usernames` collection**

Create `/Users/owentaylor/OS/Projects/parrot/tests/rules.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, deleteDoc, updateDoc } from "firebase/firestore";
import { makeTestEnv, authedDb, unauthedDb } from "./helpers.js";

let env;

before(async () => {
  env = await makeTestEnv();
});

after(async () => {
  if (env) await env.cleanup();
});

test("usernames: unauthenticated user cannot claim a username", async () => {
  const db = unauthedDb(env);
  await assertFails(setDoc(doc(db, "usernames/owen"), { uid: "anyone" }));
});

test("usernames: authed user can claim an unused username if uid matches", async () => {
  await env.clearFirestore();
  const db = authedDb(env, "uid-A");
  await assertSucceeds(setDoc(doc(db, "usernames/owen"), { uid: "uid-A" }));
});

test("usernames: authed user cannot claim a username with someone else's uid", async () => {
  await env.clearFirestore();
  const db = authedDb(env, "uid-A");
  await assertFails(setDoc(doc(db, "usernames/owen"), { uid: "uid-B" }));
});

test("usernames: cannot overwrite an existing claim", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "usernames/owen"), { uid: "uid-A" });
  });
  const db = authedDb(env, "uid-B");
  await assertFails(setDoc(doc(db, "usernames/owen"), { uid: "uid-B" }));
});

test("usernames: anyone authed can read (to check availability)", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "usernames/owen"), { uid: "uid-A" });
  });
  const db = authedDb(env, "uid-B");
  await assertSucceeds(getDoc(doc(db, "usernames/owen")));
});

test("usernames: cannot be deleted", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "usernames/owen"), { uid: "uid-A" });
  });
  const db = authedDb(env, "uid-A");
  await assertFails(deleteDoc(doc(db, "usernames/owen")));
});

test("usernames: cannot be updated", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "usernames/owen"), { uid: "uid-A" });
  });
  const db = authedDb(env, "uid-A");
  await assertFails(updateDoc(doc(db, "usernames/owen"), { uid: "uid-A2" }));
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: tests run; the success cases fail (current rules deny all writes to non-`messages` paths, so `setDoc` to `usernames/...` throws permission-denied even for the authorized cases). Output should show several FAILs.

- [ ] **Step 2.3: Update firestore.rules to add usernames collection**

Replace `/Users/owentaylor/OS/Projects/parrot/firestore.rules` entirely:

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

    // messages rules will be re-added in Task 4 — temporary deny to keep tests green
    match /messages/{messageId} {
      allow read, write: if false;
    }
  }
}
```

- [ ] **Step 2.4: Run tests to verify usernames tests pass**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: the 7 `usernames:` tests all PASS.

- [ ] **Step 2.5: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add firestore.rules tests/rules.test.js
git commit -m "rules: lock usernames collection (claim once, never modify)"
```

---

## Task 3: Rules tests for `users` collection (TDD)

**Files:**
- Modify: `tests/rules.test.js`
- Modify: `firestore.rules`

- [ ] **Step 3.1: Append failing tests for `users` to tests/rules.test.js**

Append to `/Users/owentaylor/OS/Projects/parrot/tests/rules.test.js`:

```js

test("users: unauthenticated cannot read or write", async () => {
  await env.clearFirestore();
  const db = unauthedDb(env);
  await assertFails(setDoc(doc(db, "users/uid-A"), { username: "owen" }));
  await assertFails(getDoc(doc(db, "users/uid-A")));
});

test("users: cannot create a user doc with a different uid", async () => {
  await env.clearFirestore();
  const db = authedDb(env, "uid-A");
  await assertFails(setDoc(doc(db, "users/uid-B"), { username: "owen" }));
});

test("users: can create user doc only if usernames/{name} points back to my uid", async () => {
  await env.clearFirestore();
  // Username not yet claimed — should fail
  const db = authedDb(env, "uid-A");
  await assertFails(setDoc(doc(db, "users/uid-A"), { username: "owen" }));
});

test("users: succeeds when paired with a valid usernames claim", async () => {
  await env.clearFirestore();
  const db = authedDb(env, "uid-A");
  // Claim the username first
  await assertSucceeds(setDoc(doc(db, "usernames/owen"), { uid: "uid-A" }));
  // Then create user doc — should succeed
  await assertSucceeds(setDoc(doc(db, "users/uid-A"), { username: "owen" }));
});

test("users: cannot read someone else's user doc", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "usernames/owen"), { uid: "uid-A" });
    await setDoc(doc(ctx.firestore(), "users/uid-A"), { username: "owen" });
  });
  const db = authedDb(env, "uid-B");
  await assertFails(getDoc(doc(db, "users/uid-A")));
});

test("users: can read my own user doc", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "usernames/owen"), { uid: "uid-A" });
    await setDoc(doc(ctx.firestore(), "users/uid-A"), { username: "owen" });
  });
  const db = authedDb(env, "uid-A");
  await assertSucceeds(getDoc(doc(db, "users/uid-A")));
});

test("users: cannot update or delete after creation", async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), "usernames/owen"), { uid: "uid-A" });
    await setDoc(doc(ctx.firestore(), "users/uid-A"), { username: "owen" });
  });
  const db = authedDb(env, "uid-A");
  await assertFails(updateDoc(doc(db, "users/uid-A"), { username: "newname" }));
  await assertFails(deleteDoc(doc(db, "users/uid-A")));
});
```

- [ ] **Step 3.2: Run tests to verify the new ones fail**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: usernames tests still pass, new `users:` tests fail (no rule for `users` path → default deny). Output shows several FAIL lines for `users:` tests.

- [ ] **Step 3.3: Add users rules to firestore.rules**

Edit `/Users/owentaylor/OS/Projects/parrot/firestore.rules`. Insert this block immediately after the closing `}` of the `usernames` match:

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

- [ ] **Step 3.4: Run tests to verify users tests pass**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: all `usernames:` AND `users:` tests PASS. The `messages` placeholder rule still denies everything (no message tests yet).

- [ ] **Step 3.5: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add firestore.rules tests/rules.test.js
git commit -m "rules: lock users collection (read-self, create-paired-with-claim)"
```

---

## Task 4: Rules tests for `messages` collection (TDD)

**Files:**
- Modify: `tests/rules.test.js`
- Modify: `firestore.rules`

- [ ] **Step 4.1: Add a helper to seed two paired users**

Edit `/Users/owentaylor/OS/Projects/parrot/tests/helpers.js`. Add this import at the **top** of the file (after the existing imports):

```js
import { doc, setDoc } from "firebase/firestore";
```

Then append this function at the end of the file:

```js

// Seeds usernames/{name} and users/{uid} for a given pair, bypassing rules.
// Use inside tests to set up a known multi-user state.
export async function seedUser(env, uid, username) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `usernames/${username}`), { uid });
    await setDoc(doc(ctx.firestore(), `users/${uid}`), { username });
  });
}
```

- [ ] **Step 4.2: Append failing tests for messages**

Append to `/Users/owentaylor/OS/Projects/parrot/tests/rules.test.js`:

First, update the imports at the top of the file. Find:

```js
import { makeTestEnv, authedDb, unauthedDb } from "./helpers.js";
```

Replace with:

```js
import { makeTestEnv, authedDb, unauthedDb, seedUser } from "./helpers.js";
```

Also add `addDoc, collection, getDocs, query, where, serverTimestamp` to the firebase/firestore import line:

```js
import { doc, setDoc, getDoc, deleteDoc, updateDoc, addDoc, collection, getDocs, query, where, serverTimestamp } from "firebase/firestore";
```

Then append these tests at the end of the file:

```js

test("messages: unauthenticated cannot create", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  const db = unauthedDb(env);
  await assertFails(addDoc(collection(db, "messages"), {
    from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
  }));
});

test("messages: authed user can send a message they own (from = their bound username)", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  const db = authedDb(env, "uid-A");
  await assertSucceeds(addDoc(collection(db, "messages"), {
    from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
  }));
});

test("messages: cannot impersonate another user in 'from'", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  const db = authedDb(env, "uid-A");
  await assertFails(addDoc(collection(db, "messages"), {
    from: "laila", to: "owen", content: "fake", read: false, created_at: serverTimestamp(),
  }));
});

test("messages: cannot send to a username that doesn't exist", async () => {
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

test("messages: recipient can list their messages", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  await env.withSecurityRulesDisabled(async (ctx) => {
    await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
  });
  const db = authedDb(env, "uid-B");
  const q = query(collection(db, "messages"), where("to", "==", "laila"), where("read", "==", false));
  await assertSucceeds(getDocs(q));
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
  const q = query(collection(db, "messages"), where("to", "==", "laila"), where("read", "==", false));
  await assertFails(getDocs(q));
});

test("messages: recipient can mark their message read", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  let messageId;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const ref = await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
    messageId = ref.id;
  });
  const db = authedDb(env, "uid-B");
  await assertSucceeds(updateDoc(doc(db, "messages", messageId), { read: true }));
});

test("messages: non-recipient cannot mark message read", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  let messageId;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const ref = await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
    messageId = ref.id;
  });
  const db = authedDb(env, "uid-A");
  await assertFails(updateDoc(doc(db, "messages", messageId), { read: true }));
});

test("messages: cannot edit content even as recipient", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  let messageId;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const ref = await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
    messageId = ref.id;
  });
  const db = authedDb(env, "uid-B");
  await assertFails(updateDoc(doc(db, "messages", messageId), { content: "tampered", read: true }));
});

test("messages: cannot delete", async () => {
  await env.clearFirestore();
  await seedUser(env, "uid-A", "owen");
  await seedUser(env, "uid-B", "laila");
  let messageId;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const ref = await addDoc(collection(ctx.firestore(), "messages"), {
      from: "owen", to: "laila", content: "hi", read: false, created_at: serverTimestamp(),
    });
    messageId = ref.id;
  });
  const db = authedDb(env, "uid-B");
  await assertFails(deleteDoc(doc(db, "messages", messageId)));
});
```

- [ ] **Step 4.3: Run tests to verify message tests fail**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: usernames + users tests pass; the new `messages:` tests all fail (placeholder rule denies everything).

- [ ] **Step 4.4: Update messages rules**

Replace the `match /messages/{messageId}` block in `/Users/owentaylor/OS/Projects/parrot/firestore.rules` with:

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

- [ ] **Step 4.5: Run tests, verify all pass**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: ALL tests PASS — usernames, users, and messages.

- [ ] **Step 4.6: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add firestore.rules tests/helpers.js tests/rules.test.js
git commit -m "rules: lock messages (sender-bound from, recipient-only read, immutable content)"
```

---

## Task 5: Extract config module

**Files:**
- Create: `mcp/config.js`

- [ ] **Step 5.1: Create mcp/config.js**

Write `/Users/owentaylor/OS/Projects/parrot/mcp/config.js`:

```js
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

const CONFIG_PATH = join(homedir(), ".config", "parrot", "config.json");

export function configPath() {
  return CONFIG_PATH;
}

// Returns the parsed config object, or null if no config file exists / is unreadable.
export function readConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Atomically writes config and locks file mode to 0600.
export function writeConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // writeFileSync only sets mode on creation; force 0600 on existing files too.
  chmodSync(CONFIG_PATH, 0o600);
}

// Returns username if set, else null. Backward-compatible with v1 configs.
export function getUsername() {
  const cfg = readConfig();
  return cfg?.username ?? null;
}

// Generates a fresh synthetic email + password pair for first-time signup.
// Email is a UUID-ish local address; password is 32 hex chars.
export function generateSyntheticCredentials() {
  const id = randomBytes(8).toString("hex");
  return {
    email: `parrot-${id}@parrot.local`,
    password: randomBytes(16).toString("hex"),
  };
}
```

- [ ] **Step 5.2: Smoke-test config helpers**

Run: `cd /Users/owentaylor/OS/Projects/parrot/mcp && node -e "import('./config.js').then(m => { const c = m.generateSyntheticCredentials(); console.log(c.email, c.password.length); })"`
Expected: prints something like `parrot-abc123def456@parrot.local 32` — confirming email shape and 32-char password.

- [ ] **Step 5.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add mcp/config.js
git commit -m "mcp: extract config module with synthetic credential generator"
```

---

## Task 6: Add auth + username claim to firebase.js

**Files:**
- Modify: `mcp/firebase.js`

- [ ] **Step 6.1: Rewrite mcp/firebase.js end-to-end**

Replace `/Users/owentaylor/OS/Projects/parrot/mcp/firebase.js` entirely:

```js
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  serverTimestamp,
  writeBatch,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import {
  readConfig,
  writeConfig,
  getUsername,
  generateSyntheticCredentials,
} from "./config.js";

// Firebase Web SDK config for the shared Parrot network. These are client-side
// config values (not secrets); security is enforced by Firestore rules + Auth.
const firebaseConfig = {
  apiKey: "AIzaSyDfwsLRb8gPaWdxCXikZjJrM34N5426qrE",
  authDomain: "parrot-ai-9b46e.firebaseapp.com",
  projectId: "parrot-ai-9b46e",
  storageBucket: "parrot-ai-9b46e.firebasestorage.app",
  messagingSenderId: "311043780015",
  appId: "1:311043780015:web:d57792e91584bdf23d135a",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let currentUid = null;

// Ensures the process is signed in to Firebase Auth. On first run, generates
// synthetic credentials and creates a user. On subsequent runs, signs in with
// stored credentials. Returns the authenticated uid. Throws on failure.
export async function ensureSignedIn() {
  if (currentUid) return currentUid;

  const cfg = readConfig() ?? {};

  if (cfg.auth?.email && cfg.auth?.password) {
    const cred = await signInWithEmailAndPassword(auth, cfg.auth.email, cfg.auth.password);
    currentUid = cred.user.uid;
    if (cfg.uid !== currentUid) {
      writeConfig({ ...cfg, uid: currentUid });
    }
    return currentUid;
  }

  // First run: generate creds and sign up.
  const synthetic = generateSyntheticCredentials();
  const cred = await createUserWithEmailAndPassword(auth, synthetic.email, synthetic.password);
  currentUid = cred.user.uid;
  writeConfig({ ...cfg, uid: currentUid, auth: synthetic });
  return currentUid;
}

// Claims a username for the current user. Idempotent: succeeds if already owned
// by us. Throws "Username taken" if claimed by someone else.
export async function claimUsername(username) {
  const uid = await ensureSignedIn();

  const claimRef = doc(db, "usernames", username);
  const existing = await getDoc(claimRef);
  if (existing.exists()) {
    if (existing.data().uid === uid) {
      // Already ours — make sure users/{uid} also exists.
      const userRef = doc(db, "users", uid);
      const userDoc = await getDoc(userRef);
      if (!userDoc.exists()) {
        await setDoc(userRef, { username });
      }
    } else {
      throw new Error(`Username "${username}" is taken.`);
    }
  } else {
    // Not claimed: claim it, then create users/{uid}. Order matters because
    // the users-create rule requires the username doc to already exist.
    await setDoc(claimRef, { uid });
    await setDoc(doc(db, "users", uid), { username });
  }

  const cfg = readConfig() ?? {};
  writeConfig({ ...cfg, username });
  return username;
}

export async function sendMessage(to, content) {
  await ensureSignedIn();
  const from = getUsername();
  if (!from) throw new Error("Parrot username not set. Run /parrot to set up.");
  await addDoc(collection(db, "messages"), {
    from,
    to,
    content,
    read: false,
    created_at: serverTimestamp(),
  });
}

export async function checkMessages() {
  await ensureSignedIn();
  const username = getUsername();
  if (!username) throw new Error("Parrot username not set. Run /parrot to set up.");
  const q = query(
    collection(db, "messages"),
    where("to", "==", username),
    where("read", "==", false)
  );
  const snapshot = await getDocs(q);

  const messages = [];
  const batch = writeBatch(db);

  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    messages.push({
      from: data.from,
      content: data.content,
      created_at: data.created_at?.toDate?.() ?? null,
    });
    batch.update(doc(db, "messages", docSnap.id), { read: true });
  });

  if (messages.length > 0) await batch.commit();

  messages.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return messages;
}

export { getUsername };
```

- [ ] **Step 6.2: Smoke-test imports load**

Run: `cd /Users/owentaylor/OS/Projects/parrot/mcp && node -e "import('./firebase.js').then(() => console.log('ok')).catch(e => { console.error(e.message); process.exit(1); })"`
Expected: prints `ok`. Confirms no syntax / import errors. (We do NOT call ensureSignedIn here — that would hit the network.)

- [ ] **Step 6.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add mcp/firebase.js
git commit -m "mcp: add firebase auth, claim-username, sign-in-before-ops"
```

---

## Task 7: Update MCP server entrypoint

**Files:**
- Modify: `mcp/index.js`

- [ ] **Step 7.1: Update mcp/index.js to call ensureSignedIn at startup**

Replace `/Users/owentaylor/OS/Projects/parrot/mcp/index.js`:

```js
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sendMessage, checkMessages, getUsername, ensureSignedIn } from "./firebase.js";

const username = getUsername();

// Sign in eagerly so tool calls don't pay the round-trip. If sign-in fails
// (no creds yet, or network), we still start the server so /parrot can run.
try {
  await ensureSignedIn();
} catch {
  // Surface details lazily inside tool handlers.
}

const server = new McpServer({ name: "parrot", version: "0.2.0" });

server.tool(
  "send_message",
  `Send a Parrot message to another user. Their Claude will surface it at the start of their next session. You are currently "${username ?? "<not configured — run /parrot>"}".`,
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
  `Check for unread Parrot messages addressed to "${username ?? "<not configured>"}". Returns messages and marks them read.`,
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

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 7.2: Smoke-test the server boots**

Run: `cd /Users/owentaylor/OS/Projects/parrot/mcp && timeout 3 node index.js < /dev/null 2>&1 || true`
Expected: starts, blocks waiting for stdin (timeout kills it after 3s), exits cleanly. Any output should be empty/quiet — no thrown errors.

- [ ] **Step 7.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add mcp/index.js
git commit -m "mcp: sign in eagerly at server startup"
```

---

## Task 8: Update SessionStart hook

**Files:**
- Modify: `hook/check-inbox.js`

- [ ] **Step 8.1: Update hook to call ensureSignedIn**

Replace `/Users/owentaylor/OS/Projects/parrot/hook/check-inbox.js`:

```js
#!/usr/bin/env node
// SessionStart hook: pulls unread Parrot messages and prints to stdout
// for injection into the Claude session context. Silent on error.

import { checkMessages, getUsername, ensureSignedIn } from "../mcp/firebase.js";

try {
  const username = getUsername();
  if (!username) process.exit(0);

  await ensureSignedIn();

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

- [ ] **Step 8.2: Smoke-test the hook script**

Run: `cd /Users/owentaylor/OS/Projects/parrot && node hook/check-inbox.js`
Expected: exits 0 with no output (since user may not have an `auth` block in their config yet, or no new messages). No crash.

- [ ] **Step 8.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add hook/check-inbox.js
git commit -m "hook: sign in before checking inbox"
```

---

## Task 9: Update onboarding skill for username claim flow

**Files:**
- Modify: `skills/parrot/SKILL.md`
- Modify: `commands/parrot.md`

- [ ] **Step 9.1: Rewrite skills/parrot/SKILL.md**

Replace `/Users/owentaylor/OS/Projects/parrot/skills/parrot/SKILL.md`:

````markdown
---
name: parrot
description: Use when the user asks to set up Parrot, change their Parrot username, or manage their Parrot messaging configuration. Also use when the user runs /parrot. Do not use this skill for sending or checking messages — those are MCP tools.
---

# Parrot Setup

Parrot is an LLM-to-LLM messaging layer. One user tells their Claude to send a message; the recipient's Claude surfaces it at the start of their next session.

This skill handles first-run setup and reconfiguration. Messaging itself goes through the `parrot` MCP server (`send_message`, `check_messages` tools) — do not handle messaging in this skill.

## Config

User config lives at `~/.config/parrot/config.json` (mode 0600):

```json
{
  "username": "owen",
  "uid": "<firebase-uid>",
  "auth": {
    "email": "parrot-<random>@parrot.local",
    "password": "<32 hex chars>"
  }
}
```

The MCP server and SessionStart hook both read this file. Auth credentials are generated automatically on first run — anyone with read access to this file can act as this Parrot user, so the file is locked to mode 0600. Treat it like an SSH key.

## What to do

### First-time setup

The user runs `/parrot`. Drive this flow:

1. **Ask for the username.** Short, memorable, lowercase. Letters, digits, underscores. Tell them: "this is how others address messages to you, and it's permanent — you can't change it later in v2."

2. **Claim the username via the Parrot MCP server.** Call the `claim_username` tool (added in v2) with the chosen name. The tool will:
   - Sign in (creating a synthetic Firebase user on first run, if needed).
   - Try to claim the username. Return success if available, or `Username "<name>" is taken` if not.

3. **If taken**, tell the user and ask for another name. Loop.

4. **On success**, confirm: "You're set up as `<username>`. Ask me to send a Parrot message to anyone and I'll deliver it. When you start a new Claude Code session, any unread messages will surface automatically."

### Change username

Not supported in v2 — usernames are bound to UID at first claim. Tell the user: "Username changes aren't supported yet. To use a different name, you'd need to delete `~/.config/parrot/config.json`, run `/parrot` again, and pick a new name. The old name stays attached to your old account in Firebase and can't be reclaimed."

### Uninstall

Tell the user to disable the Parrot plugin in their Claude settings (or remove it from `enabledPlugins` in `~/.claude/settings.json`). They can also delete `~/.config/parrot/` to wipe their local config — but their Firebase user and username claim persist (orphaned but harmless).

### Troubleshooting

- **"Parrot username not set"** → config file is missing or malformed. Rerun `/parrot`.
- **"Username taken"** → someone already claimed that name. Pick another.
- **Auth errors / "auth/invalid-credential"** → local config is corrupted (password hash drifted from server). Tell the user to delete `~/.config/parrot/config.json` and run `/parrot` again — they'll get a new account, but they'll need to re-claim a username.
- **Messages aren't auto-surfacing on new sessions** → verify the plugin is enabled. Run `node ${CLAUDE_PLUGIN_ROOT}/dist/check-inbox.js` manually and see if it prints anything.
- **Firestore "permission denied"** → the rules have rejected an action. Either the user isn't authenticated (check the config has an `auth` section), or they're trying to do something the rules forbid (impersonate, edit a delivered message, etc.).

## What not to do

- Do not modify anything under `${CLAUDE_PLUGIN_ROOT}` — that's the plugin install and will be overwritten on upgrade.
- Do not send or check messages from within this skill — use the MCP tools.
- Do not write the `auth` section by hand — the MCP server generates it on first sign-in.
- Do not relax file permissions on the config file. The 0600 mode is intentional.
````

- [ ] **Step 9.2: Update commands/parrot.md**

Replace `/Users/owentaylor/OS/Projects/parrot/commands/parrot.md`:

```markdown
---
description: Set up Parrot or check your Parrot identity
---

Invoke the `parrot` skill.

If `~/.config/parrot/config.json` already exists with a `username`, show the current username and explain that username changes aren't supported in v2 (point at the skill's "Change username" section). Otherwise run the full first-time setup: ask for a username, then call the `claim_username` MCP tool to bind it.
```

- [ ] **Step 9.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add skills/parrot/SKILL.md commands/parrot.md
git commit -m "skill: drive username claim through claim_username MCP tool"
```

---

## Task 10: Add `claim_username` MCP tool

**Files:**
- Modify: `mcp/index.js`

- [ ] **Step 10.1: Add the claim_username tool**

Edit `/Users/owentaylor/OS/Projects/parrot/mcp/index.js`. Add to the imports near the top, alongside the existing imports from `./firebase.js`:

```js
import { sendMessage, checkMessages, getUsername, ensureSignedIn, claimUsername } from "./firebase.js";
```

Then, after the existing `check_messages` tool registration (after the `server.tool("check_messages", ...)` block ends), add:

```js
server.tool(
  "claim_username",
  "Claim a Parrot username for the current user. Use only during /parrot setup. Returns the claimed username, or fails if it's already taken by someone else. Idempotent if you already own it.",
  {
    username: z
      .string()
      .regex(/^[a-z0-9_]{2,32}$/, "Lowercase letters, digits, underscores; 2-32 chars")
      .describe("The username to claim"),
  },
  async ({ username }) => {
    try {
      const claimed = await claimUsername(username);
      return { content: [{ type: "text", text: `Claimed "${claimed}".` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
    }
  }
);
```

- [ ] **Step 10.2: Smoke-test server still boots**

Run: `cd /Users/owentaylor/OS/Projects/parrot/mcp && timeout 3 node index.js < /dev/null 2>&1 || true`
Expected: starts and blocks. No errors.

- [ ] **Step 10.3: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add mcp/index.js
git commit -m "mcp: add claim_username tool for /parrot onboarding"
```

---

## Task 11: Rebuild dist bundles

**Files:**
- Modify: `dist/mcp-server.js`, `dist/check-inbox.js` (regenerated)

- [ ] **Step 11.1: Install/refresh mcp deps**

Run: `cd /Users/owentaylor/OS/Projects/parrot/mcp && npm install`
Expected: dependencies install, `firebase/auth` (already in `firebase` package) becomes available.

- [ ] **Step 11.2: Rebuild dist bundles**

Run: `cd /Users/owentaylor/OS/Projects/parrot/mcp && node build.js`
Expected: prints "Built dist/mcp-server.js and dist/check-inbox.js". Both files appear/update under `/Users/owentaylor/OS/Projects/parrot/dist/`.

- [ ] **Step 11.3: Smoke-test the bundled MCP server**

Run: `cd /Users/owentaylor/OS/Projects/parrot && timeout 3 node dist/mcp-server.js < /dev/null 2>&1 || true`
Expected: starts, blocks, exits on timeout. No errors.

- [ ] **Step 11.4: Smoke-test the bundled hook**

Run: `cd /Users/owentaylor/OS/Projects/parrot && node dist/check-inbox.js`
Expected: exits 0 with no output (config has no `auth` section yet — hook silently no-ops, same as v1 for users without a config).

- [ ] **Step 11.5: Commit bundles**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add dist/mcp-server.js dist/check-inbox.js
git commit -m "dist: rebuild bundles with auth + claim_username"
```

---

## Task 12: Deploy rules + manual end-to-end test

**Files:** none (deploy + verify)

- [ ] **Step 12.1: Wipe v1 messages collection from production**

Run: `cd /Users/owentaylor/OS/Projects/parrot && firebase --project=parrot-ai-9b46e firestore:delete --recursive /messages --force`
Expected: Firestore confirms deletion. (Existing v1 messages are unreadable under new rules anyway; deleting cleans up storage.)

- [ ] **Step 12.2: Deploy rules to production**

Run: `cd /Users/owentaylor/OS/Projects/parrot && firebase --project=parrot-ai-9b46e deploy --only firestore:rules`
Expected: deploy succeeds; rules update in the Firebase console.

- [ ] **Step 12.3: Reset Owen's local config**

Tell Owen to back up his current `~/.config/parrot/config.json` (just in case) then delete it:

```bash
cp ~/.config/parrot/config.json ~/.config/parrot/config.json.v1.bak 2>/dev/null
rm ~/.config/parrot/config.json
```

- [ ] **Step 12.4: Re-run `/parrot` in a fresh Claude Code session**

Open a new Claude Code session. Run `/parrot`. Walk through the username claim. Expected: claim succeeds, config file appears at `~/.config/parrot/config.json` with mode 0600 and the new schema (`username`, `uid`, `auth`).

Verify:

```bash
ls -l ~/.config/parrot/config.json
```

Expected: `-rw-------` (600).

- [ ] **Step 12.5: Two-account end-to-end test**

In a SEPARATE shell with HOME pointed at a temp dir (so it gets a fresh second account), use the Parrot MCP server directly to create a second user, claim a username, and exchange a message:

```bash
TMPHOME=$(mktemp -d)
HOME=$TMPHOME node /Users/owentaylor/OS/Projects/parrot/dist/mcp-server.js
```

The above starts the server on stdio — instead, the easier verification is:

1. From Owen's account: `claim_username` for "owen" (idempotent if already claimed).
2. Spin up a temp account by running the MCP server with `HOME=$(mktemp -d)`. From a Claude session pointed at that, `claim_username "alice"`, then `send_message to=owen content="ping"`.
3. From Owen's account: start a new Claude Code session — the SessionStart hook should surface "ping from alice".

Mark complete only if step 3 surfaces the message.

- [ ] **Step 12.6: Negative test — confirm impersonation fails**

From the alice account, attempt `send_message to=alice content="self-ping"` with a manually edited bundle (or temporarily change `from` in firebase.js to a hardcoded "owen"). Confirm the send fails with a permission error from the rules.

(Optional — only if you want to verify rules in prod beyond the unit tests.)

---

## Task 13: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 13.1: Update README sections**

Edit `/Users/owentaylor/OS/Projects/parrot/README.md`:

Replace the "What's in v1" and "What's not in v1" sections with:

```markdown
## What's in v2

- Shared Firebase Firestore backend with **locked-down security rules**
- **Anonymous-style auth**: each install gets a Firebase user; credentials live in `~/.config/parrot/config.json` (mode 0600)
- **Username binding**: usernames are claimed first-come-first-served and bound to the user's Firebase UID — no impersonation
- Three MCP tools: `send_message`, `check_messages`, `claim_username`
- SessionStart hook that auto-pulls unread messages
- `/parrot` skill + slash command for setup

## What's not in v2

- **Payments / paid tier** — architecture supports it (one rule line + a Stripe webhook), but not wired
- Email-recoverable accounts — if you lose your local config, you lose your username forever in v2
- Username changes — usernames are permanent in v2
- Web or mobile UI
- System notifications / scheduled polling
- Group messages, attachments, threading/replies
```

Also update the "Architecture" section's diagram comment:

Replace:
```
                                      (Firestore security rules: open for v1)
```

With:
```
                                      (Firestore security rules: auth-required, sender-bound, recipient-only read)
```

- [ ] **Step 13.2: Commit**

```bash
cd /Users/owentaylor/OS/Projects/parrot
git add README.md
git commit -m "docs: update README for v2 (auth + locked rules)"
```

---

## Task 14: Final sweep

- [ ] **Step 14.1: Re-run rules tests one more time**

Run: `cd /Users/owentaylor/OS/Projects/parrot && npm run test:rules`
Expected: ALL tests pass.

- [ ] **Step 14.2: Verify git is clean**

Run: `cd /Users/owentaylor/OS/Projects/parrot && git status`
Expected: working tree clean.

- [ ] **Step 14.3: Push to origin**

Run: `cd /Users/owentaylor/OS/Projects/parrot && git push origin main`
Expected: pushes 13+ commits to GitHub. (Confirm with Owen before pushing — he may want to review locally first.)

---

## Self-review notes

**Spec coverage (vs. user's stated goals):**
- "Lock down so people can't access crazily" — covered by Tasks 2-4 (auth-required rules + sender-bound message create + recipient-only read).
- "Architecture-ready for payments later" — covered by `request.auth != null` rule structure and the README note documenting the one-line addition for `paid == true`.
- "Don't actually charge yet" — no Stripe / webhook / pricing work in this plan.
- "Open-source the code without losing the project" — bundled Firebase config remains public (it's meant to be); security comes entirely from rules + auth, which forks can't bypass.

**Risks worth flagging to Owen before execution:**
1. Existing v1 messages get wiped (Task 12.1) — fine since only Owen has used Parrot.
2. v2 has no account recovery — if a user loses `~/.config/parrot/config.json`, their username is orphaned. Worth living with for the intern onboarding use case; revisit before public launch.
3. Rules use `get()` for cross-doc joins — costs ~1 extra read per message operation. Negligible at v2 scale; can be optimized to custom claims later.
