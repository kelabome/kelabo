// 13, matching the Gateway's writer and the real reader. The stub used to pad to
// 15 as well, which is why it agreed with the bug instead of catching it.
const pad = (n) => String(Math.max(0, Math.floor(n))).padStart(13, "0");

export function createDb() {
  const kelabos = new Map();
  const otp = new Map();
  const users = new Map();
  const refresh = new Map();
  const mcp = new Map();
  const history = new Map();
  const contacts = new Map();
  const journeys = new Map();

  const mkey = (PK, SK) => `${PK}|${SK}`;
  const padVersion = (n) => String(Math.max(0, Math.floor(n))).padStart(6, "0");
  const conditionFailed = () => {
    const e = new Error("ConditionalCheckFailedException");
    e.name = "ConditionalCheckFailedException";
    return e;
  };

  return {
    async getKelaboMeta(kelaboId) {
      return kelabos.get(mkey(`KELABO#${kelaboId}`, "META")) || null;
    },
    // No host guard: a host may run any number of live kelabos (the
    // HOSTACTIVE row was removed 2026-07-31, matching src/db.js).
    async createKelabo(meta) {
      const k = mkey(`KELABO#${meta.kelaboId}`, "META");
      if (kelabos.has(k)) {
        const e = new Error("ConditionalCheckFailedException");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      kelabos.set(k, { PK: `KELABO#${meta.kelaboId}`, SK: "META", ...meta });
    },
    // --- scheduled kelabos, invitations, directory -------------------------
    async createScheduledKelabo(meta) {
      const k = mkey(`KELABO#${meta.kelaboId}`, "META");
      if (kelabos.has(k)) {
        const e = new Error("ConditionalCheckFailedException");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      kelabos.set(k, { PK: `KELABO#${meta.kelaboId}`, SK: "META", ...meta });
    },
    async startScheduledKelabo({ kelaboId, tenantId, startedAt }) {
      const metaK = mkey(`KELABO#${kelaboId}`, "META");
      const meta = kelabos.get(metaK);
      if (!meta || meta.status !== "scheduled") {
        const e = new Error("ConditionalCheckFailedException");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      kelabos.set(metaK, { ...meta, status: "active", tenantStatus: `${tenantId}#active`, startedAt, hostJoinedAt: startedAt });
    },
    // Cancel/reschedule model the same `#status = :scheduled` condition the real
    // table enforces, so a test can prove a cancelled or already-live kelabo is
    // refused rather than mutated.
    async cancelScheduledKelabo({ kelaboId, tenantId, cancelledAt, reason, ttl }) {
      const k = mkey(`KELABO#${kelaboId}`, "META");
      const meta = kelabos.get(k);
      if (!meta || meta.status !== "scheduled") {
        const e = new Error("ConditionalCheckFailedException");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      meta.status = "cancelled";
      meta.tenantStatus = `${tenantId}#cancelled`;
      meta.cancelledAt = cancelledAt;
      meta.ttl = ttl;
      if (reason) meta.cancelReason = reason;
    },
    async rescheduleKelabo({ kelaboId, updates }) {
      const k = mkey(`KELABO#${kelaboId}`, "META");
      const meta = kelabos.get(k);
      if (!meta || meta.status !== "scheduled") {
        const e = new Error("ConditionalCheckFailedException");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      for (const [key, v] of Object.entries(updates)) meta[key] = v;
    },
    async resetInviteResponses(kelaboId) {
      for (const inv of [...kelabos.values()]) {
        if (inv.PK !== `KELABO#${kelaboId}` || !String(inv.SK).startsWith("INVITE#")) continue;
        if (inv.isHost || inv.response === "pending") continue;
        delete inv.respondedAt;
        inv.response = "pending";
      }
    },
    async putInvite(kelaboId, invite) {
      kelabos.set(mkey(`KELABO#${kelaboId}`, `INVITE#${invite.inviteKey}`), {
        PK: `KELABO#${kelaboId}`,
        SK: `INVITE#${invite.inviteKey}`,
        ...invite,
      });
    },
    async getInvite(kelaboId, inviteKey) {
      return kelabos.get(mkey(`KELABO#${kelaboId}`, `INVITE#${inviteKey}`)) || null;
    },
    async removeInvite(kelaboId, inviteKey) {
      kelabos.delete(mkey(`KELABO#${kelaboId}`, `INVITE#${inviteKey}`));
    },
    async listInvites(kelaboId) {
      return [...kelabos.values()].filter(
        (i) => i.PK === `KELABO#${kelaboId}` && String(i.SK).startsWith("INVITE#")
      );
    },
    // Mirrors `invitee-index`, sparse on `inviteKey` for the same reason
    // `listKelabosByStatus` below models `status-index` as sparse on
    // `tenantStatus`: only an INVITE# item ever carries either attribute.
    async listInvitesByIdentity(identity) {
      return [...kelabos.values()].filter(
        (i) =>
          String(i.SK).startsWith("INVITE#") &&
          i.inviteKey === identity &&
          typeof i.invitedAt === "number"
      );
    },
    // Mirrors the users table's `tenant-index`: registered users at one
    // domain, by address.
    async listUsersByTenant(tenantId, prefix, limit = 8) {
      return [...users.values()]
        .filter((u) => u.tenantId === tenantId && u.email && (!prefix || u.email.startsWith(prefix)))
        .sort((a, b) => a.email.localeCompare(b.email))
        .slice(0, limit);
    },
    // --- contacts: favourites (docs 18 §4) ---
    async listFavourites(owner) {
      return [...contacts.values()].filter(
        (r) => r.PK === `CONTACT#${owner}` && String(r.SK).startsWith("FAV#")
      );
    },
    async getFavourite(owner, peer) {
      return contacts.get(mkey(`CONTACT#${owner}`, `FAV#${peer}`)) || null;
    },
    async putFavourite({ owner, peer, tenantId }) {
      contacts.set(mkey(`CONTACT#${owner}`, `FAV#${peer}`), {
        PK: `CONTACT#${owner}`, SK: `FAV#${peer}`, owner, peer, tenantId, createdAt: Date.now(),
      });
    },
    async deleteFavourite(owner, peer) {
      contacts.delete(mkey(`CONTACT#${owner}`, `FAV#${peer}`));
    },
    async listAcceptedContacts(owner) {
      return [...contacts.values()]
        .filter((r) => r.PK === `CONTACT#${owner}` && String(r.SK).startsWith("PEER#") && r.state === "accepted")
        .map((r) => r.peer);
    },

    // Legacy cleanup only, matching src/db.js: nothing writes guard rows now.
    async deleteHostGuard(hostIdentity) {
      kelabos.delete(mkey(`HOSTACTIVE#${hostIdentity}`, "GUARD"));
    },
    // Mirrors DynamoDB's sparse-index behaviour on purpose: an item whose GSI
    // sort key is absent or not a Number is NOT in the index. Modelling this is
    // what turns "scheduled kelabos never appear in any list" from a
    // production discovery into a failing test.
    async listKelabosByStatus(tenantId, status) {
      return [...kelabos.values()].filter(
        (i) =>
          i.SK === "META" &&
          i.tenantStatus === `${tenantId}#${status}` &&
          // The sparse-index rule, enforced rather than assumed.
          typeof i.startedAt === "number"
      );
    },
    // Mirrors src/db.js's composition of the same two GSIs: same-tenant by
    // status-index, plus any kelabo elsewhere where identity holds an
    // INVITE# row, via invitee-index.
    async listKelabosByStatusForIdentity(identity, status) {
      const tenantId = identity.split("@")[1]?.toLowerCase();
      const sameTenant = [...kelabos.values()].filter(
        (i) => i.SK === "META" && i.tenantStatus === `${tenantId}#${status}` && typeof i.startedAt === "number"
      );
      const known = new Set(sameTenant.map((m) => m.kelaboId));
      const myInvites = [...kelabos.values()].filter(
        (i) => String(i.SK).startsWith("INVITE#") && i.inviteKey === identity && typeof i.invitedAt === "number"
      );
      const otherIds = [
        ...new Set(myInvites.map((i) => String(i.PK).slice("KELABO#".length)).filter((id) => id && !known.has(id))),
      ];
      const crossTenant = otherIds
        .map((id) => kelabos.get(mkey(`KELABO#${id}`, "META")))
        .filter((m) => m && m.status === status);
      return { sameTenant, crossTenant };
    },
    async updateKelaboMeta(kelaboId, updates) {
      const k = mkey(`KELABO#${kelaboId}`, "META");
      const item = kelabos.get(k);
      if (!item) return;
      for (const [key, v] of Object.entries(updates)) {
        if (v === null) delete item[key];
        else item[key] = v;
      }
    },
    async appendParticipant(kelaboId, participant) {
      const item = kelabos.get(mkey(`KELABO#${kelaboId}`, "META"));
      if (!item) return;
      item.participants = [...(item.participants || []), participant];
    },
    async queryContributions(kelaboId, { since, limit }) {
      let items = [...kelabos.values()]
        .filter((i) => i.PK === `KELABO#${kelaboId}` && i.SK.startsWith("CONTRIB#"))
        .sort((a, b) => (a.SK < b.SK ? -1 : 1));
      if (since) {
        items = items.filter((i) => i.SK > `CONTRIB#${pad(since)}`);
        return items.slice(0, limit);
      }
      return items.slice(-limit);
    },
    async _putContribution(kelaboId, c) {
      kelabos.set(mkey(`KELABO#${kelaboId}`, `CONTRIB#${pad(c.at)}`), {
        PK: `KELABO#${kelaboId}`,
        SK: `CONTRIB#${pad(c.at)}`,
        ...c,
      });
    },
    async getOtp(email) {
      return otp.get(`OTP#${email}`) || null;
    },
    async putOtp(item) {
      otp.set(`OTP#${item.email}`, { PK: `OTP#${item.email}`, ...item });
    },
    async deleteOtp(email) {
      otp.delete(`OTP#${email}`);
    },
    async incrementOtpAttempts(email) {
      const item = otp.get(`OTP#${email}`);
      if (item) item.attempts = (item.attempts || 0) + 1;
      return item;
    },
    async bumpIpCounter(ip, windowSeconds) {
      const k = `OTPIP#${ip}`;
      const item = otp.get(k) || { PK: k, count: 0, ttl: Math.floor(Date.now() / 1000) + windowSeconds };
      item.count += 1;
      otp.set(k, item);
      return item;
    },
    async getUser(email) {
      return users.get(`USER#${email}`) || null;
    },
    async getUserSettings(email) {
      const user = users.get(`USER#${email}`);
      if (!user?.settings) return null;
      return { settings: user.settings, updatedAt: user.settingsUpdatedAt ?? 0 };
    },
    async putUserSettings(email, settings, updatedAt) {
      const k = `USER#${email}`;
      const user = users.get(k) || { PK: k, email };
      const ts = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now();
      // Last-write-wins, like the real table's conditional update.
      if ((user.settingsUpdatedAt ?? 0) >= ts) return { settings: user.settings, updatedAt: user.settingsUpdatedAt };
      user.settings = settings;
      user.settingsUpdatedAt = ts;
      users.set(k, user);
      return { settings, updatedAt: ts };
    },
    async upsertUser({ email, displayName, tenantId }) {
      const k = `USER#${email}`;
      const existing = users.get(k);
      const now = Date.now();
      const user = {
        PK: k,
        email,
        displayName: existing?.displayName || displayName,
        createdAt: existing?.createdAt || now,
        lastLoginAt: now,
        tenantId,
      };
      users.set(k, user);
      return user;
    },
    async putRefreshToken(item) {
      refresh.set(`RT#${item.tokenId}`, { PK: `RT#${item.tokenId}`, ...item });
    },
    async getRefreshToken(tokenId) {
      return refresh.get(`RT#${tokenId}`) || null;
    },
    async setRefreshRevoked(tokenId, revoked = true, extra = {}) {
      const item = refresh.get(`RT#${tokenId}`);
      if (item) Object.assign(item, { revoked }, extra);
    },
    async listRefreshTokensByIdentity(identityHash) {
      return [...refresh.values()].filter((i) => i.identityHash === identityHash);
    },
    // Agent bridge pairing (docs 16). Device codes reuse the otp table's
    // TTL-keyed shape; agent tokens reuse the refresh table's revocable,
    // listable-by-identity shape — so the stub mirrors that split too.
    async putDeviceCode(item) {
      otp.set(`DEVICE#${item.deviceCode}`, { PK: `DEVICE#${item.deviceCode}`, ...item });
      otp.set(`USERCODE#${item.userCode}`, { PK: `USERCODE#${item.userCode}`, deviceCode: item.deviceCode });
    },
    async getDeviceCode(deviceCode) {
      return otp.get(`DEVICE#${deviceCode}`) || null;
    },
    async getDeviceCodeByUserCode(userCode) {
      const ptr = otp.get(`USERCODE#${userCode}`);
      return ptr ? otp.get(`DEVICE#${ptr.deviceCode}`) || null : null;
    },
    async approveDeviceCode(deviceCode, { identity, tenantId, approvedAt }) {
      const item = otp.get(`DEVICE#${deviceCode}`);
      if (!item || item.approvedAt) {
        const e = new Error("conditional check failed");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      Object.assign(item, { identity, tenantId, approvedAt });
    },
    async deleteDeviceCode(item) {
      otp.delete(`DEVICE#${item.deviceCode}`);
      otp.delete(`USERCODE#${item.userCode}`);
    },
    // Join codes reuse the otp table too. The conditional put is mirrored
    // faithfully because the mint loop retries on exactly that exception.
    async putJoinCode(item) {
      const k = `JOINCODE#${item.code}`;
      if (otp.has(k)) {
        const e = new Error("conditional check failed");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      otp.set(k, { PK: k, ...item });
    },
    async getJoinCode(code) {
      return otp.get(`JOINCODE#${code}`) || null;
    },
    async deleteJoinCode(code) {
      otp.delete(`JOINCODE#${code}`);
    },
    async bumpJoinCodeCounter(scope, windowSeconds) {
      const k = `JCODE#${scope}`;
      const item = otp.get(k) || { PK: k, count: 0, ttl: Math.floor(Date.now() / 1000) + windowSeconds };
      item.count += 1;
      otp.set(k, item);
      return item;
    },
    async putAgentToken(item) {
      refresh.set(`AGT#${item.jti}`, { PK: `AGT#${item.jti}`, ...item });
    },
    async getAgentToken(jti) {
      return refresh.get(`AGT#${jti}`) || null;
    },
    async setAgentTokenRevoked(jti, revoked = true) {
      const item = refresh.get(`AGT#${jti}`);
      if (!item) {
        const e = new Error("conditional check failed");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      Object.assign(item, { revoked, revokedAt: Date.now() });
    },
    async listAgentTokensByIdentity(identityHash) {
      return [...refresh.values()].filter(
        (i) => i.identityHash === identityHash && String(i.PK).startsWith("AGT#")
      );
    },
    // The history table holds two item shapes keyed by `archiveId`: the
    // authoritative row (archiveId = kelaboId) and one fan-out row per
    // participant (archiveId = "PARTICIPANT#<identity>#<kelaboId>").
    async listRecordsByParticipant(identity) {
      return [...history.values()]
        .filter((r) => r.participantIdentity === identity)
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    },
    async getHistory(archiveId) {
      return history.get(archiveId) || null;
    },
    async deleteHistoryRow(archiveId) {
      history.delete(archiveId);
    },
    async deleteParticipantIndexRow(identity, archiveId) {
      history.delete(`PARTICIPANT#${identity}#${archiveId}`);
    },
    async deleteKelaboPartition(kelaboId) {
      const prefix = `KELABO#${kelaboId}|`;
      let n = 0;
      for (const k of [...kelabos.keys()]) {
        if (k.startsWith(prefix)) {
          kelabos.delete(k);
          n++;
        }
      }
      return n;
    },
    async deleteHostGuardIfKelabo(hostIdentity, kelaboId) {
      const k = mkey(`HOSTACTIVE#${hostIdentity}`, "GUARD");
      if (kelabos.get(k)?.kelaboId === kelaboId) kelabos.delete(k);
    },
    // Test-only seams for arranging history state.
    __putHistory(row) {
      history.set(row.archiveId, row);
    },
    __historySize() {
      return history.size;
    },
    __kelaboItemCount(kelaboId) {
      return [...kelabos.keys()].filter((k) => k.startsWith(`KELABO#${kelaboId}|`)).length;
    },
    __putKelaboItem(kelaboId, SK, item) {
      kelabos.set(mkey(`KELABO#${kelaboId}`, SK), { PK: `KELABO#${kelaboId}`, SK, ...item });
    },
    async getMcpServers(scope) {
      // Mirror the real begins_with(SK, "SERVER#") condition — the same
      // partition also holds TOKEN# items.
      return [...mcp.values()].filter((i) => i.PK === `MCP#${scope}` && i.SK.startsWith("SERVER#"));
    },
    async putMcpServer(scope, server) {
      mcp.set(mkey(`MCP#${scope}`, `SERVER#${server.name}`), { PK: `MCP#${scope}`, SK: `SERVER#${server.name}`, ...server });
    },
    async deleteMcpServer(scope, name) {
      mcp.delete(mkey(`MCP#${scope}`, `SERVER#${name}`));
    },
    async getMcpToken(scope, name) {
      const item = mcp.get(mkey(`MCP#${scope}`, `TOKEN#${name}`));
      if (!item) return null;
      const { PK, SK, ...token } = item;
      return token;
    },
    async getMcpTokens(scope) {
      return [...mcp.values()]
        .filter((i) => i.PK === `MCP#${scope}` && i.SK.startsWith("TOKEN#"))
        .map(({ PK, SK, ...t }) => ({ name: SK.slice("TOKEN#".length), ...t }));
    },
    async putMcpToken(scope, name, token) {
      mcp.set(mkey(`MCP#${scope}`, `TOKEN#${name}`), { PK: `MCP#${scope}`, SK: `TOKEN#${name}`, ...token });
    },
    async deleteMcpToken(scope, name) {
      mcp.delete(mkey(`MCP#${scope}`, `TOKEN#${name}`));
    },
    async getMcpClient(issuer) {
      const item = mcp.get(mkey("MCP#client", `AS#${issuer}`));
      if (!item) return null;
      const { PK, SK, ...reg } = item;
      return reg;
    },
    async putMcpClient(issuer, registration) {
      mcp.set(mkey("MCP#client", `AS#${issuer}`), { PK: "MCP#client", SK: `AS#${issuer}`, ...registration });
    },

    // --- journeys (docs 20), mirroring src/db.js -----------------------------

    async createJourney(meta) {
      const k = mkey(`JOURNEY#${meta.journeyId}`, "META");
      if (journeys.has(k)) throw conditionFailed();
      journeys.set(k, { PK: `JOURNEY#${meta.journeyId}`, SK: "META", ...meta });
    },
    async getJourneyMeta(journeyId) {
      return journeys.get(mkey(`JOURNEY#${journeyId}`, "META")) || null;
    },
    async updateJourneyMeta(journeyId, updates) {
      const item = journeys.get(mkey(`JOURNEY#${journeyId}`, "META"));
      if (!item) return;
      for (const [key, v] of Object.entries(updates)) {
        if (v === null) delete item[key];
        else item[key] = v;
      }
    },
    async completeJourney({ journeyId, tenantId, completedAt, completedBy }) {
      const k = mkey(`JOURNEY#${journeyId}`, "META");
      const meta = journeys.get(k);
      if (!meta || meta.status !== "active") throw conditionFailed();
      Object.assign(meta, {
        status: "completed",
        tenantStatus: `${tenantId}#completed`,
        completedAt,
        completedBy,
        updatedAt: completedAt,
      });
    },
    async reopenJourney({ journeyId, tenantId, reopenedAt }) {
      const k = mkey(`JOURNEY#${journeyId}`, "META");
      const meta = journeys.get(k);
      if (!meta || meta.status !== "completed") throw conditionFailed();
      Object.assign(meta, { status: "active", tenantStatus: `${tenantId}#active`, reopenedAt, updatedAt: reopenedAt });
    },
    // Sparse on `tenantStatus`, like `listKelabosByStatus` above: only a META
    // item ever carries it.
    async listJourneysByTenantStatus(tenantId, status) {
      return [...journeys.values()].filter(
        (i) => i.SK === "META" && i.tenantStatus === `${tenantId}#${status}`
      );
    },
    // Sparse on `accessorIdentity`, like `listInvitesByIdentity` above: only
    // an ACCESSOR# item ever carries it.
    async listAccessorJourneys(identity) {
      return [...journeys.values()].filter(
        (i) => String(i.SK).startsWith("ACCESSOR#") && i.accessorIdentity === identity
      );
    },
    async putJourneyDescriptionVersion(journeyId, version) {
      journeys.set(mkey(`JOURNEY#${journeyId}`, `DESC#${padVersion(version.version)}`), {
        PK: `JOURNEY#${journeyId}`,
        SK: `DESC#${padVersion(version.version)}`,
        ...version,
      });
    },
    async listJourneyDescriptionVersions(journeyId) {
      return [...journeys.values()]
        .filter((i) => i.PK === `JOURNEY#${journeyId}` && String(i.SK).startsWith("DESC#"))
        .sort((a, b) => (a.SK < b.SK ? 1 : -1));
    },
    async putJourneyStatusVersion(journeyId, version) {
      journeys.set(mkey(`JOURNEY#${journeyId}`, `STATUS#${padVersion(version.version)}`), {
        PK: `JOURNEY#${journeyId}`,
        SK: `STATUS#${padVersion(version.version)}`,
        ...version,
      });
    },
    async listJourneyStatusVersions(journeyId) {
      return [...journeys.values()]
        .filter((i) => i.PK === `JOURNEY#${journeyId}` && String(i.SK).startsWith("STATUS#"))
        .sort((a, b) => (a.SK < b.SK ? 1 : -1));
    },
    // Timeline (docs 20 §9) — `pad13` mirrors CONTRIB_KEY_WIDTH so `before`
    // comparisons behave the same way `queryContributions`'s `since` does.
    async putJourneyTimelineEntry(journeyId, entry) {
      const at = entry.at ?? Date.now();
      const sk = `TL#${pad(at)}#${Math.random().toString(36).slice(2, 8)}`;
      journeys.set(mkey(`JOURNEY#${journeyId}`, sk), { PK: `JOURNEY#${journeyId}`, SK: sk, ...entry, at });
    },
    async listJourneyTimeline(journeyId, { type, before, limit }) {
      let items = [...journeys.values()]
        .filter((i) => i.PK === `JOURNEY#${journeyId}` && String(i.SK).startsWith("TL#"))
        .sort((a, b) => (a.SK < b.SK ? 1 : -1)); // newest first
      if (before) items = items.filter((i) => i.SK < `TL#${pad(before)}`);
      if (type) items = items.filter((i) => i.type === type);
      return items.slice(0, limit);
    },
    async putAccessor(journeyId, accessor) {
      journeys.set(mkey(`JOURNEY#${journeyId}`, `ACCESSOR#${accessor.identity}`), {
        PK: `JOURNEY#${journeyId}`,
        SK: `ACCESSOR#${accessor.identity}`,
        accessorIdentity: accessor.identity,
        ...accessor,
      });
    },
    async getAccessor(journeyId, identity) {
      return journeys.get(mkey(`JOURNEY#${journeyId}`, `ACCESSOR#${identity}`)) || null;
    },
    async removeAccessor(journeyId, identity) {
      journeys.delete(mkey(`JOURNEY#${journeyId}`, `ACCESSOR#${identity}`));
    },
    async listAccessors(journeyId) {
      return [...journeys.values()].filter(
        (i) => i.PK === `JOURNEY#${journeyId}` && String(i.SK).startsWith("ACCESSOR#")
      );
    },
    // --- message board (docs 20 §7) — heads and #V# versions share the
    // BOARDMSG# prefix, told apart by whether the SK contains "#V#",
    // mirroring src/db.js exactly.
    async createBoardMessageHead(journeyId, head) {
      const k = mkey(`JOURNEY#${journeyId}`, `BOARDMSG#${head.msgId}`);
      if (journeys.has(k)) throw conditionFailed();
      journeys.set(k, { PK: `JOURNEY#${journeyId}`, SK: `BOARDMSG#${head.msgId}`, ...head });
    },
    async putBoardMessageHead(journeyId, head) {
      journeys.set(mkey(`JOURNEY#${journeyId}`, `BOARDMSG#${head.msgId}`), {
        PK: `JOURNEY#${journeyId}`,
        SK: `BOARDMSG#${head.msgId}`,
        ...head,
      });
    },
    async getBoardMessageHead(journeyId, msgId) {
      return journeys.get(mkey(`JOURNEY#${journeyId}`, `BOARDMSG#${msgId}`)) || null;
    },
    async listBoardMessageHeads(journeyId) {
      return [...journeys.values()].filter(
        (i) => i.PK === `JOURNEY#${journeyId}` && String(i.SK).startsWith("BOARDMSG#") && !String(i.SK).includes("#V#")
      );
    },
    async putBoardMessageVersion(journeyId, version) {
      const sk = `BOARDMSG#${version.msgId}#V#${padVersion(version.version)}`;
      journeys.set(mkey(`JOURNEY#${journeyId}`, sk), { PK: `JOURNEY#${journeyId}`, SK: sk, ...version });
    },
    async listBoardMessageVersions(journeyId, msgId) {
      return [...journeys.values()]
        .filter((i) => i.PK === `JOURNEY#${journeyId}` && String(i.SK).startsWith(`BOARDMSG#${msgId}#V#`))
        .sort((a, b) => (a.SK < b.SK ? 1 : -1));
    },
    // --- documents (docs 20 §8) — one item per document, never versioned.
    async createDocument(journeyId, item) {
      const k = mkey(`JOURNEY#${journeyId}`, `DOC#${item.docId}`);
      if (journeys.has(k)) throw conditionFailed();
      journeys.set(k, { PK: `JOURNEY#${journeyId}`, SK: `DOC#${item.docId}`, ...item });
    },
    async putDocument(journeyId, item) {
      journeys.set(mkey(`JOURNEY#${journeyId}`, `DOC#${item.docId}`), {
        PK: `JOURNEY#${journeyId}`,
        SK: `DOC#${item.docId}`,
        ...item,
      });
    },
    async getDocument(journeyId, docId) {
      return journeys.get(mkey(`JOURNEY#${journeyId}`, `DOC#${docId}`)) || null;
    },
    async listDocuments(journeyId) {
      return [...journeys.values()].filter(
        (i) => i.PK === `JOURNEY#${journeyId}` && String(i.SK).startsWith("DOC#")
      );
    },
    // Models the real TransactWriteCommand as a check-then-write, which is
    // safe here because the stub is single-threaded: both conditions
    // (LINK# absent, journey active) are checked before anything is written,
    // matching the all-or-nothing shape the real transaction guarantees.
    async linkKelaboToJourney({ journeyId, kelaboId, link, mirror }) {
      const linkKey = mkey(`JOURNEY#${journeyId}`, `LINK#${kelaboId}`);
      const metaKey = mkey(`JOURNEY#${journeyId}`, "META");
      const meta = journeys.get(metaKey);
      if (journeys.has(linkKey) || !meta || meta.status !== "active") throw conditionFailed();
      journeys.set(linkKey, { PK: `JOURNEY#${journeyId}`, SK: `LINK#${kelaboId}`, ...link });
      meta.kelaboCount = (meta.kelaboCount || 0) + 1;
      meta.updatedAt = link.linkedAt;
      kelabos.set(mkey(`KELABO#${kelaboId}`, `JOURNEY#${journeyId}`), {
        PK: `KELABO#${kelaboId}`,
        SK: `JOURNEY#${journeyId}`,
        ...mirror,
      });
    },
    async unlinkKelaboFromJourney({ journeyId, kelaboId, now }) {
      journeys.delete(mkey(`JOURNEY#${journeyId}`, `LINK#${kelaboId}`));
      const meta = journeys.get(mkey(`JOURNEY#${journeyId}`, "META"));
      if (meta) {
        meta.kelaboCount = Math.max(0, (meta.kelaboCount || 0) - 1);
        meta.updatedAt = now;
      }
      kelabos.delete(mkey(`KELABO#${kelaboId}`, `JOURNEY#${journeyId}`));
    },
    async getJourneyLink(journeyId, kelaboId) {
      return journeys.get(mkey(`JOURNEY#${journeyId}`, `LINK#${kelaboId}`)) || null;
    },
    async listJourneyLinks(journeyId) {
      return [...journeys.values()].filter(
        (i) => i.PK === `JOURNEY#${journeyId}` && String(i.SK).startsWith("LINK#")
      );
    },
    // The mirror on the KELABO's own partition (docs 20 §4.3) — reuses the
    // same `kelabos` map every other kelabo-partition item lives in.
    async listKelaboJourneyLinks(kelaboId) {
      return [...kelabos.values()].filter(
        (i) => i.PK === `KELABO#${kelaboId}` && String(i.SK).startsWith("JOURNEY#")
      );
    },
    async deleteKelaboJourneyMirror(kelaboId, journeyId) {
      kelabos.delete(mkey(`KELABO#${kelaboId}`, `JOURNEY#${journeyId}`));
    },
    async deleteJourneyChildren(journeyId) {
      const prefix = `JOURNEY#${journeyId}|`;
      let n = 0;
      for (const k of [...journeys.keys()]) {
        if (k.startsWith(prefix) && k !== `${prefix}META`) {
          journeys.delete(k);
          n++;
        }
      }
      return n;
    },
    async deleteJourneyMeta(journeyId) {
      journeys.delete(mkey(`JOURNEY#${journeyId}`, "META"));
    },
    async putJourneyReport(journeyId, report) {
      journeys.set(mkey(`JOURNEY#${journeyId}`, `REPORT#${report.reportId}`), {
        PK: `JOURNEY#${journeyId}`,
        SK: `REPORT#${report.reportId}`,
        ...report,
      });
    },
    async getJourneyReport(journeyId, reportId) {
      return journeys.get(mkey(`JOURNEY#${journeyId}`, `REPORT#${reportId}`)) || null;
    },
    async listJourneyReports(journeyId) {
      return [...journeys.values()].filter(
        (i) => i.PK === `JOURNEY#${journeyId}` && String(i.SK).startsWith("REPORT#")
      );
    },
    async markJourneyReportFailed(journeyId, reportId, error) {
      const item = journeys.get(mkey(`JOURNEY#${journeyId}`, `REPORT#${reportId}`));
      if (item) Object.assign(item, { status: "failed", error });
    },
    async bumpContributor(journeyId, identity, field) {
      const k = mkey(`JOURNEY#${journeyId}`, `CONTRIBUTOR#${identity}`);
      const now = Date.now();
      const item = journeys.get(k) || {
        PK: `JOURNEY#${journeyId}`,
        SK: `CONTRIBUTOR#${identity}`,
        contributorIdentity: identity,
        firstSeenAt: now,
      };
      item[field] = (item[field] || 0) + 1;
      item.lastActiveAt = now;
      journeys.set(k, item);
    },
    async listContributors(journeyId) {
      return [...journeys.values()].filter(
        (i) => i.PK === `JOURNEY#${journeyId}` && String(i.SK).startsWith("CONTRIBUTOR#")
      );
    },
    // Test-only seams for arranging journey state.
    __journeySize() {
      return journeys.size;
    },
    __putJourneyItem(journeyId, SK, item) {
      journeys.set(mkey(`JOURNEY#${journeyId}`, SK), { PK: `JOURNEY#${journeyId}`, SK, ...item });
    },
  };
}
