import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

export type HarnessState = {
  harness: "codex" | "claude";
  status: "unavailable" | "detected" | "configured" | "restart_required" | "hook_approval_required" | "connected" | "drifted";
  configPath: string | null;
  message: string;
  selected: boolean;
};

export type RuntimeSnapshot = {
  onboarded: boolean;
  authenticated: boolean;
  username: string | null;
  displayName: string | null;
  port: number;
  agents: HarnessState[];
};

export type LocalConversation = {
  id: string;
  peerName: string;
  peerHandle: string;
  preview: string;
  updatedAt: string;
  unread: number;
  peerKind: "person" | "agent";
  canCompose: boolean;
  participantHandles: string[];
};

export type LocalMessage = {
  id: string;
  senderHandle: string;
  body: string;
  createdAt: string;
  direction: "incoming" | "outgoing";
  state: "accepted" | "delivered" | "seen" | "pending" | "failed";
  replyToBody?: string | null;
  recipientHandle?: string | null;
};

export type ContactEndpoint = { id: string; name: string; handle: string; kind: "person" | "agent"; scope: "self" | "contact" };
export type OutboxItem = { id: string; conversationId: string; body: string; clientNonce: string; senderHandle: string; recipientIdentityId?: string | null; attempts: number; replyToId?: string | null };
export type ReceiptItem = { id: string; conversationId: string; identityHandle: string; messageId: string; state: string };

const inTauri = () => "__TAURI_INTERNALS__" in window;

export async function runtimeSnapshot(): Promise<RuntimeSnapshot> {
  if (inTauri()) return invoke("runtime_snapshot");
  return {
    onboarded: new URLSearchParams(location.search).get("onboarding") !== "1",
    authenticated: true,
    username: "owen",
    displayName: "Owen",
    port: 9127,
    agents: [
      { harness: "codex", status: "connected", configPath: "~/.codex/config.toml", message: "Connected", selected: true },
      { harness: "claude", status: "restart_required", configPath: "~/.claude.json", message: "Restart Claude Code", selected: true },
    ],
  };
}

export async function listLocalConversations(): Promise<LocalConversation[]> {
  if (inTauri()) return invoke("list_local_conversations");
  return [
    { id: "c1", peerName: "Maya", peerHandle: "@maya", preview: "I sent it to your Codex.", updatedAt: "9:42 AM", unread: 2, peerKind: "person", canCompose: true, participantHandles: ["@owen", "@maya"] },
    { id: "c2", peerName: "Codex ↔ Claude Code", peerHandle: "@owen/codex ↔ @owen/claude", preview: "The handoff is ready.", updatedAt: "Yesterday", unread: 0, peerKind: "agent", canCompose: false, participantHandles: ["@owen/codex", "@owen/claude"] },
    { id: "c3", peerName: "Theo", peerHandle: "@theo", preview: "That worked perfectly, thanks!", updatedAt: "Mon", unread: 0, peerKind: "person", canCompose: true, participantHandles: ["@owen", "@theo"] },
  ];
}

export async function getLocalMessages(conversationId: string): Promise<LocalMessage[]> {
  if (inTauri()) return invoke("get_local_messages", { conversationId });
  return conversationId === "c1" ? [
    { id: "m1", senderHandle: "@maya", body: "Could your Codex look over the onboarding copy?", createdAt: "9:38 AM", direction: "incoming", state: "seen" },
    { id: "m2", senderHandle: "@owen", body: "Absolutely. Send it to @owen/codex and I’ll see it here too.", createdAt: "9:40 AM", direction: "outgoing", state: "seen" },
    { id: "m3", senderHandle: "@maya", body: "I sent it to your Codex.", createdAt: "9:42 AM", direction: "incoming", state: "delivered", replyToBody: "Send it to @owen/codex" },
  ] : [];
}

export async function sendLocalMessage(conversationId: string, body: string, replyToId?: string | null, replyToBody?: string | null): Promise<LocalMessage> {
  if (inTauri()) return invoke("send_local_message", { conversationId, body, replyToId: replyToId ?? null, replyToBody: replyToBody ?? null });
  return { id: crypto.randomUUID(), senderHandle: "@owen", body, createdAt: "Now", direction: "outgoing", state: "pending", replyToBody };
}

export async function beginBrowserAuth(): Promise<void> {
  if (inTauri()) {
    if ((await runtimeSnapshot()).authenticated) return;
    let complete!: () => void;
    let fail!: (cause: Error) => void;
    const callback = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    const [unlistenComplete, unlistenError] = await Promise.all([
      listen("parrot-auth-complete", complete),
      listen<string>("parrot-auth-error", () => fail(new Error("Parrot received the browser return but could not finish signing in. Please try again."))),
    ]);
    try {
      await invoke("begin_browser_auth");
      const polling = (async () => {
        const deadline = Date.now() + 2 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 600));
          if ((await runtimeSnapshot()).authenticated) return;
        }
        throw new Error("Parrot did not receive the browser return. Try again, then choose Open Parrot when your browser asks.");
      })();
      await Promise.race([callback, polling]);
    } finally {
      unlistenComplete();
      unlistenError();
    }
  }
}

export async function completeOnboarding(username: string, displayName: string): Promise<void> {
  if (inTauri()) await invoke("complete_onboarding", { username, displayName });
}

export async function configureAgents(harnesses: string[]): Promise<HarnessState[]> {
  if (inTauri()) return invoke("configure_agents", { harnesses });
  return (await runtimeSnapshot()).agents;
}

export async function enableBackground(): Promise<void> {
  if (inTauri()) {
    if (!await isPermissionGranted()) await requestPermission();
    await invoke("enable_background");
  }
}

export async function pendingOutbox(): Promise<OutboxItem[]> { return inTauri() ? invoke("pending_outbox") : []; }
export async function resolveOutbox(id: string, delivered: boolean, error?: string): Promise<void> { if (inTauri()) await invoke("resolve_outbox", { id, delivered, error: error ?? null }); }
export async function cacheCloudConversations(items: LocalConversation[]): Promise<void> { if (inTauri()) await invoke("cache_cloud_conversations", { items }); }
export async function cacheCloudEndpoints(items: ContactEndpoint[]): Promise<void> { if (inTauri()) await invoke("cache_cloud_endpoints", { items }); }
export async function cacheCloudMessages(conversationId: string, items: LocalMessage[]): Promise<void> { if (inTauri()) await invoke("cache_cloud_messages", { conversationId, items }); }
export async function pendingReceipts(): Promise<ReceiptItem[]> { return inTauri() ? invoke("pending_receipts") : []; }
export async function resolveReceipt(id: string, delivered: boolean): Promise<void> { if (inTauri()) await invoke("resolve_receipt", { id, delivered }); }
