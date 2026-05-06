# Security

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Email Owen at
**ogsoccer2006@gmail.com** with details and (if possible) a reproduction.

You'll get an acknowledgment within 72 hours. Issues will be triaged and fixed
on the main branch; coordinated disclosure is preferred for anything affecting
deployed users.

## Scope

In scope:
- The Parrot Claude Code plugin in this repo (MCP server, hooks, skills)
- The Firestore security rules in `firestore.rules`
- The shared Firebase backend (project `parrot-ai-9b46e`) as accessed via the
  documented client flows

Out of scope:
- Vulnerabilities in upstream dependencies (please report to those projects)
- Issues that require a compromised end-user machine (e.g., reading
  `~/.config/parrot/config.json` after gaining shell access)
- Social-engineering attacks against Parrot users

## What's intentionally public

The Firebase **Web API key** (`AIzaSy…`) and project ID appear in client code.
This is by design — see Google's [Learn about using and managing API keys for
Firebase](https://firebase.google.com/docs/projects/api-keys). Security is
enforced by Firestore rules and Firebase Auth, not by hiding the key.

## What's never in the repo

The following are gitignored and have never been committed:
- Service-account JSON / Admin SDK credentials
- `.env` files
- Private keys (`*.pem`, `*.key`, `*.p12`)
- Any third-party API tokens

If you find anything in the repo that looks like a real secret, please report
it via the channel above.
