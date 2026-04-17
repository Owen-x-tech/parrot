#!/usr/bin/env node
// SessionStart hook: pulls unread Parrot messages and prints them to stdout
// for injection into the Claude session context. Silent on error so it
// never blocks session startup.

import { checkMessages, USERNAME } from "../mcp/firebase.js";

try {
  if (!USERNAME) process.exit(0);

  const messages = await checkMessages();
  if (messages.length === 0) process.exit(0);

  const lines = [
    `=== Parrot Inbox ===`,
    `You have ${messages.length} unread message${messages.length === 1 ? "" : "s"} addressed to "${USERNAME}". These were just delivered — surface them naturally to the user.`,
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
  // Silent fail — never block session startup.
  process.exit(0);
}
