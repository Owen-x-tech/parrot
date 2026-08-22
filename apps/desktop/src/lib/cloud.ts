import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInWithCustomToken, type Auth } from "firebase/auth";
import { collection, doc, getDoc, getDocs, getFirestore, limit, onSnapshot, orderBy, query, where, type DocumentData, type Firestore, type QuerySnapshot, type Unsubscribe } from "firebase/firestore";
import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import type { ContactEndpoint, LocalConversation, LocalMessage } from "./runtime";
import { cacheCloudConversations, cacheCloudEndpoints, cacheCloudMessages, pendingOutbox, pendingReceipts, resolveOutbox, resolveReceipt } from "./runtime";

type Cloud = { app: FirebaseApp; auth: Auth; db: Firestore };
type FirebaseConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
};
export type { ContactEndpoint } from "./runtime";
let cloud: Cloud | null = null;
let resolvedConfig: FirebaseConfig | null = null;

function webUrl() {
  return import.meta.env.VITE_PARROT_WEB_URL || "https://parrot-web-five.vercel.app";
}

async function config(): Promise<FirebaseConfig | null> {
  if (resolvedConfig) return resolvedConfig;
  const values = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };
  if (Object.values(values).every(Boolean)) {
    resolvedConfig = values as FirebaseConfig;
    return resolvedConfig;
  }

  try {
    const response = await fetch(`${webUrl()}/api/firebase-config`, { cache: "no-store" });
    if (!response.ok) return null;
    const remote = await response.json() as Partial<FirebaseConfig>;
    const required = [remote.apiKey, remote.authDomain, remote.projectId, remote.storageBucket, remote.messagingSenderId, remote.appId];
    if (!required.every((value) => typeof value === "string" && value.length > 0)) return null;
    resolvedConfig = remote as FirebaseConfig;
    return resolvedConfig;
  } catch {
    return null;
  }
}

export async function connectCloud(): Promise<boolean> {
  const firebaseConfig = await config();
  if (!firebaseConfig || !("__TAURI_INTERNALS__" in window)) return false;
  if (!cloud) {
    const app = initializeApp(firebaseConfig);
    cloud = { app, auth: getAuth(app), db: getFirestore(app) };
  }
  if (!cloud.auth.currentUser) {
    const customToken = await invoke<string>("refresh_cloud_token");
    await signInWithCustomToken(cloud.auth, customToken);
  }
  return true;
}

async function callV3<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  if (!cloud?.auth.currentUser) throw new Error("Sign in to Parrot first.");
  const request = "__TAURI_INTERNALS__" in window ? (await import("@tauri-apps/plugin-http")).fetch : fetch;
  const response = await request(`${webUrl()}/api/v3/${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await cloud.auth.currentUser.getIdToken()}` },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Parrot could not complete that request.");
  return result as T;
}

