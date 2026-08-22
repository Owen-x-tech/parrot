import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  agentHandle,
  agentSlugSchema,
  displayNameSchema,
  harnessSchema,
  personHandle,
} from "@parrot/contracts";
import {
  INVITE_TTL_MS,
  agentIdentityId,
  contactId,
  conversationId,
  messageId,
  parseMessageInput,
  parseProfileInput,
  personIdentityId,
  randomToken,
  sha256,
} from "./domain.js";

initializeApp();
const db = getFirestore();

function uidFor(request: { auth?: { uid: string } }): string {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Sign in to Parrot first.");
  return request.auth.uid;
}

async function ownedIdentity(uid: string, identityId: string) {
  const snapshot = await db.doc(`identities/${identityId}`).get();
  if (!snapshot.exists || snapshot.get("ownerUid") !== uid) {
    throw new HttpsError("permission-denied", "Identity is not owned by this account.");
  }
  return snapshot;
}

async function assertActiveContact(uidA: string, uidB: string) {
  if (uidA === uidB) return;
  const snapshot = await db.doc(`contacts/${contactId(uidA, uidB)}`).get();
  if (!snapshot.exists || snapshot.get("status") !== "active") {
    throw new HttpsError("permission-denied", "An accepted Parrot invite is required.");
  }
}

export const claimProfile = onCall(async (request) => {
  const uid = uidFor(request);
  const { username, displayName } = parseProfileInput(request.data);
  const identityId = personIdentityId(uid);
  const usernameRef = db.doc(`usernames/${username}`);
  const profileRef = db.doc(`profiles/${uid}`);
  const identityRef = db.doc(`identities/${identityId}`);

  await db.runTransaction(async (transaction) => {
    const [usernameSnapshot, profileSnapshot] = await Promise.all([
      transaction.get(usernameRef),
      transaction.get(profileRef),
    ]);
    if (usernameSnapshot.exists && usernameSnapshot.get("uid") !== uid) {
      throw new HttpsError("already-exists", `Username \"${username}\" is taken.`);
    }
    if (profileSnapshot.exists && profileSnapshot.get("username") !== username) {
      throw new HttpsError("failed-precondition", "Root usernames are permanent in Parrot v3.");
    }
    const now = FieldValue.serverTimestamp();
    const previousContactUids = profileSnapshot.exists
      ? (profileSnapshot.get("contactUids") as string[] | undefined) ?? []
      : [];
    const createdAt = profileSnapshot.exists
      ? profileSnapshot.get("createdAt") ?? now
      : now;
    transaction.set(usernameRef, { uid, personIdentityId: identityId }, { merge: true });
    transaction.set(profileRef, {
      username,
      displayName,
      personIdentityId: identityId,
      contactUids: previousContactUids,
      createdAt,
      updatedAt: now,
    }, { merge: true });
    transaction.set(identityRef, {
      ownerUid: uid,
      kind: "person",
      username,
      slug: null,
      handle: personHandle(username),
      displayName,
      harness: null,
      active: true,
      visibleToContacts: true,
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
  });
  return { profileId: uid, personIdentityId: identityId, handle: personHandle(username) };
});

export const upsertAgentIdentity = onCall(async (request) => {
  const uid = uidFor(request);
  const profile = await db.doc(`profiles/${uid}`).get();
  if (!profile.exists) throw new HttpsError("failed-precondition", "Claim a username first.");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const harness = harnessSchema.parse(data.harness);
  const slug = agentSlugSchema.parse(data.slug ?? harness);
  if (slug !== harness) {
    throw new HttpsError("invalid-argument", "V1 agent slugs must match their harness.");
  }
  const displayName = displayNameSchema.parse(data.displayName ?? (harness === "codex" ? "Codex" : "Claude Code"));
  const visibleToContacts = data.visibleToContacts !== false;
  const id = agentIdentityId(uid, slug);
  const username = profile.get("username") as string;
  const ref = db.doc(`identities/${id}`);
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    const now = FieldValue.serverTimestamp();
    transaction.set(ref, {
      ownerUid: uid,
      kind: "agent",
      username,
      slug,
      handle: agentHandle(username, slug),
      displayName,
      harness,
      active: true,
      visibleToContacts,
      createdAt: existing.exists ? existing.get("createdAt") : now,
      updatedAt: now,
    }, { merge: true });
  });
  return { identityId: id, handle: agentHandle(username, slug) };
});

