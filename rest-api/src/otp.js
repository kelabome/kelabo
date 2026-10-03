import { randomInt, randomUUID } from "node:crypto";
import { hmacSha256 } from "./jwt.js";
import { err } from "./errors.js";
import { createTenancy } from "./tenancy.js";

export function createOtp({ config, db, mailer, opConfig, tenancy = createTenancy({ config, opConfig }) }) {
  // The sign-in gate and its rate limits are published operational config
  // (contracts/src/opconfig.js), resolved per request. `effective()` returns
  // this service's own config shape with published values folded in, so every
  // read below is the expression it always was.
  //
  // Falling back to `config` when nothing was injected keeps the existing tests
  // and a deployment with no config table behaving exactly as before.
  const settings = async () => (opConfig ? await opConfig.effective() : config);

  // Tenant = the verified email's organisation (ARCHITECTURE §1, tenancy.js).
  // With an allow-list configured (self-host) that is the primary domain, an
  // alias domain folding into it; with the allow-list empty, registration is
  // open and every domain lands in its own tenant.
  /**
   * Async now, because the allowed domain is publishable.
   *
   * Note which direction is reachable by mistake: publishing an EMPTY domain
   * falls back to the deployment's configured one (`resolveOpConfig`), so
   * clearing the field in the console cannot open the deployment to every
   * address on the internet. Widening it is only possible by typing a
   * different domain, and that publish is an append-only version naming who
   * did it.
   */
  async function assertDomainAllowed(email) {
    if (!(await tenancy.allows(email))) throw err(403, "domain_not_allowed");
  }

  async function request({ email, ip }) {
    await assertDomainAllowed(email);
    const now = Date.now();
    const o = (await settings()).otp;

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
      tenantId: await tenancy.tenantOf(email),
    });

    // No `from`: the mailer knows the deployment's sending address, and on a
    // deployment that can change it at run time this is the only way for a
    // send to see the current one.
    await mailer.sendOtp({ to: email, code });
    return { ok: true, resendInSeconds: o.resendSeconds };
  }

  async function verify({ email, code }) {
    await assertDomainAllowed(email);
    const item = await db.getOtp(email);
    if (!item) throw err(401, "invalid_code");
    if (item.expiresAt <= Date.now()) {
      await db.deleteOtp(email);
      throw err(401, "code_expired");
    }
    if ((item.attempts || 0) >= (await settings()).otp.maxAttempts) throw err(429, "too_many_attempts");
    if (hmacSha256(code, email) !== item.codeHash) {
      await db.incrementOtpAttempts(email);
      throw err(401, "invalid_code");
    }
    await db.deleteOtp(email);
    const displayName = email.split("@")[0];
    const tenantId = await tenancy.tenantOf(email);
    const user = await db.upsertUser({ email, displayName, tenantId });
    return { email, displayName: user?.displayName || displayName, tenantId };
  }

  return { request, verify, assertDomainAllowed };
}

export function generateGuestIdentity() {
  return `guest:${randomUUID()}`;
}
