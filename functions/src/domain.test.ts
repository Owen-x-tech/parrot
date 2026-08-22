import { describe, expect, it } from "vitest";
import {
  agentIdentityId,
  contactId,
  conversationId,
  messageId,
  parseMessageInput,
  personIdentityId,
  sha256,
} from "./domain.js";

describe("domain identifiers", () => {
  it("is symmetric for contacts and conversations", () => {
    expect(contactId("a", "b")).toBe(contactId("b", "a"));
    expect(conversationId("person-a", "agent-b")).toBe(conversationId("agent-b", "person-a"));
  });

  it("creates stable, provenance-preserving identity ids", () => {
    expect(personIdentityId("uid")).toBe(personIdentityId("uid"));
    expect(agentIdentityId("uid", "codex")).not.toBe(agentIdentityId("uid", "claude"));
  });

  it("makes idempotent message ids", () => {
    const id = messageId("conversation", "sender", "nonce_123");
    expect(id).toBe(messageId("conversation", "sender", "nonce_123"));
    expect(id).not.toBe(messageId("conversation", "sender", "nonce_124"));
  });

  it("parses bounded messages", () => {
    expect(parseMessageInput({
      conversationId: "c",
      senderIdentityId: "s",
      recipientIdentityId: "r",
      body: " hello ",
      clientNonce: "nonce_123",
    }).body).toBe("hello");
  });

  it("hashes tokens without storing plaintext", () => {
    expect(sha256("secret")).toMatch(/^[a-f0-9]{64}$/);
  });
});