export const createInvite = onCall(async (request) => {
  const uid = uidFor(request);
  const profile = await db.doc(`profiles/${uid}`).get();
  if (!profile.exists) throw new HttpsError("failed-precondition", "Claim a username first.");
  const token = randomToken();
  const inviteId = sha256(token);
  const expiresAt = Timestamp.fromMillis(Date.now() + INVITE_TTL_MS);
  await db.doc(`invites/${inviteId}`).create({
    inviterUid: uid,
    inviterIdentityId: profile.get("personIdentityId"),
    status: "open",
    expiresAt,
    acceptedByUid: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  const publicWebUrl = process.env.PUBLIC_WEB_URL ?? "https://parrot-web-five.vercel.app";
  return { token, inviteUrl: `${publicWebUrl}/i/${encodeURIComponent(token)}`, expiresAt: expiresAt.toMillis() };
});

export const acceptInvite = onCall(async (request) => {
  const acceptingUid = uidFor(request);
  const token = String(request.data?.token ?? "");
  if (!token) throw new HttpsError("invalid-argument", "Invite token is required.");
  const inviteRef = db.doc(`invites/${sha256(token)}`);
  let inviterUid = "";
  await db.runTransaction(async (transaction) => {
    const invite = await transaction.get(inviteRef);
    if (!invite.exists || invite.get("status") !== "open") {
      throw new HttpsError("not-found", "Invite is invalid or has already been used.");
    }
    const expiresAt = invite.get("expiresAt") as Timestamp;
    if (expiresAt.toMillis() <= Date.now()) throw new HttpsError("deadline-exceeded", "Invite has expired.");
    inviterUid = invite.get("inviterUid") as string;
    if (inviterUid === acceptingUid) throw new HttpsError("invalid-argument", "You cannot accept your own invite.");
    const acceptingProfile = await transaction.get(db.doc(`profiles/${acceptingUid}`));
    if (!acceptingProfile.exists) throw new HttpsError("failed-precondition", "Claim a username before accepting an invite.");
    const pairId = contactId(inviterUid, acceptingUid);
    transaction.set(db.doc(`contacts/${pairId}`), {
      memberUids: [inviterUid, acceptingUid].sort(),
      invitedByUid: inviterUid,
      status: "active",
      acceptedAt: FieldValue.serverTimestamp(),
      removedAt: null,
    }, { merge: true });
    transaction.update(db.doc(`profiles/${inviterUid}`), { contactUids: FieldValue.arrayUnion(acceptingUid), updatedAt: FieldValue.serverTimestamp() });
    transaction.update(db.doc(`profiles/${acceptingUid}`), { contactUids: FieldValue.arrayUnion(inviterUid), updatedAt: FieldValue.serverTimestamp() });
    transaction.update(inviteRef, { status: "accepted", acceptedByUid: acceptingUid, acceptedAt: FieldValue.serverTimestamp() });
  });
  return { contactId: contactId(inviterUid, acceptingUid), inviterUid };
});

export const revokeInvite = onCall(async (request) => {
  const uid = uidFor(request);
  const token = String(request.data?.token ?? "");
  const ref = db.doc(`invites/${sha256(token)}`);
  await db.runTransaction(async (transaction) => {
    const invite = await transaction.get(ref);
    if (!invite.exists || invite.get("inviterUid") !== uid) throw new HttpsError("not-found", "Invite was not found.");
    if (invite.get("status") === "accepted") throw new HttpsError("failed-precondition", "Accepted invites cannot be revoked.");
    transaction.update(ref, { status: "revoked", revokedAt: FieldValue.serverTimestamp() });
  });
  return { revoked: true };
});

export const openConversation = onCall(async (request) => {
  const uid = uidFor(request);
  const senderIdentityId = String(request.data?.senderIdentityId ?? "");
  const recipientIdentityId = String(request.data?.recipientIdentityId ?? "");
  if (!senderIdentityId || senderIdentityId === recipientIdentityId) {
    throw new HttpsError("invalid-argument", "Choose two different identities.");
  }
  const sender = await ownedIdentity(uid, senderIdentityId);
  const recipient = await db.doc(`identities/${recipientIdentityId}`).get();
  if (!recipient.exists || !recipient.get("active")) throw new HttpsError("not-found", "Recipient is unavailable.");
  const recipientOwnerUid = recipient.get("ownerUid") as string;
  await assertActiveContact(uid, recipientOwnerUid);
  if (recipientOwnerUid !== uid && recipient.get("kind") === "agent" && !recipient.get("visibleToContacts")) {
    throw new HttpsError("permission-denied", "This agent is not available to contacts.");
  }
  const id = conversationId(senderIdentityId, recipientIdentityId);
  const ref = db.doc(`conversations/${id}`);
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (!existing.exists) transaction.create(ref, {
      participantIdentityIds: [senderIdentityId, recipientIdentityId].sort(),
      ownerUids: [...new Set([sender.get("ownerUid"), recipientOwnerUid])].sort(),
      lastMessageAt: null,
      lastMessagePreview: "",
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { conversationId: id };
});

export const sendMessage = onCall(async (request) => {
  const uid = uidFor(request);
  const input = parseMessageInput(request.data);
  if (input.senderIdentityId === input.recipientIdentityId) {
    throw new HttpsError("invalid-argument", "Sender and recipient must be different identities.");
  }
  const sender = await ownedIdentity(uid, input.senderIdentityId);
  const recipient = await db.doc(`identities/${input.recipientIdentityId}`).get();
  if (!recipient.exists || !recipient.get("active")) throw new HttpsError("not-found", "Recipient is unavailable.");
  const recipientOwnerUid = recipient.get("ownerUid") as string;
  await assertActiveContact(uid, recipientOwnerUid);
  if (recipientOwnerUid !== uid && recipient.get("kind") === "agent" && !recipient.get("visibleToContacts")) {
    throw new HttpsError("permission-denied", "This agent is not available to contacts.");
  }
  const expectedConversation = conversationId(input.senderIdentityId, input.recipientIdentityId);
  if (input.conversationId !== expectedConversation) throw new HttpsError("invalid-argument", "Conversation does not match its identities.");
  const conversationRef = db.doc(`conversations/${expectedConversation}`);
  const id = messageId(expectedConversation, input.senderIdentityId, input.clientNonce);
  const messageRef = conversationRef.collection("messages").doc(id);
  await db.runTransaction(async (transaction) => {
    const conversation = await transaction.get(conversationRef);
    if (!conversation.exists || !(conversation.get("ownerUids") as string[]).includes(uid)) {
      throw new HttpsError("permission-denied", "Conversation is unavailable.");
    }
    if (input.replyToId) {
      const reply = await transaction.get(conversationRef.collection("messages").doc(input.replyToId));
      if (!reply.exists) throw new HttpsError("invalid-argument", "Reply target is not in this conversation.");
    }
    const existing = await transaction.get(messageRef);
    if (existing.exists) return;
    const now = FieldValue.serverTimestamp();
    transaction.create(messageRef, {
      conversationId: expectedConversation,
      senderIdentityId: input.senderIdentityId,
      recipientIdentityId: input.recipientIdentityId,
      body: input.body,
      replyToId: input.replyToId,
      clientNonce: input.clientNonce,
      createdAt: now,
    });
    transaction.update(conversationRef, {
      lastMessageAt: now,
      lastMessagePreview: input.body.slice(0, 160),
    });
    transaction.set(conversationRef.collection("memberStates").doc(input.senderIdentityId), {
      identityId: input.senderIdentityId,
      lastSeenMessageId: id,
      lastSeenAt: now,
      lastDeliveredMessageId: id,
      lastDeliveredAt: now,
    }, { merge: true });
    transaction.set(conversationRef.collection("memberStates").doc(input.recipientIdentityId), {
      identityId: input.recipientIdentityId,
      unreadCount: FieldValue.increment(1),
    }, { merge: true });
  });
  return { messageId: id, accepted: true };
});

export const updateMemberState = onCall(async (request) => {
  const uid = uidFor(request);
  const conversationIdValue = String(request.data?.conversationId ?? "");
  const identityId = String(request.data?.identityId ?? "");
  const messageIdValue = String(request.data?.messageId ?? "");
  const state = request.data?.state === "seen" ? "seen" : "delivered";
  await ownedIdentity(uid, identityId);
  const conversationRef = db.doc(`conversations/${conversationIdValue}`);
  const [conversation, message] = await Promise.all([
    conversationRef.get(),
    conversationRef.collection("messages").doc(messageIdValue).get(),
  ]);
  if (!conversation.exists || !(conversation.get("participantIdentityIds") as string[]).includes(identityId) || !message.exists) {
    throw new HttpsError("not-found", "Conversation message was not found.");
  }
  const now = FieldValue.serverTimestamp();
  const update = state === "seen"
    ? { lastSeenMessageId: messageIdValue, lastSeenAt: now, lastDeliveredMessageId: messageIdValue, lastDeliveredAt: now, unreadCount: 0 }
    : { lastDeliveredMessageId: messageIdValue, lastDeliveredAt: now };
  await conversationRef.collection("memberStates").doc(identityId).set({ identityId, ...update }, { merge: true });
  return { updated: true, state };
});

export const removeContact = onCall(async (request) => {
  const uid = uidFor(request);
  const otherUid = String(request.data?.uid ?? "");
  if (!otherUid || otherUid === uid) throw new HttpsError("invalid-argument", "A contact uid is required.");
  const ref = db.doc(`contacts/${contactId(uid, otherUid)}`);
  await db.runTransaction(async (transaction) => {
    const contact = await transaction.get(ref);
    if (!contact.exists || !(contact.get("memberUids") as string[]).includes(uid)) throw new HttpsError("not-found", "Contact was not found.");
    transaction.update(ref, { status: "removed", removedAt: FieldValue.serverTimestamp() });
    transaction.update(db.doc(`profiles/${uid}`), { contactUids: FieldValue.arrayRemove(otherUid), updatedAt: FieldValue.serverTimestamp() });
    transaction.update(db.doc(`profiles/${otherUid}`), { contactUids: FieldValue.arrayRemove(uid), updatedAt: FieldValue.serverTimestamp() });
  });
  return { removed: true };
});
