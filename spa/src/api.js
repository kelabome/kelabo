import { config } from './config'

function qs(params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v != null)
  return entries.length ? '?' + new URLSearchParams(entries).toString() : ''
}

async function request(base, path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let err = { code: 'http_' + res.status, status: res.status, message: res.statusText }
    try {
      const data = await res.json()
      err = { ...err, ...data, code: data.error ?? err.code }
    } catch {}
    throw err
  }
  if (res.status === 204) return null
  const text = await res.text()
  try { return text ? JSON.parse(text) : null } catch { return text }
}

const apiRequest = (path, opts) => request(config.apiBase, path, opts)

export const api = {
  me: () => apiRequest('/me'),
  getSettings: () => apiRequest('/me/settings'),
  putSettings: body => apiRequest('/me/settings', { method: 'PUT', body }),
  getMcp: () => apiRequest('/me/mcp'),
  putMcp: server => apiRequest('/me/mcp', { method: 'PUT', body: server }),
  deleteMcp: name => apiRequest(`/me/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  probeMcp: url => apiRequest('/me/mcp/probe', { method: 'POST', body: { url } }),
  // A full-page navigation, not a fetch: the OAuth flow ends with the
  // authorization server redirecting the browser back to /settings.
  mcpOauthStartUrl: name => `${config.apiBase}/me/mcp/${encodeURIComponent(name)}/oauth/start`,
  disconnectMcpOauth: name =>
    apiRequest(`/me/mcp/${encodeURIComponent(name)}/oauth`, { method: 'DELETE' }),
  refresh: () => apiRequest('/auth/refresh', { method: 'POST' }),
  otpRequest: email => apiRequest('/auth/otp/request', { method: 'POST', body: { email } }),
  otpVerify: (email, code) => apiRequest('/auth/otp/verify', { method: 'POST', body: { email, code } }),
  logoutAll: () => apiRequest('/logout-all', { method: 'POST' }),
  listKelabos: () => apiRequest('/kelabos'),
  createKelabo: (title, opts = {}) =>
    apiRequest('/kelabos', {
      method: 'POST',
      body: {
        title,
        ...(opts.mcpEnabled === false ? { mcpEnabled: false } : {}),
        ...(opts.rtcMode ? { rtcMode: opts.rtcMode } : {}),
        // Opt-in, so it is only ever sent when true — the server's default is no.
        ...(opts.historyEnabled ? { historyEnabled: true } : {}),
        // Link into one or more journeys at creation time (docs 20 §11) —
        // the field already exists server-side; this call just used to
        // silently drop it.
        ...(opts.journeyIds?.length ? { journeyIds: opts.journeyIds } : {}),
      },
    }),
  getKelabo: id => apiRequest(`/kelabos/${id}`),

  // --- scheduling -----------------------------------------------------------
  scheduleKelabo: body => apiRequest('/kelabos/schedule', { method: 'POST', body }),
  listScheduled: () => apiRequest('/kelabos/scheduled'),
  getScheduled: id => apiRequest(`/kelabos/${id}/scheduled`),
  startScheduled: id => apiRequest(`/kelabos/${id}/start-scheduled`, { method: 'POST' }),
  cancelKelabo: (id, reason) =>
    apiRequest(`/kelabos/${id}/cancel`, { method: 'POST', body: reason ? { reason } : {} }),
  rescheduleKelabo: (id, body) =>
    apiRequest(`/kelabos/${id}/reschedule`, { method: 'POST', body }),
  updateInvitees: (id, invitees) =>
    apiRequest(`/kelabos/${id}/invitees`, { method: 'POST', body: { invitees } }),
  // Deliberately reachable without a session: the invitation link is meant to
  // work for people who have no account.
  getInvitation: id => apiRequest(`/kelabos/${id}/invitation`),
  rsvp: (id, response, displayName) =>
    apiRequest(`/kelabos/${id}/rsvp`, {
      method: 'POST',
      body: { response, ...(displayName ? { displayName } : {}) },
    }),
  // Registered users at your own email domain — see rest-api/scheduling.js.
  searchPeople: q => apiRequest(`/people/search${qs({ q })}`),

  // --- contacts / favourites (docs 18 §4) -----------------------------------
  // Favourites are private, one-way, same-org markers: the other person is never
  // told. `listContacts` returns the pinned colleagues; add/remove take effect
  // immediately and are idempotent.
  listContacts: () => apiRequest('/contacts'),
  favouriteContact: email => apiRequest('/contacts/favourites', { method: 'POST', body: { email } }),
  unfavouriteContact: email => apiRequest(`/contacts/favourites/${encodeURIComponent(email)}`, { method: 'DELETE' }),

  // --- huddle / ring (docs 18 §6): "call" an online contact ------------------
  // Start an instant kelabo and ring people into it.
  huddle: (invitees, { title, private: priv } = {}) =>
    apiRequest('/huddles', { method: 'POST', body: { invitees, ...(title ? { title } : {}), ...(priv ? { private: true } : {}) } }),
  // Ring more people into a kelabo that is already live.
  ringInto: (kelaboId, invitees) => apiRequest(`/kelabos/${kelaboId}/ring`, { method: 'POST', body: { invitees } }),
  // Answer a ring (accepted | declined) and hang up (ringer cancels).
  answerRing: (kelaboId, response) => apiRequest(`/kelabos/${kelaboId}/ring/answer`, { method: 'POST', body: { response } }),
  cancelRing: kelaboId => apiRequest(`/kelabos/${kelaboId}/ring/cancel`, { method: 'POST' }),

  // --- agent bridge pairing (docs 16) ---------------------------------------
  // The developer's terminal prints a code; approving it here is what delegates
  // their identity to a coding agent on their own machine.
  getPendingAgent: code => apiRequest(`/agent/device/pending${qs({ code })}`),
  approveAgent: userCode => apiRequest('/agent/device/approve', { method: 'POST', body: { userCode } }),
  listAgents: () => apiRequest('/agent/tokens'),
  revokeAgent: jti => apiRequest(`/agent/tokens/${encodeURIComponent(jti)}`, { method: 'DELETE' }),
  joinKelabo: (id, displayName, mode) =>
    apiRequest(`/kelabos/${id}/join`, { method: 'POST', body: { displayName, mode } }),

  // --- join codes -----------------------------------------------------------
  // A two-minute code you can read down a phone. Minting takes the participant
  // cookie the room already holds; redeeming needs nothing, because the person
  // holding a code is by definition someone with no link and maybe no account.
  // Redeem resolves to a kelaboId and stops — the caller then goes to /join/:id
  // like anybody else, so there is only ever one way into a kelabo.
  mintJoinCode: id => apiRequest(`/kelabos/${id}/join-code`, { method: 'POST' }),
  redeemJoinCode: code => apiRequest('/join-code/redeem', { method: 'POST', body: { code } }),
  endKelabo: id => apiRequest(`/kelabos/${id}/end`, { method: 'POST' }),
  startKelabo: id => apiRequest(`/kelabos/${id}/start`, { method: 'POST' }),
  generateMinutes: id => apiRequest(`/kelabos/${id}/minutes`, { method: 'POST' }),
  getBoard: (id, { limit, since } = {}) => apiRequest(`/kelabos/${id}/board${qs({ limit, since })}`),
  sttToken: (id, opts = {}) =>
    apiRequest(`/kelabos/${id}/stt-token`, {
      method: 'POST',
      body: { language: opts.language, diarize: !!opts.diarize },
    }),
  listRecords: () => apiRequest('/records'),
  searchRecords: q => apiRequest(`/records/search${qs({ q })}`),
  getRecord: id => apiRequest(`/records/${id}`),
  // Host: destroys the record. Participant: only drops it from their own list.
  // The response's `outcome` says which happened.
  deleteRecord: id => apiRequest(`/records/${id}`, { method: 'DELETE' }),
  // dryRun: true reports what would be deleted without touching anything.
  purgeRecords: (value, unit, dryRun) =>
    apiRequest('/records/purge', { method: 'POST', body: { value, unit, dryRun: !!dryRun } }),

  // --- Journey (docs 20) -----------------------------------------------------
  // A persistent container linking related kelabos so decisions, documents and
  // Q&A history carry from one meeting to the next. Access (owner /
  // public-tenant-member / private-accessor) is resolved server-side on every
  // call — nothing here decides who may see or write what.
  listJourneys: () => apiRequest('/journeys'),
  createJourney: body => apiRequest('/journeys', { method: 'POST', body }),
  getJourney: id => apiRequest(`/journeys/${id}`),
  patchJourney: (id, body) => apiRequest(`/journeys/${id}`, { method: 'PATCH', body }),
  completeJourney: id => apiRequest(`/journeys/${id}/complete`, { method: 'POST' }),
  reopenJourney: id => apiRequest(`/journeys/${id}/reopen`, { method: 'POST' }),
  deleteJourney: id => apiRequest(`/journeys/${id}`, { method: 'DELETE' }),

  listJourneyAccessors: id => apiRequest(`/journeys/${id}/accessors`),
  addJourneyAccessor: (id, identity) => apiRequest(`/journeys/${id}/accessors`, { method: 'POST', body: { identity } }),
  removeJourneyAccessor: (id, identity) =>
    apiRequest(`/journeys/${id}/accessors/${encodeURIComponent(identity)}`, { method: 'DELETE' }),

  listJourneyKelabos: id => apiRequest(`/journeys/${id}/kelabos`),
  linkJourneyKelabo: (id, kelaboId) => apiRequest(`/journeys/${id}/kelabos`, { method: 'POST', body: { kelaboId } }),
  unlinkJourneyKelabo: (id, kelaboId) => apiRequest(`/journeys/${id}/kelabos/${kelaboId}`, { method: 'DELETE' }),

  updateJourneyDescription: (id, body) => apiRequest(`/journeys/${id}/description`, { method: 'POST', body }),
  getJourneyDescriptionHistory: id => apiRequest(`/journeys/${id}/description/history`),

  updateJourneyStatus: (id, body) => apiRequest(`/journeys/${id}/status`, { method: 'POST', body }),
  getJourneyStatusHistory: id => apiRequest(`/journeys/${id}/status/history`),

  getJourneyTimeline: (id, { type, before, limit } = {}) =>
    apiRequest(`/journeys/${id}/timeline${qs({ type, before, limit })}`),

  listJourneyBoard: id => apiRequest(`/journeys/${id}/board`),
  addJourneyBoardMessage: (id, content) => apiRequest(`/journeys/${id}/board`, { method: 'POST', body: { content } }),
  editJourneyBoardMessage: (id, msgId, content) =>
    apiRequest(`/journeys/${id}/board/${msgId}`, { method: 'PATCH', body: { content } }),
  archiveJourneyBoardMessage: (id, msgId) => apiRequest(`/journeys/${id}/board/${msgId}/archive`, { method: 'POST' }),
  unarchiveJourneyBoardMessage: (id, msgId) => apiRequest(`/journeys/${id}/board/${msgId}/unarchive`, { method: 'POST' }),
  getJourneyBoardMessageHistory: (id, msgId) => apiRequest(`/journeys/${id}/board/${msgId}/history`),

  listJourneyDocuments: id => apiRequest(`/journeys/${id}/documents`),
  addJourneyDocument: (id, body) => apiRequest(`/journeys/${id}/documents`, { method: 'POST', body }),
  getJourneyDocument: (id, docId) => apiRequest(`/journeys/${id}/documents/${docId}`),
  removeJourneyDocument: (id, docId) => apiRequest(`/journeys/${id}/documents/${docId}`, { method: 'DELETE' }),

  // Generation happens in the Gateway (it holds the LLM credential); this
  // call returns `{reportId, status:"pending"}` immediately-ish and the
  // finished row is read back separately, the same "mutating call returns a
  // summary" shape every other create endpoint here follows.
  requestJourneyReport: (id, question) => apiRequest(`/journeys/${id}/reports`, { method: 'POST', body: { question } }),
  listJourneyReports: id => apiRequest(`/journeys/${id}/reports`),
  getJourneyReport: (id, reportId) => apiRequest(`/journeys/${id}/reports/${reportId}`),
  listJourneyContributors: id => apiRequest(`/journeys/${id}/contributors`),
}

// Conference audio (docs 15). All of it lives on the Gateway, next to the SSE
// stream that carries the signalling back down: the Cloudflare app credentials
// never leave the server, and the client only ever handles SDP plus short-lived
// ICE credentials.
export const rtc = {
  join: kelaboId => request(config.gatewayBase, '/rtc/join', { method: 'POST', body: { kelaboId } }),
  leave: kelaboId => request(config.gatewayBase, '/rtc/leave', { method: 'POST', body: { kelaboId } }),
  ice: kelaboId => request(config.gatewayBase, '/rtc/ice', { method: 'POST', body: { kelaboId } }),
  media: (kelaboId, media) =>
    request(config.gatewayBase, '/rtc/media', { method: 'POST', body: { kelaboId, ...media } }),
  // Authoritative membership snapshot for the reconcile loop — SSE events are
  // single-delivery, and one missed `peer_joined` used to skew the roster for
  // the rest of the kelabo.
  roster: kelaboId => request(config.gatewayBase, '/rtc/roster', { method: 'POST', body: { kelaboId } }),
  signal: (kelaboId, to, signal) =>
    request(config.gatewayBase, '/rtc/signal', { method: 'POST', body: { kelaboId, to, signal } }),
  sfuSession: (kelaboId, sessionDescription) =>
    request(config.gatewayBase, '/rtc/sfu/session', { method: 'POST', body: { kelaboId, sessionDescription } }),
  sfuTracks: (kelaboId, body) =>
    request(config.gatewayBase, '/rtc/sfu/tracks', { method: 'POST', body: { kelaboId, ...body } }),
  sfuRenegotiate: (kelaboId, sessionDescription) =>
    request(config.gatewayBase, '/rtc/sfu/renegotiate', { method: 'PUT', body: { kelaboId, sessionDescription } }),
  sfuCloseTracks: (kelaboId, tracks) =>
    request(config.gatewayBase, '/rtc/sfu/tracks/close', { method: 'PUT', body: { kelaboId, tracks } }),
}

export function postCaption(payload) {
  return request(config.gatewayBase, '/caption', { method: 'POST', body: payload })
}

export function renameSpeaker({ kelaboId, from, to }) {
  return request(config.gatewayBase, '/caption/rename', { method: 'POST', body: { kelaboId, from, to } })
}

/** The persisted messages of a live kelabo, entitlement-filtered server-side
 *  and paged newest-first: pass `before` (the previous response's `nextBefore`)
 *  to fetch the next older page. Returns { transcriptAccess, utterances,
 *  hasMore, nextBefore? } — see gateway/src/caption.js. */
export function getCaptionHistory(kelaboId, { before } = {}) {
  const params = new URLSearchParams({ kelaboId })
  if (before) params.set('before', before)
  return request(config.gatewayBase, `/caption/history?${params}`)
}

export function boardStreamUrl(kelaboId) {
  return `${config.gatewayBase}/caption/replies?kelaboId=${encodeURIComponent(kelaboId)}`
}

// Contact presence stream (docs 18 §5). Authenticated by the session cookie
// (sent because EventSource is opened withCredentials), not a kelabo cookie.
export function presenceStreamUrl() {
  return `${config.gatewayBase}/presence/stream`
}

export function oidcStartUrl(provider) {
  return `${config.apiBase}/auth/oidc/${provider}/start`
}

export function logout() {
  window.location = config.apiBase + '/logout'
}
