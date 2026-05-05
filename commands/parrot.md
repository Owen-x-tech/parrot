---
description: Pair this Claude with your Parrot account
---

Invoke the `parrot` skill.

If `~/.config/parrot/config.json` already has a `refresh_token`, the user is already paired — show their current username and explain re-pairing only needs to happen on a new device or after revocation.

Otherwise: walk them through pairing. Direct them to https://parrot-web-five.vercel.app/ to sign up + claim a username, then call the `pair` MCP tool with the pairing string they paste back.
