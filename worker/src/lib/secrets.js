// AES-GCM storage for organizer-supplied secrets (their Razorpay key secret and webhook secret).
// The key comes from the INTEGRATIONS_KEY Worker secret, separate from SESSION_SECRET so rotating
// logins never destroys stored keys.

import { bytesToB64url, b64urlToBytes, encoder } from "./crypto.js";

async function aesKey(env) {
  if (!env.INTEGRATIONS_KEY) throw new Error("INTEGRATIONS_KEY is not set");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(env.INTEGRATIONS_KEY));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), encoder.encode(plain));
  return `${bytesToB64url(iv)}.${bytesToB64url(new Uint8Array(data))}`;
}

export async function decryptSecret(env, stored) {
  const [iv, data] = String(stored).split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(iv) }, await aesKey(env), b64urlToBytes(data));
  return new TextDecoder().decode(plain);
}
