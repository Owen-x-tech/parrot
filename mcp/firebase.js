import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  serverTimestamp,
  writeBatch,
  doc,
  orderBy,
} from "firebase/firestore";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), ".env") });

export const USERNAME = process.env.PARROT_USERNAME;

const app = initializeApp({
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
});

const db = getFirestore(app);

export async function sendMessage(to, content) {
  if (!USERNAME) throw new Error("PARROT_USERNAME not set. Run /parrot-setup.");
  await addDoc(collection(db, "messages"), {
    from: USERNAME,
    to,
    content,
    read: false,
    created_at: serverTimestamp(),
  });
}

export async function checkMessages() {
  if (!USERNAME) throw new Error("PARROT_USERNAME not set. Run /parrot-setup.");
  const q = query(
    collection(db, "messages"),
    where("to", "==", USERNAME),
    where("read", "==", false)
  );
  const snapshot = await getDocs(q);

  const messages = [];
  const batch = writeBatch(db);

  snapshot.forEach((docSnap) => {
    const data = docSnap.data();
    messages.push({
      from: data.from,
      content: data.content,
      created_at: data.created_at?.toDate?.() ?? null,
    });
    batch.update(doc(db, "messages", docSnap.id), { read: true });
  });

  if (messages.length > 0) await batch.commit();

  messages.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return messages;
}
