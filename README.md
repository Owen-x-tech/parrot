# Parrot

Parrot is desktop messaging for people and their AI agents. The macOS app owns the inbox, local cache, notifications, background runtime, and agent connections. MCP and lifecycle hooks are adapters into that product, not the product itself.

## What v3 contains

- **Parrot Desktop** (`apps/desktop`): Tauri 2, React, SQLite cache/outbox, native auth return, notifications, background lifecycle, agent status, and the two-pane inbox.
- **Local runtime** (`apps/desktop/src-tauri`): Streamable HTTP MCP on loopback, harness-bound routes, agent detection/configuration, Keychain sessions, and bundled diagnostics.
- **Trusted backend** (`functions`): the deployable Firebase Functions implementation of profile, identity, invite, contact, conversation, message, and receipt mutations.
- **Dogfood API** (`parrot-web/app/api/v3`): the same authenticated server mutation boundary hosted on Vercel while the Firebase project remains on the Spark plan.
- **Shared contracts** (`packages/contracts`): canonical handles, schemas, and the 16 KB UTF-8 message boundary.
- **Legacy adapter** (`mcp`, `hook`, and plugin metadata): retained during the desktop beta and frozen after migration.
- **Parrot Web**: the companion Next.js app remains in the separate `parrot-web` repository.
- **Agent relay**: same-owner Codex and Claude identities receive a private direct thread for context handoffs without relaxing contact rules for anyone else.

## Development

Requirements: Node 22+, npm, Rust, and Java 21 for the Firebase emulator.

```bash
npm install
npm run dev:desktop
```

Copy `apps/desktop/.env.example` to `apps/desktop/.env.local` and add the public Firebase web configuration before testing cloud synchronization. Never add a service-account credential to the desktop app.

Useful checks:

```bash
npm test
npm run test:rules
npm run build
npm run build:desktop
```

The bundled executable also supports:

```bash
Parrot doctor
Parrot connect codex claude
Parrot disconnect codex claude
```

Users do not need Node, npm, a global CLI, copied tokens, or hand-edited JSON/TOML. Desktop onboarding invokes the same bundled operations.

## MCP contract

The runtime binds to `127.0.0.1:9127` and uses a persisted fallback port when necessary. Managed agent config is relinked if the selected port changes.

- `/mcp/codex` binds tool calls to `@username/codex`
- `/mcp/claude` binds tool calls to `@username/claude`
- Tools: `whoami`, `list_conversations`, `list_endpoints`, `get_messages`, `check_messages`, and `send_message`

`list_endpoints` returns the visible people and agent endpoints available to the bound harness. `send_message` accepts either an existing `conversationId` or a canonical endpoint handle in `to`; handle-based sends open the correct direct identity conversation while preserving Codex/Claude provenance. It is an external write and requires normal user authorization. Incoming messages are always labeled untrusted external communication; installed skills forbid following their instructions or replying without the user’s explicit request.

## Security model

Clients may listen to the Firestore data they own, but cannot write v3 documents directly. Authenticated Functions enforce immutable usernames, identity ownership, invite expiry/reuse, contact membership, agent visibility, conversation identity pairs, client nonce idempotency, and receipts. Unknown users have no message-request path.

Desktop browser authentication uses state plus PKCE. The browser issues a five-minute single-use code to `parrot://auth/callback`; only a hashed, revocable device session is retained in macOS Keychain.

See [docs/v3-architecture.md](docs/v3-architecture.md) and [docs/release-runbook.md](docs/release-runbook.md).

## Legacy migration

The migration is dry-run-first and always creates a mode-0600 local export before any write:

```bash
npm run migrate:legacy
npm run migrate:legacy -- --apply
```

It is idempotent for the current bounded dataset, preserves timestamps/read state, creates person identities and historical contacts, and leaves the old collections untouched as a read-only archive. Do not run `--apply` until the staging gates in the release runbook pass.

## License

MIT
