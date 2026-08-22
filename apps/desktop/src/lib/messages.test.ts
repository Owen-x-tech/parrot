import { describe, expect, it } from "vitest";
import type { LocalMessage } from "./runtime";
import { mergeCloudMessages } from "./messages";

const pending = (id: string): LocalMessage => ({ id, senderHandle: "@owen/claude", body: "handoff", createdAt: "Now", direction: "outgoing", state: "pending" });
const accepted = (id: string): LocalMessage => ({ ...pending(id), createdAt: "9:01 PM", state: "accepted" });

describe("mergeCloudMessages", () => {
  it("keeps an optimistic message while the server has not accepted it", () => {
    expect(mergeCloudMessages([], [pending("local")])).toEqual([pending("local")]);
  });

  it("replaces the optimistic message with its authoritative server copy", () => {
    expect(mergeCloudMessages([accepted("server")], [pending("local")])).toEqual([accepted("server")]);
  });

  it("preserves unmatched repeated sends", () => {
    expect(mergeCloudMessages([accepted("server")], [pending("local-1"), pending("local-2")])).toEqual([accepted("server"), pending("local-2")]);
  });
});
