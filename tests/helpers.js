import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const rulesPath = join(here, "..", "firestore.rules");

export async function makeTestEnv() {
  return await initializeTestEnvironment({
    projectId: "parrot-rules-test",
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      rules: readFileSync(rulesPath, "utf8"),
    },
  });
}

export function authedDb(env, uid) {
  return env.authenticatedContext(uid).firestore();
}

export function unauthedDb(env) {
  return env.unauthenticatedContext().firestore();
}

// Seeds usernames/{name} and users/{uid} bypassing rules.
export async function seedUser(env, uid, username) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `usernames/${username}`), { uid });
    await setDoc(doc(ctx.firestore(), `users/${uid}`), { username });
  });
}
