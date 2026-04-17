#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sendMessage, checkMessages } from "./firebase.js";

const server = new McpServer({ name: "parrot", version: "1.0.0" });

server.tool(
  "send_message",
  "Send a message to another Parrot user. Their Claude will deliver it.",
  {
    to: z.string().describe("Username of the recipient"),
    content: z.string().describe("Message to send"),
  },
  async ({ to, content }) => {
    try {
      await sendMessage(to, content);
      return { content: [{ type: "text", text: `Message sent to ${to}.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to send: ${err.message}` }] };
    }
  }
);

server.tool(
  "check_messages",
  "Check for unread Parrot messages for a user.",
  {
    username: z.string().describe("Username to check messages for"),
  },
  async ({ username }) => {
    try {
      const messages = await checkMessages(username);
      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No unread messages." }] };
      }
      const text = messages.map((m) => `From ${m.from}:\n${m.content}`).join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to check messages: ${err.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
