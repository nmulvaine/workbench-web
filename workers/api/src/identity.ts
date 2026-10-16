import type { Env } from "./index.js";

export interface IdentityClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: string | string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly jti?: string;
  readonly nonce?: string;
}

interface SigningJwk extends JsonWebKey { kid?: string; alg?: string; use?: string; kty?: string; crv?: string }
interface JwkSet { keys: SigningJwk[] }
interface JwtHeader { alg?: string; kid?: string; typ?: string }

const jwksCache = new Map<string, { expiresAt: number; keys: JsonWebKey[] }>();

/** Validates signature and required OIDC claims. No bearer-token-presence shortcut. */
export async function verifyIdentityToken(request: Request, env: Pick<Env, "AUTH_ISSUER" | "AUTH_AUDIENCE" | "AUTH_JWKS_URL">): Promise<IdentityClaims> {
  const issuer = env.AUTH_ISSUER;
  const audience = env.AUTH_AUDIENCE;
  const jwksURL = env.AUTH_JWKS_URL;
  if (!issuer || !audience || !jwksURL) throw new Error("identity provider is not configured");
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  if (!match) throw new Error("bearer token required");
  const [headerPart, payloadPart, signaturePart] = match[1].split(".");
  const header = parsePart<JwtHeader>(headerPart);
  if (header.typ && header.typ !== "JWT") throw new Error("unexpected token type");
  if (!header.kid || !header.alg || !["RS256", "ES256"].includes(header.alg)) throw new Error("unsupported signing key");
  const keys = await loadJwks(jwksURL);
  const jwk = keys.find((key) => key.kid === header.kid && (!key.alg || key.alg === header.alg) && key.use !== "enc");
  if (!jwk) throw new Error("unknown signing key");
  const cryptoKey = await importVerificationKey(jwk, header.alg);
  const signedBytes = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const signature = decodeBase64Url(signaturePart);
  const valid = await crypto.subtle.verify(header.alg === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" }, cryptoKey, Uint8Array.from(signature).buffer as ArrayBuffer, Uint8Array.from(signedBytes).buffer as ArrayBuffer);
  if (!valid) throw new Error("invalid token signature");

  const claims = parsePart<Record<string, unknown>>(payloadPart);
  const now = Math.floor(Date.now() / 1000);
  const aud = claims.aud;
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (claims.iss !== issuer || !audiences.includes(audience)) throw new Error("issuer or audience mismatch");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 256 || typeof claims.exp !== "number" || claims.exp <= now) throw new Error("expired or incomplete token");
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) throw new Error("token not active");
  if (typeof claims.iat === "number" && claims.iat > now + 30) throw new Error("token issued in the future");
  return claims as unknown as IdentityClaims;
}

async function loadJwks(url: string): Promise<SigningJwk[]> {
  const now = Date.now();
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > now) return cached.keys;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("unable to retrieve identity keys");
  const set = await response.json() as JwkSet;
  if (!Array.isArray(set.keys) || set.keys.length > 32) throw new Error("invalid identity key set");
  const keys = set.keys.filter((key) => key.kid && key.kty && key.use !== "enc");
  if (keys.length === 0) throw new Error("empty identity key set");
  const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/i)?.[1] ?? 300);
  jwksCache.set(url, { expiresAt: now + Math.min(Math.max(maxAge, 30), 3600) * 1000, keys });
  return keys;
}

async function importVerificationKey(jwk: SigningJwk, algorithm: string): Promise<CryptoKey> {
  if (algorithm === "RS256" && jwk.kty === "RSA") return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (algorithm === "ES256" && jwk.kty === "EC" && jwk.crv === "P-256") return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  throw new Error("signing key type does not match algorithm");
}

function parsePart<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))) as T;
}

function decodeBase64Url(part: string): Uint8Array {
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