export async function subscribeCloudConversations(onChange: (items: LocalConversation[]) => void): Promise<Unsubscribe | null> {
  if (!await connectCloud() || !cloud?.auth.currentUser) return null;
  const uid = cloud.auth.currentUser.uid;
  const conversations = query(collection(cloud.db, "conversations"), where("ownerUids", "array-contains", uid), orderBy("lastMessageAt", "desc"), limit(100));
  return onSnapshot(conversations, async (snapshot) => {
    const items = await Promise.all(snapshot.docs.map(async (conversation) => {
      const participantIds = conversation.get("participantIdentityIds") as string[];
      const identities = await Promise.all(participantIds.map((id) => getDoc(doc(cloud!.db, "identities", id))));
      const personIdentityId = (await getDoc(doc(cloud!.db, "profiles", uid))).get("personIdentityId") as string;
      const isAgentThread = !participantIds.includes(personIdentityId);
      const isAgentRelay = isAgentThread
        && identities.every((identity) => identity.get("ownerUid") === uid && identity.get("kind") === "agent");
      const peer = identities.find((identity) => identity.get("ownerUid") !== uid) ?? identities.find((identity) => identity.id !== personIdentityId) ?? identities[0];
      const ownedIds = identities.filter((identity) => identity.get("ownerUid") === uid).map((identity) => identity.id);
      const ownedStates = await Promise.all(ownedIds.map((id) => getDoc(doc(cloud!.db, "conversations", conversation.id, "memberStates", id))));
      const relayNames = identities.map((identity) => identity.get("displayName") ?? "Agent").join(" ↔ ");
      const relayHandles = identities.map((identity) => identity.get("handle") ?? "").join(" ↔ ");
      const participantHandles = identities.map((identity) => String(identity.get("handle") ?? ""));
      return {
        id: conversation.id,
        peerName: isAgentRelay ? relayNames : peer.get("displayName") ?? "Parrot contact",
        peerHandle: isAgentRelay ? relayHandles : peer.get("handle") ?? "",
        preview: conversation.get("lastMessagePreview") ?? "",
        updatedAt: conversation.get("lastMessageAt")?.toDate?.().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) ?? "",
        unread: ownedStates.reduce((sum, state) => sum + Number(state.get("unreadCount") ?? 0), 0),
        peerKind: (peer.get("kind") === "agent" ? "agent" : "person") as "agent" | "person",
        canCompose: !isAgentThread,
        participantHandles,
      };
    }));
    await cacheCloudConversations(items);
    onChange(items);
  });
}

export async function subscribeCloudMessages(conversationId: string, onChange: (items: LocalMessage[]) => void): Promise<Unsubscribe | null> {
  if (!await connectCloud() || !cloud?.auth.currentUser) return null;
  const uid = cloud.auth.currentUser.uid;
  const [profile, conversation] = await Promise.all([getDoc(doc(cloud.db, "profiles", uid)), getDoc(doc(cloud.db, "conversations", conversationId))]);
  const ownIds = new Set<string>([profile.get("personIdentityId")]);
  const participantIds = conversation.get("participantIdentityIds") as string[];
  const isAgentRelay = !participantIds.includes(profile.get("personIdentityId") as string)
    && (conversation.get("ownerUids") as string[]).length === 1;
  const viewerIdentityId = participantIds.includes(profile.get("personIdentityId")) ? profile.get("personIdentityId") as string : null;
  const messageQuery = query(collection(cloud.db, "conversations", conversationId, "messages"), orderBy("createdAt", "asc"), limit(100));
  let receivedInitialSnapshot = false;
  let latestSnapshot: QuerySnapshot<DocumentData> | null = null;
  async function render(snapshot: QuerySnapshot<DocumentData>, handleArrival: boolean) {
    const handles = new Map<string, string>();
    await Promise.all(participantIds.map(async (id) => {
      const identity = await getDoc(doc(cloud!.db, "identities", id));
      handles.set(id, identity.get("handle") ?? "");
      if (identity.get("ownerUid") === uid) ownIds.add(id);
    }));
    const memberStates = await getDocs(collection(cloud!.db, "conversations", conversationId, "memberStates"));
    const stateByIdentity = new Map(memberStates.docs.map((state) => [state.id, state]));
    const bodyById = new Map(snapshot.docs.map((message) => [message.id, String(message.get("body"))]));
    const items: LocalMessage[] = snapshot.docs.map((message) => ({
      id: message.id,
      senderHandle: handles.get(message.get("senderIdentityId")) ?? "",
      recipientHandle: handles.get(message.get("recipientIdentityId")) ?? "",
      body: message.get("body"),
      createdAt: message.get("createdAt")?.toDate?.().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) ?? "Sending…",
      direction: isAgentRelay
        ? (message.get("senderIdentityId") === participantIds[0] ? "incoming" : "outgoing")
        : (ownIds.has(message.get("senderIdentityId")) ? "outgoing" : "incoming"),
      state: (() => {
        if (!ownIds.has(message.get("senderIdentityId"))) return "accepted";
        const recipientState = stateByIdentity.get(message.get("recipientIdentityId"));
        const sentAt = message.get("createdAt")?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
        if ((recipientState?.get("lastSeenAt")?.toMillis?.() ?? 0) >= sentAt) return "seen";
        if ((recipientState?.get("lastDeliveredAt")?.toMillis?.() ?? 0) >= sentAt) return "delivered";
        return "accepted";
      })(),
      replyToBody: message.get("replyToId") ? bodyById.get(message.get("replyToId")) ?? "Earlier message" : null,
    }));
    await cacheCloudMessages(conversationId, items);
    onChange(items);
    const last = snapshot.docs.at(-1);
    if (handleArrival && receivedInitialSnapshot && last && !ownIds.has(last.get("senderIdentityId")) && await isPermissionGranted()) {
      sendNotification({ title: handles.get(last.get("senderIdentityId")) ?? "New Parrot message", body: String(last.get("body")).slice(0, 180) });
    }
    if (handleArrival) receivedInitialSnapshot = true;
    if (handleArrival && last && viewerIdentityId && last.get("recipientIdentityId") === viewerIdentityId) {
      void callV3("updateMemberState", { conversationId, identityId: viewerIdentityId, messageId: last.id, state: "seen" });
    }
  }
  const messageUnsubscribe = onSnapshot(messageQuery, (snapshot) => { latestSnapshot = snapshot; void render(snapshot, true); });
  const stateUnsubscribe = onSnapshot(collection(cloud.db, "conversations", conversationId, "memberStates"), () => { if (latestSnapshot) void render(latestSnapshot, false); });
  return () => { messageUnsubscribe(); stateUnsubscribe(); };
}

