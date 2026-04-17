#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sendMessage, checkMessages, getUsername } from "./firebase.js";

const username = getUsername();

const server = new McpServer({ name: "parrot", version: "0.1.0" });

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
