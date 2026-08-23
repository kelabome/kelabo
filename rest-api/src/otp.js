import { randomInt, randomUUID } from "node:crypto";
import { hmacSha256 } from "./jwt.js";
import { err } from "./errors.js";

export function createOtp({ config, db, mailer }) {
  // Tenant = the verified email's own domain (ARCHITECTURE §1). With an
  // allow-list configured (self-host) that is the one allowed domain; with the
  // allow-list empty, registration is open and every org lands in its own
  // tenant — the multi-domain mode the schema always reserved space for.
  const tenantOf = (email) => email.split("@")[1]?.toLowerCase();

  function assertDomainAllowed(email) {
    const domain = tenantOf(email);
    if (!domain) throw err(403, "domain_not_allowed");
    if (config.allowedEmailDomain && domain !== config.allowedEmailDomain.toLowerCase()) {
      throw err(403, "domain_not_allowed");
    }
  }

  async function request({ email, ip }) {
    assertDomainAllowed(email);
    const now = Date.now();
    const o = config.otp;

    if (ip) {
      const counter = await db.bumpIpCounter(ip, o.perIpWindowSeconds);
      if ((counter?.count || 0) > o.perIpMaxRequests) throw err(429, "rate_limited");
    }

    const existing = await db.getOtp(email);
    if (existing) {
      const windowStart = existing.windowStart || now;
      const inWindow = now - windowStart < o.perEmailWindowSeconds * 1000;
      const count = inWindow ? existing.requestCount || 0 : 0;
      if (inWindow && count >= o.perEmailMaxRequests) throw err(429, "rate_limited");
      if (existing.lastSentAt && now - existing.lastSentAt < o.resendSeconds * 1000) {
        throw err(429, "rate_limited", `retry in ${o.resendSeconds}s`);
      }
    }

    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const nowSec = Math.floor(now / 1000);
    const inWindow = existing?.windowStart && now - existing.windowStart < o.perEmailWindowSeconds * 1000;
    await db.putOtp({
      email,
      codeHash: hmacSha256(code, email),
      expiresAt: now + o.ttlSeconds * 1000,
      ttl: nowSec + o.ttlSeconds,
      attempts: 0,
      requestCount: (inWindow ? existing.requestCount || 0 : 0) + 1,
      windowStart: inWindow ? existing.windowStart : now,
      lastSentAt: now,
      tenantId: tenantOf(email),
    });

    // No `from`: the mailer knows the deployment's sending address, and on a
    // deployment that can change it at run time this is the only way for a
    // send to see the current one.
    await mailer.sendOtp({ to: email, code });
    return { ok: true, resendInSeconds: o.resendSeconds };
  }

  async function verify({ email, code }) {
    assertDomainAllowed(email);
    const item = await db.getOtp(email);
    if (!item) throw err(401, "invalid_code");
    if (item.expiresAt <= Date.now()) {
      await db.deleteOtp(email);
      throw err(401, "code_expired");
    }
    if ((item.attempts || 0) >= config.otp.maxAttempts) throw err(429, "too_many_attempts");
    if (hmacSha256(code, email) !== item.codeHash) {
      await db.incrementOtpAttempts(email);
      throw err(401, "invalid_code");
    }
    await db.deleteOtp(email);
    const displayName = email.split("@")[0];
    const tenantId = tenantOf(email);
    const user = await db.upsertUser({ email, displayName, tenantId });
    return { email, displayName: user?.displayName || displayName, tenantId };
  }

  return { request, verify, assertDomainAllowed };
}

export function generateGuestIdentity() {
  return `guest:${randomUUID()}`;
}
