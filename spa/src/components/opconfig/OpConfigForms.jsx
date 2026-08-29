import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'

/**
 * The operational-configuration editor, as reusable pieces
 * (contracts/src/opconfig.js, docs 23).
 *
 * Extracted from `routes/Admin.jsx` so a deployment console other than
 * `/admin` — the saas branch's `/superadmin` is the one that exists — can
 * render the same forms instead of forking them. The alternative was two
 * hand-maintained copies of every field, and a field added on master that the
 * other console silently never grew, which is the "published knob with no
 * surface" problem one screen over.
 *
 * The split of responsibilities is deliberate:
 *
 *  - **This file owns what a field IS**: its label, the sentence explaining
 *    it, which draft path it edits, and the published/fallback rendering
 *    rules. One group component per schema group.
 *  - **The route owns everything about WHERE it lives**: which API it loads
 *    from and publishes to, who may see it, tabs, toasts, the note. Nothing
 *    here fetches.
 *
 * Every component takes the same three things, produced by the route from the
 * server's `{published, effective}` answer:
 *
 *  - `draft`      — the whole document being edited (starts as `published`)
 *  - `set(path, value)` — write one field into the draft
 *  - `fallbackFor(path)` — the deployment's own value, shown only when the
 *    field is unpublished, so "I set this" and "the default showing through"
 *    stay distinguishable — the one thing the effective value alone cannot say
 *
 * An empty box means "not published, fall back" — never "set to empty". That
 * rule is enforced server-side in `resolveOpConfig` and restated here in every
 * placeholder. `NumberRow` and `BoolRow` carry the `null`-sentinel rules the
 * fold depends on (docs 23 §2.1): an empty number box sends `null` and a typed
 * `0` sends `0`; a boolean is three-state, because defaulting an untouched
 * switch to `false` would publish "off" the first time anyone saved an
 * unrelated field.
 */

/** A group of rows under a quiet heading — the Settings shape, not a card. */
export function Section({ title, hint, children }) {
  return (
    <section className="settings-section">
      <div className="section-title">{title}</div>
      {hint && <p className="sr-sub">{hint}</p>}
      {children}
    </section>
  )
}

