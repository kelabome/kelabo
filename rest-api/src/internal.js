import { INTERNAL_JWT_AUD } from "@kelabo/contracts";
import { signJwt } from "./jwt.js";

export function createInternal({ config, secrets, fetchImpl = fetch }) {
  async function mintInternalJwt(identity) {
    const key = await secrets.getCookieKey(config);
    const now = Math.floor(Date.now() / 1000);
    return signJwt(
      { sub: identity, tenant: identity.split("@")[1]?.toLowerCase(), role: "user", aud: INTERNAL_JWT_AUD, iat: now, exp: now + 60 },
      key
    );
  }

  async function post(path, identity, body = {}) {
    const jwt = await mintInternalJwt(identity);
    const res = await fetchImpl(`${config.gatewayBaseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gateway internal ${path} -> ${res.status} ${text}`);
    }
    return res;
  }

  return {
    mintInternalJwt,
    // `retry` resumes an end that marked the kelabo ended here but never
    // reached the Gateway, so there is no record. Without it the Gateway 409s
    // on the very status this side wrote.
    endKelabo: async (kelaboId, identity, { retry = false } = {}) => {
      const res = await post(`/internal/kelabos/${kelaboId}/end`, identity, { retry });
      return res.json().catch(() => ({ ok: true, archived: true }));
    },
    requestMinutes: (kelaboId, identity) => post(`/internal/kelabos/${kelaboId}/minutes`, identity),
    // Tear down any prep binding for a cancelled scheduled kelabo (docs 18
    // §2.4). Best-effort at the call site: the kelabo is cancelled in DynamoDB
    // regardless of whether the gateway is reachable.
    cancelKelabo: (kelaboId, identity) => post(`/internal/kelabos/${kelaboId}/cancel`, identity),
    // Re-brief a prep-bound agent whose scheduled kelabo moved (docs 18 §3.3).
    rescheduleKelabo: (kelaboId, identity) => post(`/internal/kelabos/${kelaboId}/reschedule`, identity),
    // Ring online contacts into a kelabo (docs 18 §6). `targets` are resolved
    // and authorized by REST; the Gateway delivers to whichever are online and
    // reports back which were, so the caller learns who was offline.
    ring: async (kelaboId, identity, { targets, title, fromName, fromAvatar }) => {
      const res = await post(`/internal/kelabos/${kelaboId}/ring`, identity, { targets, title, fromName, fromAvatar });
      return res.json().catch(() => ({ rung: [], offline: targets }));
    },
    ringCancel: (kelaboId, identity) => post(`/internal/kelabos/${kelaboId}/ring/cancel`, identity),
    ringAnswer: (kelaboId, identity, { response }) =>
      post(`/internal/kelabos/${kelaboId}/ring/answer`, identity, { response }),
    // Journey report generation (docs 20 §6) — the Gateway holds the LLM
    // credential, so the actual synthesis happens there; this call is
    // awaited the same way requestMinutes is, and the row it wrote is what
    // the client re-fetches afterward, not this response.
    requestJourneyReport: async (journeyId, { reportId, question }, identity) => {
      const res = await post(`/internal/journeys/${journeyId}/report`, identity, { reportId, question });
      return res.json().catch(() => ({ reportId, status: "failed", error: "bad_gateway_response" }));
    },
  };
}
