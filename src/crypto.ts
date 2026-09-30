// HKDF + AES-GCM for stored credentials, PBKDF2 for passwords, HMAC for cookies and signed links.
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))));
export const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (buf: ArrayBuffer) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hkdf(secret: string, info: string, usages: KeyUsage[], algo: AesKeyGenParams | HmacImportParams) {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("spikeward"), info: enc.encode(info) },
    base,
    algo,
    false,
    usages,
  );
}

export async function encrypt(secret: string, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await hkdf(secret, "credentials", ["encrypt"], { name: "AES-GCM", length: 256 });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return { ciphertext: b64(ct), iv: b64(iv) };
}

export async function decrypt(secret: string, ciphertext: string, iv: string): Promise<string> {
  const key = await hkdf(secret, "credentials", ["decrypt"], { name: "AES-GCM", length: 256 });
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ciphertext));
  return dec.decode(pt);
}

async function hmacKey(secret: string, purpose: string) {
  return hkdf(secret, `hmac:${purpose}`, ["sign", "verify"], { name: "HMAC", hash: "SHA-256" });
}

export async function sign(secret: string, purpose: string, data: string): Promise<string> {
  const key = await hmacKey(secret, purpose);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function verifySig(secret: string, purpose: string, data: string, sig: string): Promise<boolean> {
  const expected = await sign(secret, purpose, data);
  return timingSafeEqual(expected, sig);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Workers caps PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const bits = await pbkdf2(password, unb64(salt), Number(iter));
  return timingSafeEqual(b64(bits), hash);
}

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

/** Salted, stable name for a cluster so the model never sees who the visitors were. */
export async function fingerprint(secret: string, value: string): Promise<string> {
  return (await sign(secret, "fingerprint", value)).slice(0, 16);
}
