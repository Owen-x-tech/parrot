import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, getDoc, setDoc } from "firebase/firestore";

let environment;

before(async () => {
  environment = await initializeTestEnvironment({
    projectId: "parrot-rules-test",
    firestore: {
      host: "127.0.0.1",
      port: 8085,
      rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
    },
  });
});

beforeEach(async () => environment.clearFirestore());
after(async () => environment.cleanup());

async function seed() {
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "profiles/a"), { username: "alice", contactUids: ["b"] });
    await setDoc(doc(db, "profiles/b"), { username: "bob", contactUids: ["a"] });
    await setDoc(doc(db, "profiles/c"), { username: "carol", contactUids: [] });
    await setDoc(doc(db, "identities/alice"), { ownerUid: "a", visibleToContacts: true });
    await setDoc(doc(db, "identities/bob-agent"), { ownerUid: "b", visibleToContacts: true });
    await setDoc(doc(db, "identities/bob-hidden"), { ownerUid: "b", visibleToContacts: false });
    await setDoc(doc(db, "contacts/ab"), { memberUids: ["a", "b"], status: "active" });
    await setDoc(doc(db, "conversations/c1"), { ownerUids: ["a", "b"], participantIdentityIds: ["alice", "bob-agent"] });
    await setDoc(doc(db, "conversations/c1/messages/m1"), { body: "hello" });
    await setDoc(doc(db, "invites/private"), { inviterUid: "a", status: "open" });
  });
}

describe("Parrot v3 Firestore rules", () => {
  it("allows contacts to read visible identities and shared conversations", async () => {
    await seed();
    const alice = environment.authenticatedContext("a").firestore();
    await assertSucceeds(getDoc(doc(alice, "identities/bob-agent")));
    await assertSucceeds(getDoc(doc(alice, "conversations/c1/messages/m1")));
  });

  it("hides private agents and conversations from strangers", async () => {
    await seed();
    const alice = environment.authenticatedContext("a").firestore();
    const carol = environment.authenticatedContext("c").firestore();
    await assertFails(getDoc(doc(alice, "identities/bob-hidden")));
    await assertFails(getDoc(doc(carol, "conversations/c1")));
  });

  it("denies every direct v3 client write", async () => {
    await seed();
    const alice = environment.authenticatedContext("a").firestore();
    await assertFails(setDoc(doc(alice, "profiles/a"), { username: "changed" }));
    await assertFails(setDoc(doc(alice, "conversations/c1/messages/m2"), { body: "bypass" }));
    await assertFails(setDoc(doc(alice, "invites/new"), { inviterUid: "a" }));
  });

  it("keeps the narrowly scoped legacy beta write path", async () => {
    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "usernames/alice"), { uid: "a" });
      await setDoc(doc(db, "usernames/bob"), { uid: "b" });
      await setDoc(doc(db, "users/a"), { username: "alice" });
      await setDoc(doc(db, "users/b"), { username: "bob" });
    });
    const alice = environment.authenticatedContext("a").firestore();
    await assertSucceeds(setDoc(doc(alice, "messages/legacy"), {
      from: "alice", to: "bob", content: "beta message", read: false, created_at: new Date(),
    }));
    await assertFails(setDoc(doc(alice, "messages/spoofed"), {
      from: "carol", to: "bob", content: "spoofed", read: false, created_at: new Date(),
    }));
  });

  it("keeps invite documents server-only", async () => {
    await seed();
    const alice = environment.authenticatedContext("a").firestore();
    await assertFails(getDoc(doc(alice, "invites/private")));
  });

  it("denies unauthenticated access", async () => {
    await seed();
    const guest = environment.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(guest, "profiles/a")));
  });
});
