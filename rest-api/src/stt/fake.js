import { err } from "../errors.js";

// A transcription provider that transcribes nothing, for end-to-end tests.
//
// WHY THIS EXISTS. Everything between the microphone and a rendered bubble —
// the VAD gate, the resampler, the composer, the publisher, the SSE fan-out,
// the Transcript tab — is only reachable when the deployment HAS a
// transcription provider. `transcriptAccess` in the room is
// `transcriptAccess && sttOn` (spa/src/room/RoomShell.jsx:590), so with no
// provider the tab does not render and none of that pipeline can be exercised
// by a browser at all. Standing up Deepgram or Soniox for a test run means a
// supplier account, a network, a bill, and a non-deterministic answer.
//
// So: a provider that mints a session pointing nowhere. Its browser half
// (`spa/src/stt/fake.js`) never opens the socket — it synthesises the reads a
// provider would have sent. Nothing here talks to anything.
//
// WHY IT CANNOT BE SELECTED BY ACCIDENT. It is deliberately absent from
// `STT_PROVIDERS` in `config/loadConfig.mjs`, so a `config/kelabo.json` naming
// it fails at config load, exactly as a typo does. It is reachable only through
// `KELABO_STT_PROVIDER`, which is the environment path CDK writes and which no
// deployment has a reason to point here — and if one did, the symptom is
// immediate and obvious rather than subtle: captions that are visibly canned.
//
// It still needs a key in the `stt` credential slot, because the core reads one
// before dispatching (`./index.js:55`) and a provider that was exempt from that
// would be exercising a different code path from the real ones. Any non-empty
// string does.

// A real host, because `sttSessionSchema` requires a `wss://` URL and refusing
// an unusable session is a check worth keeping. `.invalid` is reserved by
// RFC 2606 and can never resolve, so if the browser half ever DID try to
// connect, it fails immediately and loudly rather than reaching a stranger.
const FAKE_URL = "wss://stt.invalid/fake";

/** @type {import("./interface.js").SttProvider} */
export const fakeProvider = {
  id: "fake",

  async mint({ key, settings, opts }) {
    if (!key) throw err(502, "stt_unavailable", "fake stt: no key in the credential slot");
    return {
      url: FAKE_URL,
      token: `fake-${opts.kelaboId}`,
      expiresInSeconds: settings.tokenTtlSeconds || 3600,
      // Echoed back so a test can assert that the neutral request reached the
      // provider — which is the one thing about the mint path worth pinning.
      params: {
        language: opts.language || "en",
        diarize: opts.diarize ? "true" : "false",
        encoding: "linear16",
        channels: "1",
      },
    };
  },
};
