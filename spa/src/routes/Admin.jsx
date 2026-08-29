import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { SkeletonRows } from '../components/ui/Skeleton'
import { Switch } from '../components/ui/Switch'
import { Tabs } from '../components/ui/Tabs'
import { useToast } from '../components/Toaster'
import { useConfirm } from '../components/ConfirmDialog'

/**
 * `/admin` — the deployment's operational console (contracts/src/opconfig.js).
 *
 * Everything on this page used to be a key in `config/kelabo.json`, frozen into
 * a task definition by CDK. Changing which model the assistant runs, or how
 * eager it is, meant a docker build and a service rollout — and `make restart`
 * did not even pick it up, because it redeploys the same task-definition
 * revision. This is the page that replaced that.
 *
 * ## Three columns, not one
 *
 * Every field shows what is **published**, and under it what this deployment
 * **falls back to** when nothing is. Showing only the value in effect would
 * make the page unusable for the thing it exists for: an operator who sees
 * `sfu` cannot tell whether they published it or whether it is the deployment's
 * default showing through, so clearing a field they believed they had set would
 * change nothing while looking as though it should.
 *
 * An empty box therefore means "not published, use the deployment's value" —
 * never "set this to empty". That rule is enforced in `resolveOpConfig` and
 * restated here in the placeholder of every field.
 *
 * ## Publishing is an append
 *
 * There is one form and one Publish, because the config is versioned and
 * published atomically — splitting it into a form per group would mint a
 * version per field and lose the single note that explains the change. The note
 * is required for that reason: a version chain of blank notes is an audit
 * record that answers nothing.
 *
 * Nothing here edits. Rolling a setting back is publishing the old value again,
 * so the fact that it was rolled back is itself recorded.
 *
 * ## Why this looks like Settings
 *
 * Because it is the same kind of page and should not invent a second form
 * vocabulary: `settings-section` for a group, `settings-group` for a named run
 * of fields, `settings-row` with `sr-title`/`sr-sub` for a field and the reason
 * it matters. The hint an operator most needs is on screen rather than a hover
 * away.
 *
 * The route is guarded server-side on every call. This component hides itself
 * from a non-admin as a courtesy, not as the control.
 */

const TABS = [
  { id: 'assistant', label: 'Assistant' },
  { id: 'services', label: 'Services' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'limits', label: 'Limits' },
  { id: 'access', label: 'Access' },
  { id: 'history', label: 'History' },
]

/** A group of rows under a quiet heading — the Settings shape, not a card. */
function Section({ title, hint, children }) {
  return (
    <section className="settings-section">
      <div className="section-title">{title}</div>
      {hint && <p className="sr-sub">{hint}</p>}
      {children}
    </section>
  )
}

