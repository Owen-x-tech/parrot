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
