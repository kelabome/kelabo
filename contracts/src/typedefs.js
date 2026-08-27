/**
 * Kelabo shared typedefs (doc 10-data-contracts). Pure JSDoc — import for
 * editor intellisense only; runtime validation lives in schemas.js.
 */

/**
 * @typedef {Object} Utterance
 * @property {string}  kelaboId
 * @property {string}  clientId
 * @property {string}  speaker
 * @property {string}  text
 * @property {number}  tStart
 * @property {number}  tEnd
 * @property {boolean} isFinal
 * @property {string}  [tenantId]
 * @property {string}  [lang]
 * @property {string}  [tr]
 * @property {"speech"|"typed"} [source] absent = "speech" (pre-2026-08 rows)
 */

/**
 * @typedef {Object} Contribution
 * @property {string} id
 * @property {string} kelaboId
 * @property {"LLM_CON"|"note"} tag
 * @property {"answer"|"link"|"code"|"clarify"|"minutes"|"note"} kind
 * @property {string} title
 * @property {string} to
 * @property {string} markdown
 * @property {Array<{title:string,url?:string}>} [sources]
 * @property {number} [confidence]
 * @property {string} author
 * @property {"server"|"opencode"|"local"} [origin]
 * @property {number} at
 * @property {string} [tenantId]
 */

/**
 * @typedef {Object} MinutesDoc
 * @property {string} kelaboId
 * @property {string[]} topics
 * @property {string[]} decisions
 * @property {Array<{text:string,owner?:string}>} actionItems
 * @property {string[]} openQuestions
 * @property {string[]} findings
 * @property {number} generatedAt
 * @property {string} generatedBy
 */

/** @typedef {{kelaboId:string, text:string, isFinal:true, speaker?:string,
 *             tStart:number, tEnd:number, human?:boolean}} CaptionPost */

/** @typedef {{kind:"identity", identity:string, tenantId:string, exp:number}} SessionCookie */
/** @typedef {{kind:"participant", kelaboId:string, identity:string,
 *             tenantId:string, isGuest:boolean, exp:number}} ParticipantCookie */

/** @typedef {{tokenId:string, identityHash:string, hash:string,
 *             chainId:string, rotatedFrom?:string, revoked:boolean,
 *             expiresAt:number, createdAt:number, tenantId:string}} RefreshToken */

/** @typedef {{sub:string, tenant:string, role:"dev"|"user",
 *             iat:number, exp:number, aud?:string}} AppJwt */

/** A developer's local agent bridge credential (docs 16 §6). Long-lived and
 *  revocable by `jti`, minted only by the device-code pairing flow. `aud`
 *  distinguishes it from the session cookie and the internal JWT, which share
 *  the same signing key.
 *  @typedef {{sub:string, tenant:string, role:"dev", aud:"kelabo-agent",
 *             jti:string, label:string, iat:number, exp:number}} AgentJwt */

/** Pending device-code pairing. `userCode` is what the developer types into the
 *  portal; `deviceCode` is what the bridge polls with.
 *  @typedef {{deviceCode:string, userCode:string, runtime:string, label:string,
 *             identity?:string, tenantId?:string, approvedAt?:number,
 *             createdAt:number, expiresAt:number}} AgentDeviceCode */

/** What the Gateway records about the agent bound to a kelabo. Runtime-agnostic:
 *  `sessionRef` and `workspace` are opaque and never interpreted.
 *  @typedef {{runtime:string, sessionRef:string, workspace:string, label:string,
 *             boundBy:string, boundAt:number}} AgentBinding */

/**
 * @typedef {Object} Archive
 * @property {string} archiveId
 * @property {string} kelaboId
 * @property {string} title
 * @property {string} host
 * @property {Array<{identity:string,displayName:string,isGuest:boolean}>} participants
 * @property {number} startedAt
 * @property {number} endedAt
 * @property {Utterance[]} transcript
 * @property {Contribution[]} board
 * @property {MinutesDoc} [minutes]
 * @property {string} [tenantId]
 */

/**
 * @typedef {Object} McpServer
 * @property {string} name
 * @property {"http"|"local"} transport
 * @property {string} [url]
 * @property {Object} [headers]
 * @property {boolean} [hasSecret]
 * @property {boolean} enabled
 */
/** @typedef {{servers: McpServer[]}} McpConfig */

/** @typedef {{kelaboId:string, trigger:Utterance, window:Utterance[],
 *             capabilities:string[], mcp:McpConfig, model:ModelConfig}} AgentContext */
/** @typedef {{run:(ctx:AgentContext)=>AsyncIterable<Contribution>}} AgentRunner */
/** @typedef {{provider:string, model:string, smallModel:string}} ModelConfig */
/** @typedef {{stream:(req:object)=>AsyncIterable<string>, complete:(req:object)=>Promise<string>}} LlmProvider */

/** @typedef {{email:string}} OtpRequestBody */
/** @typedef {{email:string, code:string}} OtpVerifyBody */
/** @typedef {{email:string, displayName:string}} Identity */
/** @typedef {{title?:string,
 *             translation?:{enabled:boolean, targetLang?:string}}} CreateKelaboBody */
/* * @typedef {"scheduled"|"active"|"ended"|"cancelled"} KelaboStatus */
/** @typedef {{kelaboId:string, title:string, status:KelaboStatus,
 *             joinUrl:string}} KelaboCreated */
/** @typedef {{kelaboId:string, title:string, status:string,
 *             participantCount:number, startedAt:number, hostIdentity:string,
 *             hasMinutes:boolean}} KelaboSummary */
/** @typedef {{displayName:string, mode:"audio-board"|"board-only"}} JoinBody */
/** @typedef {{kelaboId:string, gatewayBaseUrl:string,
 *             participant:{identity:string, displayName:string, isGuest:boolean}}} JoinResult */
/**
 * What POST /kelabos/:id/stt-token returns: everything a browser needs to open
 * a transcription stream *directly* to the provider, and nothing it could have
 * worked out for itself.
 *
 * `provider` is the id the SPA resolves an `SttClient` with, and it comes from
 * the server rather than the build because which provider a deployment uses is
 * a config decision (`config.stt.provider`), not a property of the frontend.
 * `params` is deliberately opaque and is forwarded to the provider unread —
 * query parameters for one, a configuration frame for another. Only the server
 * decides what is in it, which is what keeps model and feature selection off
 * the client.
 *
 * @typedef {{provider:string, url:string, token:string,
 *            expiresInSeconds:number, params:Object}} SttSession
 */
/** @typedef {{archiveId:string, title:string, startedAt:number, endedAt:number,
 *             participantCount:number, hasMinutes:boolean}} RecordSummary */

export {};
