import { readConfig, writeConfig, getUsername } from "./config.js";
import { signInWithCustomToken, refreshIdToken } from "./auth-rest.js";
import { createDocument, runQuery, patchDocument } from "./firestore-rest.js";

let cachedIdToken = null;
let cachedExpiresAt = 0;

// Ensures a fresh ID token is available. Refreshes if expired or expiring soon.
async function getIdToken() {
  const now = Date.now();
  if (cachedIdToken && cachedExpiresAt - now > 60_000) return cachedIdToken;

  const cfg = readConfig();
  if (!cfg?.refresh_token) {
    throw new Error("Parrot not paired. Run /parrot to set up.");
  }
  const { idToken, refreshToken, expiresInSec } = await refreshIdToken(cfg.refresh_token);
  cachedIdToken = idToken;
  cachedExpiresAt = now + expiresInSec * 1000;
  // Refresh tokens are usually stable but Firebase may rotate them; persist if changed.
  if (refreshToken && refreshToken !== cfg.refresh_token) {
    writeConfig({ ...cfg, refresh_token: refreshToken });
  }
  return idToken;
}

// Pairs the plugin using a base64 pairing string from parrot-web.
// Stores { username, uid, refresh_token } in ~/.config/parrot/config.json.
export async function pair(pairingString) {
  let payload;
  try {
    const json = Buffer.from(pairingString.trim(), "base64").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    throw new Error("Pairing string is malformed. Get a fresh one from parrot-web.");
  }
  if (!payload.custom_token || !payload.username || !payload.uid) {
    throw new Error("Pairing string is missing required fields.");
  }

  const { idToken, refreshToken, uid } = await signInWithCustomToken(payload.custom_token);
  if (uid !== payload.uid) {
    throw new Error("Pairing string UID mismatch.");
  }

  writeConfig({ username: payload.username, uid, refresh_token: refreshToken });
  cachedIdToken = idToken;
  // Set 50min cache for the just-issued ID token (Firebase ID tokens are 1hr).
  cachedExpiresAt = Date.now() + 50 * 60 * 1000;

  return payload.username;
}

export async function sendMessage(to, content) {
  const from = getUsername();
  if (!from) throw new Error("Parrot username not set. Run /parrot to set up.");
  const idToken = await getIdToken();
  await createDocument("messages", idToken, {
    from,
    to,
    content,
    read: false,
    created_at: new Date(),
  });
}

export async function checkMessages() {
  const username = getUsername();
  if (!username) throw new Error("Parrot username not set. Run /parrot to set up.");
  const idToken = await getIdToken();

  const docs = await runQuery("messages", idToken, [
    { field: "to", op: "EQUAL", value: username },
    { field: "read", op: "EQUAL", value: false },
  ]);

  // Mark read in parallel, but don't block returning content if some fail.
  await Promise.all(
    docs.map((d) => patchDocument(`messages/${d.id}`, idToken, { read: true }).catch(() => {}))
  );

  const messages = docs.map((d) => ({
    from: d.data.from,
    content: d.data.content,
    created_at: d.data.created_at instanceof Date ? d.data.created_at : null,
  }));
  messages.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return messages;
}

export { getUsername };