export async function sendCloudMessage(conversationId: string, body: string, replyToId: string | null = null, clientNonce = crypto.randomUUID().replaceAll("-", ""), senderHandle?: string, recipientIdentityId?: string | null): Promise<boolean> {
  if (!await connectCloud() || !cloud?.auth.currentUser) return false;
  const uid = cloud.auth.currentUser.uid;
  const profile = await getDoc(doc(cloud.db, "profiles", uid));
  let senderIdentityId = profile.get("personIdentityId") as string;
  if (senderHandle) {
    const identities = await getDocs(query(collection(cloud.db, "identities"), where("ownerUid", "==", uid)));
    const sender = identities.docs.find((identity) => identity.get("handle") === senderHandle);
    if (!sender) throw new Error("The sending identity is unavailable.");
    senderIdentityId = sender.id;
  }
  let recipientId = recipientIdentityId ?? null;
  if (recipientId) {
    const opened = await callV3<{ conversationId: string }>("openConversation", { senderIdentityId, recipientIdentityId: recipientId });
    if (opened.conversationId !== conversationId) throw new Error("Parrot opened an unexpected conversation.");
  } else {
    const conversation = await getDoc(doc(cloud.db, "conversations", conversationId));
    const participantIdentityIds = conversation.get("participantIdentityIds") as string[];
    if (!participantIdentityIds?.includes(senderIdentityId)) throw new Error("The sending identity is not part of this conversation.");
    recipientId = participantIdentityIds.find((id) => id !== senderIdentityId) ?? null;
  }
  if (!recipientId) throw new Error("Recipient identity is missing.");
  await callV3("sendMessage", { conversationId, senderIdentityId, recipientIdentityId: recipientId, body, replyToId, clientNonce });
  return true;
}

export async function flushOutbox(): Promise<void> {
  if (!await connectCloud()) return;
  for (const item of await pendingOutbox()) {
    try {
      await sendCloudMessage(item.conversationId, item.body, item.replyToId ?? null, item.clientNonce, item.senderHandle, item.recipientIdentityId);
      await resolveOutbox(item.id, true);
    } catch (cause) {
      await resolveOutbox(item.id, false, cause instanceof Error ? cause.message.slice(0, 300) : "network unavailable");
    }
  }
  for (const receipt of await pendingReceipts()) {
    try {
      const uid = cloud!.auth.currentUser!.uid;
      const identities = await getDocs(query(collection(cloud!.db, "identities"), where("ownerUid", "==", uid)));
      const identityId = identities.docs.find((identity) => identity.get("handle") === receipt.identityHandle)?.id;
      if (!identityId) throw new Error("Receipt identity is unavailable.");
      await callV3("updateMemberState", { conversationId: receipt.conversationId, identityId, messageId: receipt.messageId, state: receipt.state });
      await resolveReceipt(receipt.id, true);
    } catch {
      await resolveReceipt(receipt.id, false);
    }
  }
}

