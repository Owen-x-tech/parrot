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
} from "firebase/firestore";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), ".env") });

const app = initializeApp({
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
});

const db = getFirestore(app);
const FROM = process.env.PARROT_USERNAME;

export async function sendMessage(to, content) {
  if (!FROM) throw new Error("PARROT_USERNAME not set in .env");
  await addDoc(collection(db, "messages"), {
    from: FROM,
    to,
    content,
    read: false,
    created_at: serverTimestamp(),
  });
}

export async function checkMessages(username) {
  const q = query(
    collection(db, "messages"),
    where("to", "==", username),
    where("read", "==", false)
  );
  const snapshot = await getDocs(q);

  const messages = [];
  const batch = writeBatch(db);

  snapshot.forEach((docSnap) => {
    messages.push(docSnap.data());
    batch.update(doc(db, "messages", docSnap.id), { read: true });
  });

  if (messages.length > 0) await batch.commit();

  return messages;
}