/** A named run of fields inside a section. */
function Group({ title, hint, children }) {
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
function Row({ title, sub, fallback, children, stacked }) {
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
function TextRow({ title, sub, value, onChange, fallback, wide }) {
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
function NumberRow({ title, sub, value, onChange, fallback }) {
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
function BoolRow({ title, sub, value, onChange, fallback }) {
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

/** Read `a.b.c` off a nested object without throwing on a missing branch. */
const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

/**
 * One supplier's keys.
 *
 * Its own component with its own state because a slot is saved on its own — a
 * shared draft across every slot would make one Save write four, and rotating
 * the LLM key is not a reason to rewrite the Cloudflare one.
 *
 * **Every box starts empty and stays a password field.** There is no route that
 * returns a credential, so there is nothing to prefill with; showing a masked
 * placeholder over a value that was never fetched would only imply otherwise.
 * Empty means "leave this one alone" — the server merges — which is what lets
 * an operator rotate one field of a slot without re-pasting the rest.
 */
function SupplierSlot({ slot, onSaved }) {
  const toast = useToast()
  const [draft, setDraft] = useState({})
  const [busy, setBusy] = useState(false)
  const typed = Object.values(draft).filter(v => v && v.trim()).length

  async function save() {
    setBusy(true)
    try {
      await api.adminSaveCredential(slot.slot, draft)
      setDraft({})
      toast(`${slot.slot} updated. In effect within five minutes.`)
      onSaved?.()
    } catch (e) {
      toast(
        e.code === 'missing_field'
          ? `${slot.slot} still needs: ${e.message}`
          : e.code === 'unknown_field'
            ? `Not a field of ${slot.slot}: ${e.message}`
            : `Could not save ${slot.slot} (${e.code || 'error'}).`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Group
      title={slot.slot}
      hint={
        slot.configured
          ? `Set${slot.rotatedAt ? ` ${new Date(slot.rotatedAt).toLocaleDateString()}` : ''}${
              slot.rotatedBy ? ` by ${slot.rotatedBy}` : ''
            } · version ${slot.version}`
          : 'Not set — this capability is off until a key is supplied.'
      }
    >
      {slot.spec.map(f => (
        <Row
          key={f.key}
          title={f.label}
          sub={f.hint}
          // Which fields of this slot are already filled. Derived server-side
          // from the stored value; the value itself never leaves the Lambda.
          fallback={slot.fields?.[f.key] ? 'set' : f.required ? 'not set — required' : 'not set'}
        >
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={draft[f.key] ?? ''}
            onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
            placeholder={slot.fields?.[f.key] ? 'leave empty to keep' : 'paste key'}
            spellCheck={false}
          />
        </Row>
      ))}
      <ActionRow>
        <Button onClick={save} disabled={busy || typed === 0}>
          {busy ? 'Saving…' : `Save ${slot.slot}`}
        </Button>
      </ActionRow>
    </Group>
  )
}

/** The bar that ends a form. */
function ActionRow({ children }) {
  return <div className="settings-row settings-row-plain action-row">{children}</div>
}

export default function Admin() {
  const toast = useToast()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const tab = TABS.some(t => t.id === params.get('tab')) ? params.get('tab') : 'assistant'

  const [who, setWho] = useState(null)
  const [data, setData] = useState(null)
  const [roster, setRoster] = useState(null)
  const [draft, setDraft] = useState(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [grantEmail, setGrantEmail] = useState('')
  const [creds, setCreds] = useState(null)
  const [credsError, setCredsError] = useState('')

  useEffect(() => {
    api.adminWhoami().then(setWho).catch(() => setWho({ admin: false }))
  }, [])

  async function load() {
    try {
      const cfg = await api.adminConfig()
      setData(cfg)
      // The draft starts as the published document, not as the effective one:
      // editing the effective values would publish every deployment default as
      // an explicit setting the first time anyone saved.
      setDraft(structuredClone(cfg.published))
      setError('')
    } catch (e) {
      setError(e.code || 'load_failed')
    }
  }

  useEffect(() => {
    if (who?.admin) load()
  }, [who?.admin])

  useEffect(() => {
    if (who?.root) api.adminRoster().then(setRoster).catch(() => setRoster(null))
  }, [who?.root])

  /**
   * Three states, not two.
   *
   * This started as `.then(setCreds).catch(() => setCreds(null))`, which left
   * `creds` null on failure — indistinguishable from "still loading", so a 500
   * rendered as a skeleton that span forever and the actual error was only
   * visible in CloudWatch. A request that failed must say so; "still working"
   * is the one thing it is not.
   */
  const loadCreds = () => {
    setCredsError('')
    setCreds(null)
    return api
      .adminCredentials()
      .then(setCreds)
      .catch(e => setCredsError(e.code || e.message || 'request_failed'))
  }
  useEffect(() => {
    if (who?.admin) loadCreds()
  }, [who?.admin])

  if (!who) return <SkeletonRows rows={4} />
  if (!who.admin) {
    return (
      <div className="page">
        <Banner kind="warn">
          {who.rootConfigured
            ? 'You are not an administrator of this deployment.'
            : 'No administrator is configured. Set rootAdminEmail in config/kelabo.json and redeploy.'}
        </Banner>
      </div>
    )
  }
  if (error) return <Banner kind="danger">Could not load configuration ({error}).</Banner>
  if (!draft) return <SkeletonRows rows={6} />

  const set = (path, value) => {
    setDraft(prev => {
      const next = structuredClone(prev)
      const keys = path.split('.')
      const last = keys.pop()
      let node = next
      for (const k of keys) {
        node[k] = node[k] ?? {}
        node = node[k]
      }
      node[last] = value
      return next
    })
  }

  // What the deployment falls back to for a field: the effective value, but
  // only when nothing is published for it — otherwise "effective" is just the
  // draft echoed back and tells the operator nothing.
  const fallbackFor = path => {
    const published = at(data.published, path)
    if (published !== '' && published !== null && published !== undefined) return undefined
    return at(data.effective, path)
  }

  async function publish() {
    if (!note.trim()) {
      toast('A note is required — it is the record of why this changed.')
      return
    }
    setBusy(true)
    try {
      const res = await api.adminPublishConfig(draft, note.trim())
      // Honest about the gateway: the publish is durable either way, but the
      // running task may not have it yet, and saying "live" when it is not is
      // how an operator ends up debugging the wrong thing.
      toast(
        res.gatewayReloaded
          ? `Published version ${res.version}. Live now.`
          : `Published version ${res.version}. The gateway will pick it up within a minute.`,
      )
      setNote('')
      await load()
    } catch (e) {
      toast(
        e.code === 'version_conflict'
          ? 'Someone else published while you were editing. Reloaded — review and publish again.'
          : `Publish failed (${e.code || 'error'}).`,
      )
      if (e.code === 'version_conflict') await load()
    } finally {
      setBusy(false)
    }
  }

  async function grant() {
    const email = grantEmail.trim().toLowerCase()
    if (!email) return
    try {
      await api.adminGrant(email)
      setGrantEmail('')
      setRoster(await api.adminRoster())
      toast(`${email} can now publish configuration.`)
    } catch (e) {
      toast(`Could not grant (${e.code || 'error'}).`)
    }
  }

  async function revoke(email) {
    const ok = await confirm({
      title: `Revoke ${email}?`,
      body: 'They will no longer be able to publish configuration for this deployment.',
      confirmLabel: 'Revoke',
      danger: true,
    })
    if (!ok) return
    try {
      await api.adminRevoke(email)
      setRoster(await api.adminRoster())
    } catch (e) {
      toast(`Could not revoke (${e.code || 'error'}).`)
    }
  }

  const status = data.status || {}

  return (
    <div className="page">
      <div className="section-title">Deployment configuration</div>
      <p className="sr-sub">
        Published settings win over this deployment&rsquo;s own configuration. An empty field is not published and
        falls back &mdash; it never means &ldquo;set to empty&rdquo;.
      </p>

      {status.source === 'stale' && (
        <Banner kind="warn">
          The configuration table could not be read. The deployment is running on the last version it read
          successfully (v{status.version}), which may not be what is shown here.
        </Banner>
      )}

      <Tabs tabs={TABS} active={tab} onChange={id => setParams({ tab: id }, { replace: true })} />

      {tab === 'assistant' && (
        <Section
          title="Assistant"
          hint="Which model answers, and how it behaves in a room. The API key is not here — it is the llm credential slot."
        >
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
        </Section>
      )}

      {tab === 'services' && (
        <Section
          title="Services"
          hint="Which supplier each capability talks to. Every key is a credential slot, never a field on this page."
        >
          <Group title="Transcription" hint="The engine, and the language it expects.">
            <TextRow
              title="Engine"
              sub="deepgram or soniox."
              value={draft.stt?.provider}
              fallback={fallbackFor('stt.provider')}
              onChange={v => set('stt.provider', v)}
            />
            <TextRow
              title="Language"
              sub='A language code, or "multi" for auto-detection.'
              value={draft.stt?.language}
              fallback={fallbackFor('stt.language')}
              onChange={v => set('stt.language', v)}
            />
          </Group>

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
        </Section>
      )}

      {tab === 'suppliers' && (
        <Section
          title="Supplier keys"
          hint="How this deployment authenticates to each supplier. Stored in their own table under their own encryption key — separate from everything else on this page, and not versioned: a key is not a decision anyone needs the history of."
        >
          <Banner kind="warn">
            Keys can be written here and never read back — there is no route that returns one. Rotating at the
            supplier is the recovery if one leaks. Fields left empty are unchanged.
          </Banner>
          {credsError && (
            <Banner kind="danger">
              Could not load supplier status ({credsError}).{' '}
              <a href="#" onClick={e => { e.preventDefault(); loadCreds() }}>Try again</a>
            </Banner>
          )}
          {!creds && !credsError && <SkeletonRows rows={4} />}
          {creds?.slots.map(s => (
            <SupplierSlot key={s.slot} slot={s} onSaved={loadCreds} />
          ))}
          <p className="sr-sub">
            The equivalent from a shell, which is also the only way to fill a slot before anyone can sign in:{' '}
            <code>KELABO_CRED_LLM_API_KEY=… make credential-set env=&lt;env&gt; slot=llm write=1</code>
          </p>
        </Section>
      )}

      {tab === 'limits' && (
        <Section title="Limits" hint="Rate limits, lifetimes and retention.">
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
        </Section>
      )}

      {tab === 'access' && (
        <Section title="Access" hint="Who may sign in to this deployment, and who may change it.">
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

          <Group
            title="Administrators"
            hint={
              who.root
                ? 'Root is set in config/kelabo.json and cannot be changed from here — that is what stops an administrator from locking the operator out.'
                : 'Only the root administrator can change this list.'
            }
          >
            {!who.root && (
              <div className="settings-row settings-row-plain">
                <div className="sr-sub">You can publish configuration, but not change who else can.</div>
              </div>
            )}
            {who.root && roster && (
              <>
                <Row title="Root" sub="From config/kelabo.json. Revocable only by a deploy.">
                  <code>{roster.root || 'not configured'}</code>
                </Row>
                {roster.admins.map(a => (
                  <Row key={a.email} title={a.email} sub={a.grantedBy ? `Granted by ${a.grantedBy}` : undefined}>
                    <Button variant="ghost" onClick={() => revoke(a.email)}>
                      <Icon name="x" size={14} /> Revoke
                    </Button>
                  </Row>
                ))}
                <div className="settings-row settings-row-plain action-row">
                  <input
                    className="input"
                    value={grantEmail}
                    onChange={e => setGrantEmail(e.target.value)}
                    placeholder="name@example.com"
                    spellCheck={false}
                  />
                  <Button onClick={grant} disabled={!grantEmail.trim()}>
                    Grant
                  </Button>
                </div>
              </>
            )}
          </Group>
        </Section>
      )}

      {tab === 'history' && (
        <Section
          title="History"
          hint="Every published version, newest first. Nothing is ever edited or removed — rolling back is publishing the old value again."
        >
          <Group title={`Versions (in effect: v${status.version ?? '?'})`}>
            {data.versions.map(v => (
              <Row
                key={v.version}
                title={`v${v.version} — ${v.note || 'no note'}`}
                sub={`${v.publishedBy || 'seeded'} · ${
                  v.effectiveFrom ? new Date(v.effectiveFrom).toLocaleString() : 'from the start'
                }`}
              />
            ))}
          </Group>
        </Section>
      )}

      {/* One publish for the whole document: the config is versioned
          atomically, and a note per field would be a version per field.
          Excluded from Suppliers, which is not config at all — each slot saves
          itself, immediately, with no version and no note. Showing a "Publish"
          bar under a key form would invite someone to paste a key and then look
          for the button that commits it. */}
      {tab !== 'history' && tab !== 'suppliers' && (
        <div className="settings-row settings-row-plain action-row">
          <input
            className="input"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="What changed, and why (required)"
          />
          <Button onClick={publish} disabled={busy || !note.trim()}>
            {busy ? 'Publishing…' : 'Publish'}
          </Button>
        </div>
      )}
    </div>
  )
}