export async function claimCloudProfile(username: string, displayName: string): Promise<void> {
  if (!await connectCloud() || !cloud) return;
  await callV3("claimProfile", { username, displayName });
}

export async function upsertCloudAgents(harnesses: string[]): Promise<void> {
  if (!await connectCloud() || !cloud) return;
  const agents = await Promise.all(harnesses.map(async (harness) => {
    const result = await callV3<{ identityId: string }>("upsertAgentIdentity", { harness, slug: harness, visibleToContacts: true });
    return result.identityId;
  }));
  await Promise.all(agents.flatMap((senderIdentityId, index) => agents.slice(index + 1).map((recipientIdentityId) =>
    callV3("openConversation", { senderIdentityId, recipientIdentityId })
  )));
}

export async function ensureCloudAgentRelay(): Promise<void> {
  if (!await connectCloud() || !cloud?.auth.currentUser) return;
  const identities = await getDocs(query(collection(cloud.db, "identities"), where("ownerUid", "==", cloud.auth.currentUser.uid), where("active", "==", true)));
  const agents = identities.docs.filter((identity) => identity.get("kind") === "agent").map((identity) => identity.id);
  await Promise.all(agents.flatMap((senderIdentityId, index) => agents.slice(index + 1).map((recipientIdentityId) =>
    callV3("openConversation", { senderIdentityId, recipientIdentityId })
  )));
}

export async function setCloudAgentVisibility(harness: string, visibleToContacts: boolean): Promise<void> {
  if (!await connectCloud() || !cloud) return;
  await callV3("upsertAgentIdentity", { harness, slug: harness, visibleToContacts });
}

export async function getCloudAgentVisibility(): Promise<Record<string, boolean>> {
  if (!await connectCloud() || !cloud?.auth.currentUser) return {};
  const identities = await getDocs(query(collection(cloud.db, "identities"), where("ownerUid", "==", cloud.auth.currentUser.uid)));
  return Object.fromEntries(identities.docs.filter((identity) => identity.get("kind") === "agent").map((identity) => [identity.get("harness"), identity.get("visibleToContacts") === true]));
}

export async function listCloudContactEndpoints(): Promise<ContactEndpoint[]> {
  if (!("__TAURI_INTERNALS__" in window)) return [
    { id: "agent-codex", name: "Codex", handle: "@owen/codex", kind: "agent", scope: "self" },
    { id: "agent-claude", name: "Claude Code", handle: "@owen/claude", kind: "agent", scope: "self" },
  ];
  if (!await connectCloud() || !cloud?.auth.currentUser) return [];
  const result = await callV3<{ endpoints: ContactEndpoint[] }>("listEndpoints");
  await cacheCloudEndpoints(result.endpoints);
  return result.endpoints;
}

export async function openCloudConversation(recipientIdentityId: string): Promise<string | null> {
  if (!await connectCloud() || !cloud?.auth.currentUser) return null;
  const profile = await getDoc(doc(cloud.db, "profiles", cloud.auth.currentUser.uid));
  const result = await callV3<{ conversationId: string }>("openConversation", { senderIdentityId: profile.get("personIdentityId"), recipientIdentityId });
  return result.conversationId;
}

export async function createCloudInvite(): Promise<{ token: string; inviteUrl: string } | null> {
  if (!await connectCloud() || !cloud) return null;
  return callV3<{ token: string; inviteUrl: string }>("createInvite");
}

export async function revokeCloudInvite(token: string): Promise<void> {
  if (!await connectCloud() || !cloud) return;
  await callV3("revokeInvite", { token });
}
