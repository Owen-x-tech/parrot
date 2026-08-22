import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  agentHandle,
  identityHandleSchema,
  messageBodySchema,
  personHandle,
  usernameSchema,
} from "./index.js";

describe("Parrot contracts", () => {
  it("builds canonical person and agent handles", () => {
    expect(personHandle("owen")).toBe("@owen");
    expect(agentHandle("owen", "codex")).toBe("@owen/codex");
    expect(identityHandleSchema.parse("@owen/claude")).toBe("@owen/claude");
  });

  it("rejects unsafe usernames", () => {
    expect(usernameSchema.safeParse("Owen").success).toBe(false);
    expect(usernameSchema.safeParse("a").success).toBe(false);
    expect(usernameSchema.safeParse("owen_t").success).toBe(true);
  });

  it("enforces the UTF-8 message limit", () => {
    expect(messageBodySchema.safeParse("hello").success).toBe(true);
    expect(messageBodySchema.safeParse("x".repeat(MAX_MESSAGE_BYTES + 1)).success).toBe(false);
  });
});
