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
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Firebase Web SDK config for the shared Parrot network. These are client-side
// config values (not secrets); security is enforced by Firestore rules.
const firebaseConfig = {
  apiKey: "AIzaSyDfwsLRb8gPaWdxCXikZjJrM34N5426qrE",
  authDomain: "parrot-ai-9b46e.firebaseapp.com",
  projectId: "parrot-ai-9b46e",
  storageBucket: "parrot-ai-9b46e.firebasestorage.app",
  messagingSenderId: "311043780015",
  appId: "1:311043780015:web:d57792e91584bdf23d135a",
};

const CONFIG_PATH = join(homedir(), ".config", "parrot", "config.json");

export function getUsername() {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    return cfg.username || null;
  } catch {
    return null;
  }
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export async function sendMessage(to, content) {
  const from = getUsername();
  if (!from) throw new Error("Parrot username not set. Run /parrot to set up.");
  await addDoc(collection(db, "messages"), {
    from,
    to,
    content,
    read: false,
    created_at: serverTimestamp(),
  });
}

export async function checkMessages() {
  const username = getUsername();
  if (!username) throw new Error("Parrot username not set. Run /parrot to set up.");
  const q = query(
    collection(db, "messages"),
    where("to", "==", username),
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
