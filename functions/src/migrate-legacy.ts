import { applicationDefault, initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contactId, conversationId, messageId, personIdentityId } from "./domain.js";

type Args = { apply: boolean; exportDir: string };

function parseArgs(argv: string[]): Args {
  const exportIndex = argv.indexOf("--export-dir");
  return {
    apply: argv.includes("--apply"),
    exportDir: resolve(exportIndex >= 0 && argv[exportIndex + 1] ? argv[exportIndex + 1] : "migration-exports"),
  };
}

export async function migrateLegacy({ apply, exportDir }: Args) {
  initializeApp({ credential: applicationDefault() });
  const db = getFirestore();
  const [users, messages] = await Promise.all([
    db.collection("users").get(),
    db.collection("messages").orderBy("created_at", "asc").get(),
  ]);
  const byUsername = new Map<string, { uid: string; identityId: string }>();
  for (const user of users.docs) {
    const username = user.get("username") as string;
    byUsername.set(username, { uid: user.id, identityId: personIdentityId(user.id) });
  }
  const unmapped = messages.docs.filter((message) => !byUsername.has(message.get("from")) || !byUsername.has(message.get("to")));
  const runId = new Date().toISOString().replaceAll(":", "-");
  const exportPath = resolve(exportDir, runId);
  await mkdir(exportPath, { recursive: true });
  await Promise.all([
    writeFile(resolve(exportPath, "users.json"), JSON.stringify(users.docs.map((item) => ({ id: item.id, ...item.data() })), null, 2), { mode: 0o600 }),
    writeFile(resolve(exportPath, "messages.json"), JSON.stringify(messages.docs.map((item) => ({ id: item.id, ...item.data() })), null, 2), { mode: 0o600 }),
  ]);
  const summary = { profiles: users.size, messages: messages.size, unmapped: unmapped.length, apply, exportPath };
  await writeFile(resolve(exportPath, "manifest.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary));
  if (!apply) return summary;
  if (unmapped.length) throw new Error("Refusing to apply: legacy messages reference unknown usernames.");

  const batch = db.batch();
  for (const user of users.docs) {
    const username = user.get("username") as string;
    const identityId = personIdentityId(user.id);
    batch.set(db.doc(`profiles/${user.id}`), {
      username,
      displayName: username,
      personIdentityId: identityId,
      contactUids: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      migratedFromLegacy: true,
    }, { merge: true });
    batch.set(db.doc(`identities/${identityId}`), {
      ownerUid: user.id,
      kind: "person",
      username,
      slug: null,
      handle: `@${username}`,
      displayName: username,
      harness: null,
      active: true,
      visibleToContacts: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      migratedFromLegacy: true,
    }, { merge: true });
  }

  const contactPairs = new Map<string, [string, string]>();
  const conversations = new Map<string, { identityIds: [string, string]; ownerUids: [string, string]; firstAt: unknown; lastAt: unknown; preview: string }>();
  for (const legacy of messages.docs) {
    const from = byUsername.get(legacy.get("from"))!;
    const to = byUsername.get(legacy.get("to"))!;
    const pairId = contactId(from.uid, to.uid);
    contactPairs.set(pairId, [from.uid, to.uid]);
    const conversation = conversationId(from.identityId, to.identityId);
    const createdAt = legacy.get("created_at") ?? Timestamp.now();
    const nonce = `legacy_${legacy.id}`;
    const migratedMessageId = messageId(conversation, from.identityId, nonce);
    const current = conversations.get(conversation);
    conversations.set(conversation, {
      identityIds: [from.identityId, to.identityId].sort() as [string, string],
      ownerUids: [from.uid, to.uid].sort() as [string, string],
      firstAt: current?.firstAt ?? createdAt,
      lastAt: createdAt,
      preview: String(legacy.get("content") ?? "").slice(0, 160),
    });
    batch.set(db.doc(`conversations/${conversation}/messages/${migratedMessageId}`), {
      conversationId: conversation,
      senderIdentityId: from.identityId,
      recipientIdentityId: to.identityId,
      body: legacy.get("content"),
      replyToId: null,
      clientNonce: nonce,
      createdAt,
      migratedFromLegacyId: legacy.id,
    }, { merge: true });
    if (legacy.get("read") === true) {
      batch.set(db.doc(`conversations/${conversation}/memberStates/${to.identityId}`), {
        identityId: to.identityId,
        lastDeliveredMessageId: migratedMessageId,
        lastDeliveredAt: createdAt,
        lastSeenMessageId: migratedMessageId,
        lastSeenAt: createdAt,
      }, { merge: true });
    }
  }

  for (const [id, conversation] of conversations) {
    batch.set(db.doc(`conversations/${id}`), {
      participantIdentityIds: conversation.identityIds,
      ownerUids: conversation.ownerUids,
      lastMessageAt: conversation.lastAt,
      lastMessagePreview: conversation.preview,
      createdAt: conversation.firstAt,
      migratedFromLegacy: true,
    }, { merge: true });
  }

  for (const [pairId, [uidA, uidB]] of contactPairs) {
    batch.set(db.doc(`contacts/${pairId}`), {
      memberUids: [uidA, uidB].sort(),
      invitedByUid: uidA,
      status: "active",
      acceptedAt: FieldValue.serverTimestamp(),
      removedAt: null,
      migratedFromLegacy: true,
    }, { merge: true });
    batch.update(db.doc(`profiles/${uidA}`), { contactUids: FieldValue.arrayUnion(uidB) });
    batch.update(db.doc(`profiles/${uidB}`), { contactUids: FieldValue.arrayUnion(uidA) });
  }
  const estimatedWrites = users.size * 2 + messages.size + conversations.size + contactPairs.size * 3;
  if (estimatedWrites > 450) throw new Error(`Refusing to apply ${estimatedWrites} writes in one batch; split the migration first.`);
  await batch.commit();
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrateLegacy(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : "Migration failed");
    process.exitCode = 1;
  });
}
