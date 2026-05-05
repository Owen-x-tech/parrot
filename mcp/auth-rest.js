// Firebase Auth REST client. Handles custom-token exchange and refresh-token
// rotation. No `firebase` npm dep needed.

const API_KEY = "AIzaSyDfwsLRb8gPaWdxCXikZjJrM34N5426qrE";

// Exchanges a custom token for { idToken, refreshToken, localId }.
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
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.localId,
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
