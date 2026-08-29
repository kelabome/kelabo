import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { SkeletonRows } from '../components/ui/Skeleton'
import { Tabs } from '../components/ui/Tabs'
import { useToast } from '../components/Toaster'
import { useConfirm } from '../components/ConfirmDialog'
import {
  ActionRow,
  BehaviourGroup,
  ConferenceGroup,
  Group,
  JoinCodeLimitsGroup,
  MailGroup,
  makeFallbackFor,
  ModelGroup,
  OtpLimitsGroup,
  RetentionGroup,
  Row,
  Section,
  SessionsGroup,
  SignInDomainGroup,
  TranscriptionGroup,
} from '../components/opconfig/OpConfigForms'

/**
 * `/admin` — the deployment's operational console (contracts/src/opconfig.js).
 *
 * Everything on this page used to be a key in `config/kelabo.json`, frozen into
 * a task definition by CDK. Changing which model the assistant runs, or how
 * eager it is, meant a docker build and a service rollout — and `make restart`
 * did not even pick it up, because it redeploys the same task-definition
 * revision. This is the page that replaced that.
 *
 * The field definitions themselves live in
 * `components/opconfig/OpConfigForms.jsx` — one group component per schema
 * group — so a console other than this one (the saas branch's `/superadmin`)
 * renders the same forms instead of forking them. This route owns everything
 * about WHERE they live: the `/admin` API, who may see them, tabs, the note,
 * the publish.
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
 * restated in the placeholder of every field.
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

  const fallbackFor = makeFallbackFor(data)
  const groupProps = { draft, set, fallbackFor }

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
          <ModelGroup {...groupProps} />
          <BehaviourGroup {...groupProps} />
        </Section>
      )}

      {tab === 'services' && (
        <Section
          title="Services"
          hint="Which supplier each capability talks to. Every key is a credential slot, never a field on this page."
        >
          <TranscriptionGroup {...groupProps} />
          <MailGroup {...groupProps} />
          <ConferenceGroup {...groupProps} />
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
          <OtpLimitsGroup {...groupProps} />
          <JoinCodeLimitsGroup {...groupProps} />
          <SessionsGroup {...groupProps} />
          <RetentionGroup {...groupProps} />
        </Section>
      )}

      {tab === 'access' && (
        <Section title="Access" hint="Who may sign in to this deployment, and who may change it.">
          <SignInDomainGroup {...groupProps} />

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
