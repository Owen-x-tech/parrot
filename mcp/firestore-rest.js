// Firestore REST client, scoped to Parrot's needs:
//   - createDocument (auto-id) for /messages
//   - runQuery on /messages (filter by `to` and `read`)
//   - patchDocument on /messages/{id} for marking read
// All requests require an `Authorization: Bearer <idToken>`.

const PROJECT_ID = "parrot-ai-9b46e";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// --- Type marshaling ---

function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v)
    ? { integerValue: String(v) }
    : { doubleValue: v };
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

// --- Operations ---

export async function createDocument(collectionPath, idToken, data) {
  const res = await fetch(`${BASE}/${collectionPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: toFsFields(data) }),
  });
  if (!res.ok) {
    throw new Error(`createDocument failed: ${res.status} ${await res.text()}`);
  }
  const doc = await res.json();
  // doc.name is "projects/.../documents/messages/<id>" — extract id.
  const parts = doc.name.split("/");
  return { id: parts[parts.length - 1], data: fromFsFields(doc.fields) };
}

// Runs a structured query against a collection. Returns array of { id, data }.
// `filters` is an array of { field, op, value } where op is one of "EQUAL".
export async function runQuery(collectionPath, idToken, filters) {
  const where =
    filters.length === 1
      ? {
          fieldFilter: {
            field: { fieldPath: filters[0].field },
            op: filters[0].op,
            value: toFsValue(filters[0].value),
          },
        }
      : {
          compositeFilter: {
            op: "AND",
            filters: filters.map((f) => ({
              fieldFilter: {
                field: { fieldPath: f.field },
                op: f.op,
                value: toFsValue(f.value),
              },
            })),
          },
        };

  const body = {
    structuredQuery: {
      from: [{ collectionId: collectionPath }],
      where,
    },
  };

  const res = await fetch(`${BASE}:runQuery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`runQuery failed: ${res.status} ${await res.text()}`);
  }
  const arr = await res.json();
  return arr
    .filter((entry) => entry.document)
    .map((entry) => {
      const parts = entry.document.name.split("/");
      return {
        id: parts[parts.length - 1],
        data: fromFsFields(entry.document.fields),
      };
    });
}

// PATCH a single field (or several). updateMask scopes the write so we don't
// accidentally clobber other fields.
export async function patchDocument(docPath, idToken, fields) {
  const params = new URLSearchParams();
  for (const k of Object.keys(fields)) params.append("updateMask.fieldPaths", k);

  const res = await fetch(`${BASE}/${docPath}?${params.toString()}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: toFsFields(fields) }),
  });
  if (!res.ok) {
    throw new Error(`patchDocument failed: ${res.status} ${await res.text()}`);
  }
}
