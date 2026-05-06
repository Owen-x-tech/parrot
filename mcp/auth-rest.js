// Firebase Auth REST client. Handles custom-token exchange and refresh-token
// rotation. No `firebase` npm dep needed.

const API_KEY = "AIzaSyDfwsLRb8gPaWdxCXikZjJrM34N5426qrE";

// Decodes a JWT payload (no signature check — caller trusts Firebase to have
// already issued it). Used to read claims like user_id from an ID token.
function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

// Exchanges a custom token for { idToken, refreshToken, uid }. The
// signInWithCustomToken REST endpoint does NOT return localId, so we read
// the UID from the issued ID token's user_id claim.
export async function signInWithCustomToken(customToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`signInWithCustomToken failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  const claims = decodeJwtPayload(data.idToken);
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: claims.user_id || claims.sub,
    expiresInSec: parseInt(data.expiresIn, 10),
  };
}

// Exchanges a refresh token for a fresh ID token.
export async function refreshIdToken(refreshToken) {
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
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
    expiresInSec: parseInt(data.expires_in, 10),
  };
}
