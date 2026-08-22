import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { AgentLogo } from "./components/AgentLogo";
import { Inbox } from "./components/Inbox";
import { Onboarding } from "./components/Onboarding";
import * as cloud from "./lib/cloud";
import * as runtime from "./lib/runtime";

vi.mock("./lib/runtime", async () => {
  const actual = await vi.importActual<typeof import("./lib/runtime")>("./lib/runtime");
  return { ...actual, runtimeSnapshot: async () => ({ onboarded: false, authenticated: false, username: null, displayName: null, port: 9127, agents: [] }) };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("starts with one clear onboarding promise", async () => {
  render(<App />);
  expect(await screen.findByRole("heading", { name: /messages for people/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /start messaging/i })).toBeInTheDocument();
});

it("resumes after a completed browser callback", () => {
  render(<Onboarding initialAgents={[]} initialAuthenticated onDone={() => undefined} />);
  expect(screen.getByRole("heading", { name: /choose your permanent name/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /continue in browser/i })).not.toBeInTheDocument();
});

it("uses recognizable agent artwork instead of letter placeholders", () => {
  render(<><AgentLogo harness="codex" /><AgentLogo harness="claude" /></>);
  expect(screen.getByRole("img", { name: "Codex logo" })).toHaveAttribute("src", "/codex-icon.png");
  expect(screen.getByRole("img", { name: "Claude Code logo" })).toHaveAttribute("src", "/claude-icon.png");
});

it("keeps the settings drawer mounted so it can transition in and out", () => {
  render(<Inbox username="owen" agents={[]} />);
  const dialog = screen.getByRole("dialog", { name: "Parrot settings", hidden: true });
  expect(dialog.parentElement).toHaveAttribute("aria-hidden", "true");
  expect(dialog.parentElement).not.toHaveClass("open");

  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  expect(dialog.parentElement).toHaveAttribute("aria-hidden", "false");
  expect(dialog.parentElement).toHaveClass("open");

  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  expect(dialog.parentElement).toHaveAttribute("aria-hidden", "true");
  expect(dialog.parentElement).not.toHaveClass("open");
});

it("does not let a late local cache replace an authoritative cloud snapshot", async () => {
  let resolveLocal!: (messages: runtime.LocalMessage[]) => void;
  const localMessages = new Promise<runtime.LocalMessage[]>((resolve) => { resolveLocal = resolve; });
  vi.spyOn(runtime, "listLocalConversations").mockResolvedValue([{
    id: "relay", peerName: "Codex ↔ Claude Code", peerHandle: "@owen/codex ↔ @owen/claude", preview: "", updatedAt: "", unread: 0,
    peerKind: "agent", canCompose: false, participantHandles: ["@owen/codex", "@owen/claude"],
  }]);
  vi.spyOn(runtime, "getLocalMessages").mockReturnValue(localMessages);
  vi.spyOn(cloud, "subscribeCloudMessages").mockImplementation(async (_conversationId, onChange) => {
    onChange([{ id: "cloud", senderHandle: "@owen/claude", body: "authoritative cloud history", createdAt: "4:33 PM", direction: "outgoing", state: "accepted" }]);
    return () => undefined;
  });

  render(<Inbox username="owen" agents={[]} />);
  expect(await screen.findByText("authoritative cloud history")).toBeInTheDocument();
  await act(async () => resolveLocal([{ id: "local", senderHandle: "@owen/claude", body: "stale local history", createdAt: "4:32 PM", direction: "outgoing", state: "accepted" }]));
  expect(screen.getByText("authoritative cloud history")).toBeInTheDocument();
  expect(screen.queryByText("stale local history")).not.toBeInTheDocument();
});
