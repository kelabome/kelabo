import { createHash, createVerify, createPublicKey, randomBytes } from "node:crypto";
import { COOKIE_OIDC } from "@kelabo/contracts";
import { signJwt, verifyJwt } from "./jwt.js";
import { serializeCookie, clearCookie } from "./cookies.js";
import { err } from "./errors.js";

const PROVIDERS = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    scope: "openid email profile",
  },
  apple: {
    authorizeUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    jwksUrl: "https://appleid.apple.com/auth/keys",
    issuers: ["https://appleid.apple.com"],
    scope: "name email",
  },
};

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const OIDC_COOKIE_TTL = 600;

export function createOidc({ config, secrets, opConfig, fetchImpl = fetch }) {
  // The allowed sign-in domain is published operational config, resolved per
  // callback — the same source the OTP path reads, so the two cannot disagree
  // about who may hold an account here.
  const settings = async () => (opConfig ? await opConfig.effective() : config);
  function providerConfig(provider) {
    const p = PROVIDERS[provider];
    if (!p || !config.auth.socialProviders.includes(provider)) {
      throw err(400, "bad_request", `unknown provider ${provider}`);
    }
    return p;
  }

  function callbackUrl(provider) {
    return `${config.portalUrl}/api/auth/oidc/${provider}/callback`;
  }

  async function start(provider) {
    const p = providerConfig(provider);
    const { clientId } = await secrets.getOidcSecret(config, provider);
    const state = randomBytes(16).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = b64u(createHash("sha256").update(codeVerifier).digest());
    const key = await secrets.getCookieKey(config);
    const oidcCookie = serializeCookie(
      COOKIE_OIDC,
      signJwt({ provider, state, codeVerifier, exp: Math.floor(Date.now() / 1000) + OIDC_COOKIE_TTL }, key),
      { maxAgeSeconds: OIDC_COOKIE_TTL, domain: config.cookieDomain }
    );
    const url = new URL(p.authorizeUrl);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callbackUrl(provider));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", p.scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (provider === "apple") url.searchParams.set("response_mode", "form_post");
    return { status: 302, headers: { Location: url.toString() }, cookies: [oidcCookie] };
  }

  async function verifyIdToken(idToken, p, expectedAud) {
    const [h, body, sig] = idToken.split(".");
    if (!h || !body || !sig) throw err(401, "oidc_failed", "malformed id_token");
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const jwksRes = await fetchImpl(p.jwksUrl);
    if (!jwksRes.ok) throw err(401, "oidc_failed", "jwks fetch failed");
    const { keys } = await jwksRes.json();
    const jwk = (keys || []).find((k) => k.kid === header.kid);
    if (!jwk) throw err(401, "oidc_failed", "unknown kid");
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${body}`);
    if (!verifier.verify(publicKey, Buffer.from(sig, "base64url"))) {
      throw err(401, "oidc_failed", "bad id_token signature");
    }
    if (!p.issuers.includes(payload.iss)) throw err(401, "oidc_failed", "bad issuer");
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(expectedAud)) throw err(401, "oidc_failed", "bad audience");
    if (!payload.exp || payload.exp * 1000 <= Date.now()) throw err(401, "oidc_failed", "id_token expired");
    return payload;
  }

  async function callback(provider, { query, cookies }) {
    const p = providerConfig(provider);
    const { code, state } = query;
    const key = await secrets.getCookieKey(config);
    const stash = cookies[COOKIE_OIDC] ? verifyJwt(cookies[COOKIE_OIDC], key) : null;
    const clear = clearCookie(COOKIE_OIDC, { domain: config.cookieDomain });
    if (!code || !stash || stash.provider !== provider || stash.state !== state) {
      throw err(401, "oidc_failed", "state mismatch");
    }
    const secret = await secrets.getOidcSecret(config, provider);
    const tokenRes = await fetchImpl(p.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(provider),
        client_id: secret.clientId,
        client_secret: secret.clientSecret,
        code_verifier: stash.codeVerifier,
      }).toString(),
    });
    if (!tokenRes.ok) throw err(401, "oidc_failed", "token exchange failed");
    const tokenBody = await tokenRes.json();
    if (!tokenBody.id_token) throw err(401, "oidc_failed", "no id_token");
    const claims = await verifyIdToken(tokenBody.id_token, p, secret.clientId);
    if (claims.email_verified === false) throw err(401, "oidc_failed", "email not verified");
    const email = (claims.email || "").toLowerCase();
    if (!email) throw err(401, "oidc_failed", "no email claim");
    const domain = email.split("@")[1];
    // Empty allow-list = open registration (tenant = the email's own domain),
    // matching the OTP path.
    const allowed = (await settings()).allowedEmailDomain;
    if (allowed && domain !== allowed.toLowerCase()) {
      throw err(403, "domain_not_allowed");
    }
    return { email, clearCookie: clear };
  }

  return { start, callback };
}