/** A named run of fields inside a section. */
export function Group({ title, hint, children }) {
  return (
    <div className="settings-group">
      <div className="settings-group-head">
        <div className="sr-title">{title}</div>
        {hint && <div className="sr-sub">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

/** One field: what it is on the left, the control on the right. */
export function Row({ title, sub, fallback, children, stacked }) {
  return (
    <div className={'settings-row' + (stacked ? ' settings-row-stacked' : '')}>
      <div className="sr-main">
        <div className="sr-title">{title}</div>
        {sub && <div className="sr-sub">{sub}</div>}
        {/* The deployment's own value, so "published" and "default showing
            through" are distinguishable at a glance. */}
        {fallback !== undefined && fallback !== '' && (
          <div className="settings-fallback">Deployment default: {String(fallback)}</div>
        )}
      </div>
      {children}
    </div>
  )
}

/**
 * A text field. Empty is "not published", which is why the placeholder is the
 * deployment's own value rather than an example.
 */
export function TextRow({ title, sub, value, onChange, fallback, wide }) {
  return (
    <Row title={title} sub={sub} fallback={fallback}>
      <input
        className={'input' + (wide ? '' : ' input-narrow')}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        placeholder="not published"
        spellCheck={false}
      />
    </Row>
  )
}

/**
 * A number field, with an explicit unpublished state.
 *
 * `''` is not published and `0` is the number zero — the distinction the whole
 * fold rests on (`maxConcurrentRuns: 0` means unlimited), so this must never
 * coerce one into the other. An empty box sends `null`; a typed `0` sends `0`.
 */
export function NumberRow({ title, sub, value, onChange, fallback }) {
  return (
    <Row title={title} sub={sub} fallback={fallback}>
      <input
        className="input input-narrow"
        type="number"
        value={value === null || value === undefined ? '' : value}
        onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
        placeholder="not published"
        inputMode="numeric"
      />
    </Row>
  )
}

/**
 * A three-state boolean: not published, on, off.
 *
 * A plain switch cannot express the first, and defaulting it to off would
 * publish `false` over a deployment that wanted `true` the moment anybody
 * pressed Publish for an unrelated field — silently turning video off across
 * the deployment because someone changed the model.
 */
export function BoolRow({ title, sub, value, onChange, fallback }) {
  return (
    <Row title={title} sub={sub} fallback={fallback === undefined ? undefined : fallback ? 'on' : 'off'}>
      <div className="row gap-2">
        {value === null || value === undefined ? (
          <Button variant="ghost" onClick={() => onChange(true)}>
            Publish a value
          </Button>
        ) : (
          <>
            <Switch checked={!!value} onChange={next => onChange(next)} />
            <Button variant="ghost" onClick={() => onChange(null)} title="Return this field to the deployment's value">
              Unpublish
            </Button>
          </>
        )}
      </div>
    </Row>
  )
}

/** The bar that ends a form. */
export function ActionRow({ children }) {
  return <div className="settings-row settings-row-plain action-row">{children}</div>
}

/** Read `a.b.c` off a nested object without throwing on a missing branch. */
export const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

/**
 * The fallback resolver a route hands every group: the effective value, but
 * only when nothing is published for the field — otherwise "effective" is
 * just the draft echoed back and tells the operator nothing.
 */
export const makeFallbackFor = data => path => {
  const published = at(data?.published, path)
  if (published !== '' && published !== null && published !== undefined) return undefined
  return at(data?.effective, path)
}

// --- the groups, one component per schema group ------------------------------

export function ModelGroup({ draft, set, fallbackFor }) {
  return (
    <Group title="Model" hint="Provider, model and endpoint. Changing these re-initialises the running agent worker.">
      <TextRow
        title="Provider"
        sub="anthropic, openai, deepseek, or any OpenAI-compatible id."
        value={draft.llm?.provider}
        fallback={fallbackFor('llm.provider')}
        onChange={v => set('llm.provider', v)}
      />
      <TextRow
        title="Model"
        value={draft.llm?.model}
        fallback={fallbackFor('llm.model')}
        onChange={v => set('llm.model', v)}
      />
      <TextRow
        title="Small model"
        sub="Used for the cheap turns. Leave empty to use the model above."
        value={draft.llm?.smallModel}
        fallback={fallbackFor('llm.smallModel')}
        onChange={v => set('llm.smallModel', v)}
      />
      <TextRow
        title="Base URL"
        sub="The OpenAI-compatible endpoint. Ignored by the anthropic provider."
        wide
        value={draft.llm?.baseUrl}
        fallback={fallbackFor('llm.baseUrl')}
        onChange={v => set('llm.baseUrl', v)}
      />
    </Group>
  )
}

export function BehaviourGroup({ draft, set, fallbackFor }) {
  return (
    <Group
      title="Behaviour"
      hint="How eager the assistant is and how long it may work. These are the knobs worth tuning against a live room."
    >
      <TextRow
        title="Sensitivity"
        sub="How readily the trigger gate decides a turn is for the assistant: low, medium or high."
        value={draft.agent?.sensitivity}
        fallback={fallbackFor('agent.sensitivity')}
        onChange={v => set('agent.sensitivity', v)}
      />
      <NumberRow
        title="Cooldown (seconds)"
        sub="Minimum quiet between two contributions."
        value={draft.agent?.cooldownSeconds}
        fallback={fallbackFor('agent.cooldownSeconds')}
        onChange={v => set('agent.cooldownSeconds', v)}
      />
      <NumberRow
        title="Contributions per minute"
        value={draft.agent?.maxContributionsPerMinute}
        fallback={fallbackFor('agent.maxContributionsPerMinute')}
        onChange={v => set('agent.maxContributionsPerMinute', v)}
      />
      <NumberRow
        title="Research tasks per turn"
        sub="How many sub-agents one trigger may fan out in parallel."
        value={draft.agent?.maxDispatchPerTurn}
        fallback={fallbackFor('agent.maxDispatchPerTurn')}
        onChange={v => set('agent.maxDispatchPerTurn', v)}
      />
      <NumberRow
        title="Research deadline (seconds)"
        sub="Wall-clock budget per turn. 0 disables it — and 0 is a value, not an empty field."
        value={draft.agent?.turnDeadlineSeconds}
        fallback={fallbackFor('agent.turnDeadlineSeconds')}
        onChange={v => set('agent.turnDeadlineSeconds', v)}
      />
      <NumberRow
        title="Concurrent runs"
        sub="0 is unlimited. Set a positive value only to protect a low-quota provider key."
        value={draft.agent?.maxConcurrentRuns}
        fallback={fallbackFor('agent.maxConcurrentRuns')}
        onChange={v => set('agent.maxConcurrentRuns', v)}
      />
      <NumberRow
        title="Rolling window"
        sub="How many recent captions the gate considers."
        value={draft.agent?.rollingWindowSize}
        fallback={fallbackFor('agent.rollingWindowSize')}
        onChange={v => set('agent.rollingWindowSize', v)}
      />
      <NumberRow
        title="Turn timeout (seconds)"
        sub="Message composition, not research."
        value={draft.agent?.turnTimeoutSeconds}
        fallback={fallbackFor('agent.turnTimeoutSeconds')}
        onChange={v => set('agent.turnTimeoutSeconds', v)}
      />
    </Group>
  )
}

/**
 * `showEngine` exists for the saas branch, where the transcription ENGINE is a
 * rate-card field (it prices the call) and must not be publishable from this
 * form — the language and per-provider settings still are.
 */
export function TranscriptionGroup({ draft, set, fallbackFor, showEngine = true }) {
  return (
    <Group title="Transcription" hint="The engine, and the language it expects.">
      {showEngine && (
        <TextRow
          title="Engine"
          sub="deepgram or soniox."
          value={draft.stt?.provider}
          fallback={fallbackFor('stt.provider')}
          onChange={v => set('stt.provider', v)}
        />
      )}
      <TextRow
        title="Language"
        sub='A language code, or "multi" for auto-detection.'
        value={draft.stt?.language}
        fallback={fallbackFor('stt.language')}
        onChange={v => set('stt.language', v)}
      />
    </Group>
  )
}

export function MailGroup({ draft, set, fallbackFor }) {
  return (
    <Group
      title="Outbound mail"
      hint="Sign-in codes and invitations. SES needs no key (IAM role); every other transport reads the mail credential slot."
    >
      <TextRow
        title="Provider"
        sub="ses or mailersend."
        value={draft.mail?.provider}
        fallback={fallbackFor('mail.provider')}
        onChange={v => set('mail.provider', v)}
      />
      <TextRow
        title="From address"
        sub="Must be an address the provider has verified. Changing the domain needs a redeploy — the IAM grant is fenced to it."
        wide
        value={draft.mail?.fromAddress}
        fallback={fallbackFor('mail.fromAddress')}
        onChange={v => set('mail.fromAddress', v)}
      />
    </Group>
  )
}

export function ConferenceGroup({ draft, set, fallbackFor }) {
  return (
    <Group
      title="Conference audio"
      hint="Defaults for newly created kelabos. A kelabo's transport never changes after it is created, so publishing these does not touch a call in progress."
    >
      <TextRow
        title="Default mode"
        sub="sfu or mesh."
        value={draft.rtc?.defaultMode}
        fallback={fallbackFor('rtc.defaultMode')}
        onChange={v => set('rtc.defaultMode', v)}
      />
      <NumberRow
        title="Mesh maximum participants"
        sub="Mesh is N−1 uplinks per person. A full mesh room refuses joiners rather than falling back to the SFU."
        value={draft.rtc?.meshMaxParticipants}
        fallback={fallbackFor('rtc.meshMaxParticipants')}
        onChange={v => set('rtc.meshMaxParticipants', v)}
      />
      <NumberRow
        title="ICE credential TTL (seconds)"
        value={draft.rtc?.iceTtlSeconds}
        fallback={fallbackFor('rtc.iceTtlSeconds')}
        onChange={v => set('rtc.iceTtlSeconds', v)}
      />
      <NumberRow
        title="Disconnect grace (seconds)"
        value={draft.rtc?.disconnectGraceSeconds}
        fallback={fallbackFor('rtc.disconnectGraceSeconds')}
        onChange={v => set('rtc.disconnectGraceSeconds', v)}
      />
      <BoolRow
        title="Video"
        value={draft.rtc?.video}
        fallback={fallbackFor('rtc.video')}
        onChange={v => set('rtc.video', v)}
      />
    </Group>
  )
}

export function OtpLimitsGroup({ draft, set, fallbackFor }) {
  return (
    <Group title="Sign-in codes" hint="The email OTP, and the limits that bound guessing it.">
      <NumberRow
        title="Code lifetime (seconds)"
        value={draft.otp?.ttlSeconds}
        fallback={fallbackFor('otp.ttlSeconds')}
        onChange={v => set('otp.ttlSeconds', v)}
      />
      <NumberRow
        title="Attempts per code"
        value={draft.otp?.maxAttempts}
        fallback={fallbackFor('otp.maxAttempts')}
        onChange={v => set('otp.maxAttempts', v)}
      />
      <NumberRow
        title="Resend after (seconds)"
        value={draft.otp?.resendSeconds}
        fallback={fallbackFor('otp.resendSeconds')}
        onChange={v => set('otp.resendSeconds', v)}
      />
      <NumberRow
        title="Requests per email, per window"
        value={draft.otp?.perEmailMaxRequests}
        fallback={fallbackFor('otp.perEmailMaxRequests')}
        onChange={v => set('otp.perEmailMaxRequests', v)}
      />
      <NumberRow
        title="Per-email window (seconds)"
        sub="The window the per-email limit counts over."
        value={draft.otp?.perEmailWindowSeconds}
        fallback={fallbackFor('otp.perEmailWindowSeconds')}
        onChange={v => set('otp.perEmailWindowSeconds', v)}
      />
      <NumberRow
        title="Requests per IP, per window"
        value={draft.otp?.perIpMaxRequests}
        fallback={fallbackFor('otp.perIpMaxRequests')}
        onChange={v => set('otp.perIpMaxRequests', v)}
      />
      <NumberRow
        title="Per-IP window (seconds)"
        sub="The window the per-IP limit counts over."
        value={draft.otp?.perIpWindowSeconds}
        fallback={fallbackFor('otp.perIpWindowSeconds')}
        onChange={v => set('otp.perIpWindowSeconds', v)}
      />
    </Group>
  )
}

export function JoinCodeLimitsGroup({ draft, set, fallbackFor }) {
  return (
    <Group
      title="Join codes"
      hint="The two-minute spoken stand-in for a kelabo URL. The per-IP redeem limit is what actually bounds guessing."
    >
      <NumberRow
        title="Code lifetime (seconds)"
        value={draft.joinCode?.ttlSeconds}
        fallback={fallbackFor('joinCode.ttlSeconds')}
        onChange={v => set('joinCode.ttlSeconds', v)}
      />
      <NumberRow
        title="Codes per kelabo, per hour"
        value={draft.joinCode?.mintPerKelaboPerHour}
        fallback={fallbackFor('joinCode.mintPerKelaboPerHour')}
        onChange={v => set('joinCode.mintPerKelaboPerHour', v)}
      />
      <NumberRow
        title="Redemptions per IP, per window"
        value={draft.joinCode?.redeemPerIpMaxRequests}
        fallback={fallbackFor('joinCode.redeemPerIpMaxRequests')}
        onChange={v => set('joinCode.redeemPerIpMaxRequests', v)}
      />
      <NumberRow
        title="Redemption window (seconds)"
        sub="The window the per-IP redeem limit counts over — tighten both under active fishing."
        value={draft.joinCode?.redeemPerIpWindowSeconds}
        fallback={fallbackFor('joinCode.redeemPerIpWindowSeconds')}
        onChange={v => set('joinCode.redeemPerIpWindowSeconds', v)}
      />
    </Group>
  )
}

export function SessionsGroup({ draft, set, fallbackFor }) {
  return (
    <Group
      title="Sessions"
      hint="Applies to tokens minted from now on. Shortening a lifetime does not revoke a session already issued."
    >
      <NumberRow
        title="Session (seconds)"
        value={draft.auth?.sessionTtlSeconds}
        fallback={fallbackFor('auth.sessionTtlSeconds')}
        onChange={v => set('auth.sessionTtlSeconds', v)}
      />
      <NumberRow
        title="Refresh (days)"
        value={draft.auth?.refreshTtlDays}
        fallback={fallbackFor('auth.refreshTtlDays')}
        onChange={v => set('auth.refreshTtlDays', v)}
      />
      <NumberRow
        title="Guest participant (seconds)"
        value={draft.auth?.participantTtlSeconds}
        fallback={fallbackFor('auth.participantTtlSeconds')}
        onChange={v => set('auth.participantTtlSeconds', v)}
      />
      <NumberRow
        title="Agent token (days)"
        value={draft.auth?.agentTokenTtlDays}
        fallback={fallbackFor('auth.agentTokenTtlDays')}
        onChange={v => set('auth.agentTokenTtlDays', v)}
      />
    </Group>
  )
}

export function RetentionGroup({ draft, set, fallbackFor }) {
  return (
    <Group title="Retention" hint="Stamped on material as it is written, so a change reaches new material only.">
      <NumberRow
        title="Keep kelabo material for (days)"
        sub="Lengthening this does not bring back what has already expired."
        value={draft.retentionDays}
        fallback={fallbackFor('retentionDays')}
        onChange={v => set('retentionDays', v)}
      />
      <BoolRow
        title="Contacts outside this tenant"
        sub="Whether a kelabo may link someone whose email domain is not this deployment's."
        value={draft.contacts?.external}
        fallback={fallbackFor('contacts.external')}
        onChange={v => set('contacts.external', v)}
      />
    </Group>
  )
}

export function SignInDomainGroup({ draft, set, fallbackFor }) {
  return (
    <Group
      title="Sign-in domain"
      hint="The tenancy boundary: the single check that decides whether an address may hold an account here."
    >
      <TextRow
        title="Allowed email domain"
        sub="Clearing this falls back to the deployment's configured domain — it does not open the deployment to everyone."
        wide
        value={draft.org?.allowedEmailDomain}
        fallback={fallbackFor('org.allowedEmailDomain')}
        onChange={v => set('org.allowedEmailDomain', v)}
      />
    </Group>
  )
}
