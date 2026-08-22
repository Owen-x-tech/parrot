# Parrot v3 release runbook

> Dogfood note: the current Firebase project is on Spark, so callable Functions cannot be deployed until Blaze billing is explicitly enabled. The authenticated `/api/v3/*` routes in Parrot Web provide the same server-only mutation boundary for the current build. Firestore rules and indexes deploy independently and are live.

No step in this document is implied by a build. Production mutation and distribution remain explicit release actions.

## 1. Emulator and staging

- Run TypeScript, React, Rust, and Firestore rules tests.
- Deploy Functions, rules, and indexes to the staging Firebase project.
- Verify direct writes fail, strangers cannot read, hidden agents cannot be addressed, accepted contacts can exchange messages, and unrelated conversations remain unreadable.
- Exercise PKCE reuse, expiry, state mismatch, session refresh, and revocation.
- Fill `apps/desktop/.env.local` with staging public Firebase config and verify realtime listeners plus offline outbox retry.

## 2. Owen-only dogfood

- Build the unsigned local `.app`; test authentication, both managed harnesses, restart/approval status, background close, autostart, Keychain storage, native notifications, and port fallback.
- Confirm incoming content surfaces at SessionStart/UserPromptSubmit but never triggers autonomous work.
- Test `doctor`, drift repair, selective disconnect, backup preservation, and reinstall.

## 3. Two-account invited beta

- Create a single-use invite, accept from a second account, exchange person-to-person and person-to-agent messages, remove the contact, and verify future sends are blocked while history remains.
- Verify delivered/seen wording for person and agent endpoints.
- Test laptop/desktop layouts, keyboard operation, VoiceOver labels, reduced motion, dynamic text, and WCAG AA contrast.

## 4. Legacy export and migration

- Create a Firebase-managed backup and run `npm run migrate:legacy` without `--apply`.
- Review the local mode-0600 export and counts. Resolve every unmapped username.
- Run against staging with `--apply`, compare every source message timestamp/read flag, then repeat to prove idempotency.
- Run the production export and apply in a separately authorized maintenance window.
- Leave legacy collections unchanged and deploy read-only rules. Keep the old pairing endpoint during beta, then return a documented upgrade response. Do not dual-write.

## 5. Signed release and web cutover

- Configure Apple Developer signing/notarization outside the repository.
- Build the distributable with `npm run tauri:build:dmg -w @parrot/desktop`; the normal development bundle intentionally targets `.app` only.
- Produce universal or separate Apple silicon/Intel artifacts, notarize, staple, and test on a clean Mac.
- Publish checksums and point `/download` at the signed artifact.
- Cut the web account experience from legacy pairing to desktop download only after beta clients are available.

## Deferred

Windows packaging, groups, attachments, calls, typing indicators, autonomous bots, and web inbox messaging are not v1 release blockers. Platform-specific behavior must remain behind adapters.
