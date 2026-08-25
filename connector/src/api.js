// The only calls the bridge makes to Kelabo's control plane: pair, and ask which
// kelabos this developer may attach to (docs 16 §6).
//
// Kelabo discovery lives here rather than on the Gateway because the control
// plane is the side that knows about invitations. The Gateway then only has to
// *authorize* an explicit kelaboId, instead of carrying a second copy of the
// host-or-invitee rule.
import {
  AGENT_DEVICE_POLL_SECONDS,
  AGENT_DEVICE_CODE_TTL_SECONDS,
} from "@kelabo/contracts";

export function createApi({ apiBaseUrl, getToken, fetchImpl = fetch }) {
  async function call(path, { method = "GET", body, auth = true } = {}) {
    const headers = { "content-type": "application/json" };
    if (auth) {
      const token = await getToken();
      if (!token) throw new Error("not_paired");
      headers.authorization = `Bearer ${token}`;
    }
    const res = await fetchImpl(`${apiBaseUrl}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const err = new Error(parsed?.error || `http_${res.status}`);
      err.status = res.status;
      err.code = parsed?.error;
      throw err;
    }
    return parsed;
  }

  async function joinableKelabos() {
    const out = await call("/agent/kelabos");
    return out?.kelabos ?? [];
  }

  /** Journeys this developer may attach to directly (docs 20 §12.3) — same
   *  discovery/authorize split as `joinableKelabos`. */
  async function joinableJourneys() {
    const out = await call("/agent/journeys");
    return out?.journeys ?? [];
  }

  /** Start pairing. Returns the code to show the developer plus the device code
   *  to poll with. */
  async function requestDeviceCode({ runtime, label }) {
    return call("/agent/device/code", { method: "POST", body: { runtime, label }, auth: false });
  }

  /**
   * Poll until the developer approves in the portal. 428 is a real "not yet"
   * rather than a failure, so it is the only status worth retrying on: anything
   * else means the code is gone and polling forever would just hide that.
   */
  async function awaitApproval(deviceCode, { onTick = () => {}, sleep = defaultSleep } = {}) {
    const deadline = Date.now() + AGENT_DEVICE_CODE_TTL_SECONDS * 1000;
    while (Date.now() < deadline) {
      try {
        return await call("/agent/device/token", { method: "POST", body: { deviceCode }, auth: false });
      } catch (err) {
        if (err.code !== "authorization_pending") throw err;
        onTick(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
        await sleep(AGENT_DEVICE_POLL_SECONDS * 1000);
      }
    }
    throw new Error("device_code_expired");
  }

  return { joinableKelabos, joinableJourneys, requestDeviceCode, awaitApproval };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
