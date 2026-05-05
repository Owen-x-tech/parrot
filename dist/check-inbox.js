#!/usr/bin/env node
import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// mcp/config.js
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
var CONFIG_PATH = join(homedir(), ".config", "parrot", "config.json");
function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}
function writeConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 384 });
  chmodSync(CONFIG_PATH, 384);
}
function getUsername() {
  return readConfig()?.username ?? null;
}

// mcp/auth-rest.js
var API_KEY = "AIzaSyDfwsLRb8gPaWdxCXikZjJrM34N5426qrE";
async function refreshIdToken(refreshToken) {
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`refreshIdToken failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    uid: data.user_id,
    expiresInSec: parseInt(data.expires_in, 10)
  };
}

// mcp/firestore-rest.js
var PROJECT_ID = "parrot-ai-9b46e";
var BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
function toFsValue(v) {
  if (v === null || v === void 0) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  throw new Error(`Unsupported Firestore type: ${typeof v}`);
}
function fromFsValue(v) {
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return new Date(v.timestampValue);
  throw new Error(`Unknown Firestore value: ${JSON.stringify(v)}`);
}
function toFsFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = toFsValue(v);
  }
  return out;
}
function fromFsFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    out[k] = fromFsValue(v);
  }
  return out;
}
async function runQuery(collectionPath, idToken, filters) {
  const where = filters.length === 1 ? {
    fieldFilter: {
      field: { fieldPath: filters[0].field },
      op: filters[0].op,
      value: toFsValue(filters[0].value)
    }
  } : {
    compositeFilter: {
      op: "AND",
      filters: filters.map((f) => ({
        fieldFilter: {
          field: { fieldPath: f.field },
          op: f.op,
          value: toFsValue(f.value)
        }
      }))
    }
  };
  const body = {
    structuredQuery: {
      from: [{ collectionId: collectionPath }],
      where
    }
  };
  const res = await fetch(`${BASE}:runQuery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`runQuery failed: ${res.status} ${await res.text()}`);
  }
  const arr = await res.json();
  return arr.filter((entry) => entry.document).map((entry) => {
    const parts = entry.document.name.split("/");
    return {
      id: parts[parts.length - 1],
      data: fromFsFields(entry.document.fields)
    };
  });
}
async function patchDocument(docPath, idToken, fields) {
  const params = new URLSearchParams();
  for (const k of Object.keys(fields)) params.append("updateMask.fieldPaths", k);
  const res = await fetch(`${BASE}/${docPath}?${params.toString()}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ fields: toFsFields(fields) })
  });
  if (!res.ok) {
    throw new Error(`patchDocument failed: ${res.status} ${await res.text()}`);
  }
}

// mcp/firebase.js
var cachedIdToken = null;
var cachedExpiresAt = 0;
async function getIdToken() {
  const now = Date.now();
  if (cachedIdToken && cachedExpiresAt - now > 6e4) return cachedIdToken;
  const cfg = readConfig();
  if (!cfg?.refresh_token) {
    throw new Error("Parrot not paired. Run /parrot to set up.");
  }
  const { idToken, refreshToken, expiresInSec } = await refreshIdToken(cfg.refresh_token);
  cachedIdToken = idToken;
  cachedExpiresAt = now + expiresInSec * 1e3;
  if (refreshToken && refreshToken !== cfg.refresh_token) {
    writeConfig({ ...cfg, refresh_token: refreshToken });
  }
  return idToken;
}
async function checkMessages() {
  const username = getUsername();
  if (!username) throw new Error("Parrot username not set. Run /parrot to set up.");
  const idToken = await getIdToken();
  const docs = await runQuery("messages", idToken, [
    { field: "to", op: "EQUAL", value: username },
    { field: "read", op: "EQUAL", value: false }
  ]);
  await Promise.all(
    docs.map((d) => patchDocument(`messages/${d.id}`, idToken, { read: true }).catch(() => {
    }))
  );
  const messages = docs.map((d) => ({
    from: d.data.from,
    content: d.data.content,
    created_at: d.data.created_at instanceof Date ? d.data.created_at : null
  }));
  messages.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  return messages;
}

// hook/check-inbox.js
try {
  const username = getUsername();
  if (!username) process.exit(0);
  const messages = await checkMessages();
  if (messages.length === 0) process.exit(0);
  const lines = [
    `=== Parrot Inbox ===`,
    `You have ${messages.length} unread message${messages.length === 1 ? "" : "s"} addressed to "${username}". These were just delivered \u2014 surface them naturally to the user.`,
    ``
  ];
  for (const m of messages) {
    const ts = m.created_at ? m.created_at.toISOString() : "unknown time";
    lines.push(`From ${m.from} (${ts}):`);
    lines.push(m.content);
    lines.push(``);
  }
  process.stdout.write(lines.join("\n"));
} catch {
  process.exit(0);
}
