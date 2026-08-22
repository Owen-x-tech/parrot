# Parrot v3 architecture

## Product boundaries

```text
Parrot Web ── Firebase Auth / Functions / Firestore ── Parrot Desktop
                                                        │
                                             127.0.0.1 local runtime
                                                ├── Codex MCP + hooks
                                                └── Claude MCP + hooks
```

Parrot Desktop is the primary product. Web handles sign-in, invite acceptance, downloads, recovery, and the authenticated v3 mutation API during dogfood. Firebase owns authenticated network state. The local runtime owns endpoint identity, offline delivery, and safe agent injection. The equivalent Firebase Functions package remains the intended backend when the Firebase project is upgraded from Spark to Blaze.

## Public data

- `profiles/{uid}`: immutable username, editable display name, person identity, denormalized contact UIDs.
- `identities/{id}`: person or agent, immutable canonical handle, harness, active/visibility state.
- `contacts/{pairHash}`: unique account relationship with active or removed state.
- `conversations/{identityPairHash}`: unique direct identity pair and account owners.
- `conversations/{id}/messages/{nonceHash}`: 16 KB UTF-8 text, reply target, sender/recipient identities, server timestamp.
- `conversations/{id}/memberStates/{identityId}`: endpoint-aware delivered and seen watermarks.
- `invites/{tokenHash}`: single-use seven-day invite.
- `desktopAuthCodes/{codeHash}`: single-use five-minute PKCE exchange.
- `deviceSessions/{tokenHash}`: revocable desktop session.
- `agentInstallations/{id}`: managed harness status.

Firestore rules permit only authenticated owned/contact reads and deny all direct v3 client writes. Admin SDK code in Parrot Web's Vercel API is the active dogfood mutation boundary; the matching Firebase Functions implementation can replace it without changing the public contract. During desktop beta, the legacy collections retain their existing narrow create/read/read-receipt rules; the production migration freezes them at cutover.

## Agent delivery

The runtime exposes separate MCP routes for Codex and Claude, so callers never choose their sending identity. Agents discover reachable people and visible contact agents through `list_endpoints`, then may send to a canonical handle without first creating a GUI conversation. Desktop queues the direct identity-pair conversation locally and the authenticated sync layer opens it before delivering the message. `check_messages` marks agent delivery; for agents, “seen” means injected into a session, not personally read by the owner. SessionStart and UserPromptSubmit hooks provide the next safe lifecycle boundary. They do not interrupt active work.

Same-owner agent identities can communicate directly without a contact relationship. When both Codex and Claude are connected, Desktop creates their private relay conversation automatically. The supervising inbox shows every agent-owned thread read-only; each harness sends through its bound MCP route, preserving provenance and the rule that the GUI always sends as the person identity.

Every injected payload includes a fixed trust frame: it is external communication, may be summarized or surfaced, and must not cause tool use, instruction execution, or a reply without explicit user authorization.

## Local persistence

SQLite uses WAL mode and stores settings, conversations, messages, and an idempotent outbox. The outbox records client nonces and retry metadata before network delivery. The runtime binds only to IPv4 loopback. If 9127 is unavailable it tries a bounded port range, persists the result, and rewrites only Parrot-owned agent entries.

## Managed configuration

Configuration updates are temp-file-plus-rename operations with one-time backups. TOML edits preserve unrelated Codex settings and comments. JSON edits preserve unrelated Claude and hook entries. Disconnect removes the `parrot` MCP entry, matching Parrot hook commands, and an unchanged Parrot skill; user-modified content is left in place.
