import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth, displayName } from '../auth'
import { Avatar, myAvatarVariant } from '../components/ui/Avatar'
import { Select } from '../components/ui/Select'
import { Switch } from '../components/ui/Switch'
import { joinPrefs, setJoinPref } from '../joinPrefs'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Tabs } from '../components/ui/Tabs'
import { useToast } from '../components/Toaster'
import { useConfirm } from '../components/ConfirmDialog'
import { SCHEMES, currentScheme, currentTheme, setScheme, setTheme } from '../theme'
import { pushSettings, SETTINGS_SYNCED_EVENT } from '../settings'
import { playEventSound } from '../sounds'

// One long scroll of seven cards became four named groups. `general` is first
// so a bare /settings lands somewhere sensible; the tab is mirrored into the
// query string so a section is linkable and survives the OAuth round-trip.
const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'capture', label: 'Capture' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'data', label: 'Data & account' },
]

export default function Settings() {
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { identity, tenantId, refresh } = useAuth()

  const [name, setName] = useState(
    localStorage.getItem('kelabo-name') || displayName(identity) || ''
  )
  const [notif, setNotif] = useState(localStorage.getItem('kelabo-notif') === '1')
  // Room chimes are on unless explicitly off — the inverse of the OS
  // notification toggle, which asks before it intrudes.
  const [sounds, setSounds] = useState(localStorage.getItem('kelabo-sounds') !== '0')
  const [finalOnly, setFinalOnly] = useState(localStorage.getItem('kelabo-final-only') === '1')
  const [muteHidden, setMuteHidden] = useState(localStorage.getItem('kelabo-mute-hidden') === '1')
  const [joinMuted, setJoinMuted] = useState(() => joinPrefs().muted)
  const [joinCamera, setJoinCamera] = useState(() => joinPrefs().camera)
  const [lang, setLang] = useState(localStorage.getItem('kelabo-stt-lang') || 'en')
  const [theme, setThemeState] = useState(currentTheme())
  const [scheme, setSchemeState] = useState(currentScheme())

  const [mcpServers, setMcpServers] = useState(null)
  // { editing, name, url, secret, saving, probe, probing }
  const [mcpForm, setMcpForm] = useState(null)
  const [mcpBusy, setMcpBusy] = useState('')
  // Coding agents paired to this account (docs 16 §6). `null` means not loaded
  // yet, which is a different thing from "none connected" and reads differently.
  const [agents, setAgents] = useState(null)
  const [agentBusy, setAgentBusy] = useState('')
  const [purgeValue, setPurgeValue] = useState(6)
  const [purgeUnit, setPurgeUnit] = useState('months')
  const [purgePreview, setPurgePreview] = useState(null)
  const [purging, setPurging] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()

  const requested = searchParams.get('tab')
  const tab = SETTINGS_TABS.some(t => t.id === requested) ? requested : 'general'
  // `general` is the default, so it stays out of the URL rather than being
  // spelled out in every link to the settings page.
  const setTab = id => setSearchParams(id === 'general' ? {} : { tab: id }, { replace: true })

  const loadMcp = async () => {
    try {
      const data = await api.getMcp()
      setMcpServers(data?.servers || [])
    } catch {
      setMcpServers([])
    }
  }

  const loadAgents = async () => {
    try {
      const data = await api.listAgents()
      setAgents(data?.agents || [])
    } catch {
      setAgents([])
    }
  }

  useEffect(() => { loadMcp(); loadAgents() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const revokeAgent = async a => {
    const ok = await confirm({
      title: `Revoke ${a.label || a.runtime}?`,
      // Revocation is checked when the bridge connects, so an agent that is in a
      // kelabo right now keeps that connection until it drops. Saying so is
      // better than a promise of immediacy we do not keep.
      body: 'It will not be able to join kelabos again without being paired afresh. An agent already in a kelabo stays until it disconnects.',
      confirmLabel: 'Revoke',
      danger: true,
    })
    if (!ok) return
    setAgentBusy(a.jti)
    try {
      await api.revokeAgent(a.jti)
      toast('Agent revoked')
      await loadAgents()
    } catch {
      toast('Could not revoke the agent')
    } finally {
      setAgentBusy('')
    }
  }

  // The OAuth callback redirects here with the outcome in the query string.
  useEffect(() => {
    const connected = searchParams.get('mcp_connected')
    const error = searchParams.get('mcp_error')
    if (!connected && !error) return
    toast(connected ? `${connected} connected` : `Connection failed: ${error}`)
    // Drop the callback params but land on the section the user came from,
    // otherwise the round-trip dumps them back on General.
    setSearchParams({ tab: 'integrations' }, { replace: true })
    loadMcp()
  }, [searchParams]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ask the server (unauthenticated) whether it speaks OAuth, so we can offer
  // "Connect" instead of asking the user to find and paste a token.
  const probeMcpUrl = async url => {
    const trimmed = (url || '').trim()
    if (!/^https?:\/\//i.test(trimmed)) return
    setMcpForm(f => (f ? { ...f, probing: true } : f))
    try {
      const probe = await api.probeMcp(trimmed)
      setMcpForm(f => (f && f.url.trim() === trimmed ? { ...f, probe, probing: false } : f))
    } catch {
      setMcpForm(f => (f ? { ...f, probe: null, probing: false } : f))
    }
  }

  const connectMcp = name => {
    // Full-page navigation: the authorization server will not render in a fetch.
    window.location.href = api.mcpOauthStartUrl(name)
  }

  const disconnectMcp = async s => {
    const ok = await confirm({
      title: `Disconnect ${s.name}?`,
      body: 'Kelabo will forget the access it was granted. The server stays configured and you can reconnect later.',
      confirmLabel: 'Disconnect',
    })
    if (!ok) return
    setMcpBusy(s.name)
    try {
      await api.disconnectMcpOauth(s.name)
      toast(`${s.name} disconnected`)
      await loadMcp()
    } catch (e) {
      toast(e?.message || 'Could not disconnect')
    } finally {
      setMcpBusy('')
    }
  }

  const saveMcp = async () => {
    if (!mcpForm || mcpForm.saving) return
    const name = mcpForm.name.trim()
    const url = mcpForm.url.trim()
    if (!name || !url) { toast('Name and URL are required'); return }
    setMcpForm(f => ({ ...f, saving: true }))
    const wantsOauth = mcpForm.probe?.authType === 'oauth' && mcpForm.probe?.dynamicRegistration
    try {
      await api.putMcp({
        name,
        url,
        ...(mcpForm.secret.trim() ? { secret: mcpForm.secret.trim() } : {}),
        ...(wantsOauth ? { authType: 'oauth' } : {}),
      })
      setMcpForm(null)
      if (wantsOauth) {
        // Hand straight off to the provider's login instead of making the user
        // hunt for a second button.
        connectMcp(name)
        return
      }
      toast(mcpForm.editing ? 'MCP server updated' : 'MCP server added')
      await loadMcp()
    } catch (e) {
      setMcpForm(f => ({ ...f, saving: false }))
      toast(e?.message || 'Could not save MCP server')
    }
  }

  const toggleMcp = async (s, enabled) => {
    try {
      await api.putMcp({ name: s.name, url: s.url, enabled })
      setMcpServers(list => list.map(x => x.name === s.name ? { ...x, enabled } : x))
    } catch {
      toast('Could not update MCP server')
    }
  }

  const removeMcp = async s => {
    const ok = await confirm({
      title: `Remove ${s.name}?`,
      body: 'The server and its stored token will be deleted. Kelabos will no longer use it.',
      confirmLabel: 'Remove',
    })
    if (!ok) return
    try {
      await api.deleteMcp(s.name)
      setMcpServers(list => list.filter(x => x.name !== s.name))
      toast('MCP server removed')
    } catch {
      toast('Could not remove MCP server')
    }
  }

  const saveName = v => {
    setName(v)
    localStorage.setItem('kelabo-name', v)
    pushSettings()
  }

  // Identicon re-roll. Each try is a fresh random salt (not +1, so two people
  // unhappy with colliding avatars do not march through the same sequence);
  // keeping one is nothing more than stopping. Synced like any other setting,
  // and the server hands it to everyone who renders this person.
  const [avatarVariant, setAvatarVariant] = useState(() => myAvatarVariant())
  const rollAvatar = () => {
    let v = avatarVariant
    while (v === avatarVariant) v = 1 + Math.floor(Math.random() * 9998)
    setAvatarVariant(v)
    localStorage.setItem('kelabo-avatar', String(v))
    pushSettings()
  }
  const resetAvatar = () => {
    setAvatarVariant(0)
    localStorage.setItem('kelabo-avatar', '0')
    pushSettings()
  }

  const onNotifChange = on => {
    setNotif(on)
    if (on && 'Notification' in window) Notification.requestPermission()
    toast(on ? 'Board notifications on' : 'Board notifications off')
    localStorage.setItem('kelabo-notif', on ? '1' : '0')
    pushSettings()
  }

  const onSoundsChange = on => {
    setSounds(on)
    toast(on ? 'Room sounds on' : 'Room sounds off')
    localStorage.setItem('kelabo-sounds', on ? '1' : '0')
    pushSettings()
    // Turning them on is a gesture, so the preview doubles as the AudioContext
    // unlock — the first real chime later is not swallowed by autoplay policy.
    if (on) playEventSound('join')
  }

  // These two are the defaults; the device check on the way into a kelabo
  // writes the same keys, so changing it there changes it here and vice versa.
  const onJoinMutedChange = on => {
    setJoinMuted(on)
    setJoinPref('muted', on)
  }

  const onJoinCameraChange = on => {
    setJoinCamera(on)
    setJoinPref('camera', on)
  }

  const onFinalOnlyChange = on => {
    setFinalOnly(on)
    localStorage.setItem('kelabo-final-only', on ? '1' : '0')
    pushSettings()
  }

  const onMuteHiddenChange = on => {
    setMuteHidden(on)
    localStorage.setItem('kelabo-mute-hidden', on ? '1' : '0')
    pushSettings()
  }

  const onLangChange = v => {
    setLang(v)
    localStorage.setItem('kelabo-stt-lang', v)
    pushSettings()
  }

  // Purge is irreversible, so it is always a two-step flow: preview (dry run)
  // then confirm. `preview` holds the server's own report of what would go.
  const runPurgePreview = async () => {
    setPurging(true)
    setPurgePreview(null)
    try {
      setPurgePreview(await api.purgeRecords(purgeValue, purgeUnit, true))
    } catch (e) {
      toast(e?.message || 'Could not check records')
    } finally {
      setPurging(false)
    }
  }

  const runPurge = async () => {
    const p = purgePreview
    const total = (p?.purged?.length || 0) + (p?.removedFromList?.length || 0)
    const ok = await confirm({
      title: `Delete ${total} record${total === 1 ? '' : 's'}?`,
      body: `This permanently deletes the transcript, board and minutes of ${p.purged.length} kelabo${p.purged.length === 1 ? '' : 's'} you hosted. It cannot be undone.`,
      confirmLabel: 'Delete permanently',
    })
    if (!ok) return
    setPurging(true)
    try {
      const res = await api.purgeRecords(purgeValue, purgeUnit, false)
      const done = res.purged.length + res.removedFromList.length
      toast(
        res.failed.length
          ? `Deleted ${done}, ${res.failed.length} failed`
          : res.remaining
            ? `Deleted ${done} — ${res.remaining} still to go, run again`
            : `Deleted ${done} record${done === 1 ? '' : 's'}`
      )
      // Re-preview so the panel reflects reality (and shows any remainder).
      setPurgePreview(res.remaining ? await api.purgeRecords(purgeValue, purgeUnit, true) : null)
    } catch (e) {
      toast(e?.message || 'Purge failed')
    } finally {
      setPurging(false)
    }
  }

  const pickTheme = t => {
    setTheme(t)
    setThemeState(t)
    pushSettings()
  }

  const pickScheme = s => {
    setSchemeState(setScheme(s))
    pushSettings()
  }

  // Another device (or this one, post-login) may apply a newer snapshot.
  useEffect(() => {
    const resync = () => {
      setName(localStorage.getItem('kelabo-name') || displayName(identity) || '')
      setNotif(localStorage.getItem('kelabo-notif') === '1')
      setSounds(localStorage.getItem('kelabo-sounds') !== '0')
      setFinalOnly(localStorage.getItem('kelabo-final-only') === '1')
      setMuteHidden(localStorage.getItem('kelabo-mute-hidden') === '1')
      setLang(localStorage.getItem('kelabo-stt-lang') || 'en')
      setThemeState(currentTheme())
      setSchemeState(currentScheme())
    }
    window.addEventListener(SETTINGS_SYNCED_EVENT, resync)
    return () => window.removeEventListener(SETTINGS_SYNCED_EVENT, resync)
  }, [identity]) // eslint-disable-line react-hooks/exhaustive-deps

  const signOutEverywhere = async () => {
    const ok = await confirm({
      title: 'Sign out everywhere?',
      body: "All refresh tokens for this account will be revoked. You'll need to sign in again on every device.",
      confirmLabel: 'Sign out everywhere',
    })
    if (!ok) return
    try {
      await api.logoutAll()
    } catch {}
    toast('Signed out everywhere')
    await refresh()
    navigate('/login')
  }

  return (
    <main className="page settings-page">
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Your profile, capture devices, integrations and data.</p>
      <Tabs tabs={SETTINGS_TABS} active={tab} onChange={setTab} />

      {tab === 'general' && (
        <>
          <section className="settings-section anim-in">
            <div className="section-title">Profile</div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Display name</div>
                <div className="sr-sub">Shown to other participants and used for diarized speakers.</div>
              </div>
              <input
                className="input input-narrow"
                value={name}
                onChange={e => saveName(e.target.value)}
                aria-label="Display name"
              />
            </div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Avatar</div>
                <div className="sr-sub">
                  Generated from your address — no upload, same everywhere. Not fond of it? Roll another;
                  colleagues see whichever one you keep.
                </div>
              </div>
              <div className="settings-control">
                <Avatar id={identity?.email} name={name} variant={avatarVariant} size={40} />
                <Button size="sm" onClick={rollAvatar}>
                  <Icon name="sparkles" size={14} />Try another
                </Button>
                {avatarVariant > 0 && (
                  <Button size="sm" variant="ghost" onClick={resetAvatar}>Reset</Button>
                )}
              </div>
            </div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Email</div>
                <div className="sr-sub">{identity?.email || '—'}{tenantId ? ` · tenant: ${tenantId}` : ''}</div>
              </div>
              <span className="chip chip-live">verified</span>
            </div>
          </section>

          <section className="settings-section anim-in">
            <div className="section-title">Appearance</div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Theme</div>
                <div className="sr-sub">Light or dark, within the colour scheme below.</div>
              </div>
              <div className="segmented segmented-static">
                <button className={theme === 'light' ? 'active' : ''} onClick={() => pickTheme('light')}>Light</button>
                <button className={theme === 'dark' ? 'active' : ''} onClick={() => pickTheme('dark')}>Dark</button>
              </div>
            </div>
            <div className="settings-row settings-row-stacked">
              <div className="sr-main">
                <div className="sr-title">Colour scheme</div>
                <div className="sr-sub">Each scheme has its own light and dark variant. Synced across your devices.</div>
              </div>
              <div className="scheme-grid" role="radiogroup" aria-label="Colour scheme">
                {SCHEMES.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={scheme === s.id}
                    className={'scheme-card' + (scheme === s.id ? ' selected' : '')}
                    onClick={() => pickScheme(s.id)}
                    title={s.hint}
                  >
                    {/* Swatches are rendered inside a nested data-scheme, so each
                        card previews its own palette in the current theme rather
                        than restating the hex values in JS. */}
                    <span className="scheme-swatches" data-scheme={s.id}>
                      <span className="scheme-sw scheme-sw-bg"></span>
                      <span className="scheme-sw scheme-sw-surface"></span>
                      <span className="scheme-sw scheme-sw-accent"></span>
                      <span className="scheme-sw scheme-sw-text"></span>
                    </span>
                    <span className="scheme-name">{s.label}</span>
                    <span className="scheme-hint">{s.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        </>
      )}

      {tab === 'capture' && (
        <>
          <section className="settings-section anim-in">
            <div className="section-title">Joining a kelabo</div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Join muted</div>
                <div className="sr-sub">
                  Start every kelabo with your microphone off. Nothing is streamed or transcribed until you unmute.
                </div>
              </div>
              <Switch checked={joinMuted} onChange={onJoinMutedChange} ariaLabel="Join muted" />
            </div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Join with camera on</div>
                <div className="sr-sub">
                  Start every kelabo sharing video. You can change it for a single kelabo on the way in.
                </div>
              </div>
              <Switch checked={joinCamera} onChange={onJoinCameraChange} ariaLabel="Join with camera on" />
            </div>
          </section>

          <section className="settings-section anim-in">
            <div className="section-title">Capture</div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Default language</div>
                <div className="sr-sub">Preselected transcription language when you join a kelabo.</div>
              </div>
              <Select
                className="input-narrow"
                value={lang}
                onChange={onLangChange}
                ariaLabel="Default transcription language"
                options={[
                  { value: 'en', label: 'English' },
                  { value: 'zh', label: '中文' },
                  { value: 'es', label: 'Español' },
                  { value: 'fr', label: 'Français' },
                  { value: 'de', label: 'Deutsch' },
                  { value: 'ja', label: '日本語' },
                  { value: 'ko', label: '한국어' },
                  { value: 'multi', label: 'Auto (multi)' },
                ]}
              />
            </div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Final only</div>
                <div className="sr-sub">Hide interim (partial) transcript lines; show only finalized utterances.</div>
              </div>
              <Switch checked={finalOnly} onChange={onFinalOnlyChange} ariaLabel="Final only" />
            </div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Auto-mute when the tab is inactive</div>
                <div className="sr-sub">
                  Mute as soon as you switch away from the kelabo tab, and unmute when you come back — so
                  the call you took in another tab does not go into this one. A mute you set yourself is
                  never undone.
                </div>
              </div>
              <Switch checked={muteHidden} onChange={onMuteHiddenChange} ariaLabel="Auto-mute when the tab is inactive" />
            </div>
          </section>

          <section className="settings-section anim-in">
            <div className="section-title">Notifications</div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Board notifications</div>
                <div className="sr-sub">OS notification when a new contribution arrives while the tab is unfocused.</div>
              </div>
              <Switch checked={notif} onChange={onNotifChange} ariaLabel="Board notifications" />
            </div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Room sounds</div>
                <div className="sr-sub">A soft chime when someone joins, leaves, or sends a message. The chime follows your colour scheme.</div>
              </div>
              <Switch checked={sounds} onChange={onSoundsChange} ariaLabel="Room sounds" />
            </div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="text-meta">
                  Works only while a browser tab is open. Browser-closed tray notifications would need a desktop app.
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {tab === 'integrations' && (
        <>
          <section className="settings-section anim-in">
            <div className="section-title">MCP servers</div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="text-meta">
                  Tool servers the kelabo assistant can call (e.g. Jira, wiki, internal APIs). They apply to every kelabo you host — opt out per kelabo when creating it.
                </div>
              </div>
            </div>
            {(mcpServers || []).map(s => (
              <div className="panel-inset mcp-row" key={s.name}>
                <div className="flex-1">
                  <div className="mcp-name">
                    {s.name}
                    {s.authType === 'oauth' ? (
                      s.connected
                        ? <span className="chip chip-live">connected</span>
                        : <span className="chip chip-warn">not connected</span>
                    ) : s.hasSecret ? (
                      <span className="chip">token</span>
                    ) : null}
                  </div>
                  {s.url && <div className="mcp-url">{s.url}</div>}
                  {s.authType === 'oauth' && !s.connected && (
                    <div className="text-meta mcp-warn">
                      Not connected — the assistant cannot use this server yet.
                    </div>
                  )}
                </div>
                <Switch checked={s.enabled !== false} onChange={on => toggleMcp(s, on)} ariaLabel={`Enable ${s.name}`} />
                {s.authType === 'oauth' && (
                  s.connected ? (
                    <Button size="sm" disabled={mcpBusy === s.name} onClick={() => disconnectMcp(s)}>
                      Disconnect
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => connectMcp(s.name)}>Connect</Button>
                  )
                )}
                <Button size="sm" onClick={() => setMcpForm({ editing: true, name: s.name, url: s.url || '', secret: '', saving: false, probe: null, probing: false })}>Edit</Button>
                <Button variant="outline-danger" size="sm" onClick={() => removeMcp(s)}>Remove</Button>
              </div>
            ))}
            {mcpServers && mcpServers.length === 0 && !mcpForm && (
              <div className="empty">No servers yet.</div>
            )}
            {mcpForm ? (
              <div className="panel-inset">
                <div className="field">
                  <label className="label" htmlFor="mcp-name">Name</label>
                  <input
                    className="input"
                    id="mcp-name"
                    placeholder="jira"
                    maxLength={64}
                    value={mcpForm.name}
                    disabled={mcpForm.editing}
                    onChange={e => setMcpForm(f => ({ ...f, name: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label className="label" htmlFor="mcp-url">Server URL (streamable HTTP)</label>
                  <input
                    className="input"
                    id="mcp-url"
                    placeholder="https://mcp.example.com/jira"
                    maxLength={512}
                    value={mcpForm.url}
                    onChange={e => setMcpForm(f => ({ ...f, url: e.target.value, probe: null }))}
                    onBlur={e => probeMcpUrl(e.target.value)}
                  />
                  {mcpForm.probing && (
                    <div className="text-meta">Checking how this server authenticates…</div>
                  )}
                </div>
                {mcpForm.probe?.authType === 'oauth' && mcpForm.probe?.dynamicRegistration ? (
                  <div className="text-meta field">
                    This server uses OAuth. Saving will take you to its sign-in page — no token needed.
                  </div>
                ) : (
                  <div className="field">
                    <label className="label" htmlFor="mcp-secret">Auth token (optional)</label>
                    <input
                      className="input"
                      id="mcp-secret"
                      type="password"
                      placeholder={mcpForm.editing ? 'Leave blank to keep the existing token' : 'Sent as a Bearer token'}
                      maxLength={2048}
                      value={mcpForm.secret}
                      onChange={e => setMcpForm(f => ({ ...f, secret: e.target.value }))}
                    />
                    {mcpForm.probe?.authType === 'oauth' && !mcpForm.probe?.dynamicRegistration && (
                      <div className="text-meta">
                        This server uses OAuth but does not support automatic client registration, so a token is still required.
                      </div>
                    )}
                  </div>
                )}
                <div className="action-row">
                  <Button size="sm" onClick={() => setMcpForm(null)}>Cancel</Button>
                  <Button size="sm" variant="primary" onClick={saveMcp} disabled={mcpForm.saving || mcpForm.probing}>
                    {mcpForm.saving
                      ? 'Saving…'
                      : mcpForm.probe?.authType === 'oauth' && mcpForm.probe?.dynamicRegistration
                        ? 'Save & connect'
                        : 'Save'}
                  </Button>
                </div>
              </div>
            ) : (
              <Button block onClick={() => setMcpForm({ editing: false, name: '', url: '', secret: '', saving: false, probe: null, probing: false })}>
                <Icon name="plus" />Add MCP server
              </Button>
            )}
          </section>

          <section className="settings-section anim-in">
            <div className="section-title">Coding agents</div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="text-meta">
                  Agents running on your own machine that can join your kelabos. They read the transcript of
                  kelabos you attach them to and post to those boards as you — nothing else. Your model, your
                  MCP servers and your code stay on your machine.
                </div>
              </div>
            </div>

            {agents === null ? (
              <div className="empty">Loading…</div>
            ) : agents.length === 0 ? (
              <div className="empty">
                No agents connected. Run <code>kelabo login</code> in your terminal, then enter the code it
                prints on the <Link to="/pair">pairing page</Link>.
              </div>
            ) : (
              agents.map(a => (
                <div className="panel-inset mcp-row" key={a.jti}>
                  <div className="flex-1">
                    <div className="mcp-name">
                      {a.label || a.runtime}
                      <span className="chip chip-dev">{a.runtime}</span>
                    </div>
                    <div className="mcp-url">
                      Connected {new Date(a.createdAt).toLocaleDateString()}
                      {a.lastSeenAt ? ` · last used ${new Date(a.lastSeenAt).toLocaleDateString()}` : ' · never used'}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={agentBusy === a.jti}
                    onClick={() => revokeAgent(a)}
                  >
                    {agentBusy === a.jti ? 'Revoking…' : 'Revoke'}
                  </Button>
                </div>
              ))
            )}
          </section>
        </>
      )}

      {tab === 'data' && (
        <>
          <section className="settings-section anim-in">
            <div className="section-title">Records retention</div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Delete after</div>
                <div className="sr-sub">Records older than this are removed. Hosted kelabos are deleted entirely; ones you only attended are just removed from your list.</div>
              </div>
              <div className="settings-control">
                <div className="input-group">
                  <input
                    id="purge-value"
                    type="number"
                    min={1}
                    max={99}
                    aria-label="Older than"
                    value={purgeValue}
                    // The `max` attribute alone doesn't block a typed-in value above it
                    // (only the spinner arrows respect it), so clamp in JS too — same
                    // 1..99 bound purgeRecordsBodySchema enforces server-side, regardless
                    // of unit.
                    onChange={e => { setPurgeValue(Math.min(99, Math.max(1, Number(e.target.value) || 1))); setPurgePreview(null) }}
                  />
                  <Select
                    id="purge-unit"
                    ariaLabel="Unit"
                    value={purgeUnit}
                    onChange={u => { setPurgeUnit(u); setPurgePreview(null) }}
                    options={[
                      { value: 'days', label: 'days' },
                      { value: 'weeks', label: 'weeks' },
                      { value: 'months', label: 'months' },
                      { value: 'years', label: 'years' },
                    ]}
                  />
                </div>
                <Button onClick={runPurgePreview} disabled={purging}>
                  {purging ? 'Checking…' : 'Check'}
                </Button>
              </div>
            </div>
            {purgePreview && (
              purgePreview.purged.length + purgePreview.removedFromList.length === 0 ? (
                <p className="text-meta settings-note">
                  Nothing older than {purgeValue} {purgeUnit}.
                </p>
              ) : (
                <div className="panel-inset settings-note">
                  <div className="purge-summary">
                    {purgePreview.purged.length > 0 && (
                      <div><strong>{purgePreview.purged.length}</strong> hosted record{purgePreview.purged.length === 1 ? '' : 's'} will be permanently deleted.</div>
                    )}
                    {purgePreview.removedFromList.length > 0 && (
                      <div><strong>{purgePreview.removedFromList.length}</strong> attended record{purgePreview.removedFromList.length === 1 ? '' : 's'} will be removed from your list only.</div>
                    )}
                    {purgePreview.skipped.length > 0 && (
                      <div className="text-meta">{purgePreview.skipped.length} skipped (not ended).</div>
                    )}
                    {purgePreview.remaining > 0 && (
                      <div className="text-meta">Processed in batches — {purgePreview.remaining} more after this run.</div>
                    )}
                  </div>
                  <div className="scroll-list text-meta">
                    <ul>
                      {[...purgePreview.purged, ...purgePreview.removedFromList].slice(0, 20).map(r => (
                        <li key={r.archiveId}>
                          {r.title || r.archiveId}
                          {r.endedAt ? ` — ${new Date(r.endedAt).toLocaleDateString()}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="action-row">
                    <Button size="sm" onClick={() => setPurgePreview(null)} disabled={purging}>Cancel</Button>
                    <Button variant="outline-danger" size="sm" onClick={runPurge} disabled={purging}>
                      {purging ? 'Deleting…' : 'Delete permanently'}
                    </Button>
                  </div>
                </div>
              )
            )}
          </section>

          <section className="settings-section settings-danger anim-in">
            <div className="section-title">Danger zone</div>
            <div className="settings-row">
              <div className="sr-main">
                <div className="sr-title">Sign out everywhere</div>
                <div className="sr-sub">Revokes all refresh tokens for this account on every device.</div>
              </div>
              <Button variant="outline-danger" size="sm" onClick={signOutEverywhere}>Sign out</Button>
            </div>
          </section>
        </>
      )}
    </main>
  )
}
