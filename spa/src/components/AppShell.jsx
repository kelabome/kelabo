import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { api, logout } from '../api'
import { SETTINGS_SYNCED_EVENT } from '../settings'
import { useAuth, displayName } from '../auth'
import { themeIcon, toggleTheme } from '../theme'
import { pushSettings } from '../settings'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'
import { Avatar, myAvatarVariant } from './ui/Avatar'
import { Menu, MenuItem } from './ui/Menu'
import { StartingSoon } from './StartingSoon'
import { SearchDialog } from './SearchDialog'
import { CallDialog } from './CallDialog'
import { NewJourneyModal } from './NewJourneyModal'
import { kelaboKindIcon } from '../kelaboKind'
import { useToast } from './Toaster'
import { useConfirm } from './ConfirmDialog'

/**
 * Application frame: a persistent left rail plus a content column.
 *
 * Replaces the old horizontal top bar. The rail holds navigation, the primary
 * "New kelabo" action and a live list of recents, so the thing you most often
 * want to reach next is always one click away instead of one navigation away.
 * The content column below is deliberately narrow — long lines are harder to
 * scan than the extra width is worth.
 *
 * The rail is hidden entirely in the kelabo room, which is a focus view with
 * its own full-bleed two-pane layout and no room for chrome.
 */

const SIDEBAR_KEY = 'kelabo-sidebar-collapsed'

/** Kelabos + records, fetched once here rather than per-route. */
const AppDataContext = createContext({
  kelabos: null,
  records: null,
  scheduled: null,
  kelabosError: false,
  recordsError: false,
  pendingArchive: new Set(),
  removeRecord: () => {},
  endLiveKelabo: () => {},
  respondToInvite: () => {},
  cancelScheduled: () => {},
})

export function useAppData() {
  return useContext(AppDataContext)
}

/**
 * "Tue 14:00" — enough to recognise which kelabo this is, short enough for a
 * 250px rail. Today and tomorrow are named, because "Wed" is ambiguous when
 * today is Wednesday.
 */
function shortWhen(at) {
  const d = new Date(at)
  const now = new Date()
  const days = Math.round((d.setHours(0, 0, 0, 0) - now.setHours(0, 0, 0, 0)) / 86400000)
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (days === 0) return time
  if (days === 1) return `Tmrw ${time}`
  if (days < 7) return `${new Date(at).toLocaleDateString([], { weekday: 'short' })} ${time}`
  return new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export function AppShell({ children }) {
  const { identity } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const confirm = useConfirm()

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [newJourneyOpen, setNewJourneyOpen] = useState(false)
  // A contact picked from the search dialog to call — hands over to CallDialog.
  const [callTo, setCallTo] = useState(null)
  const [icon, setIcon] = useState(themeIcon())

  const [kelabos, setKelabos] = useState(null)
  const [kelabosError, setKelabosError] = useState(false)
  const [records, setRecords] = useState(null)
  const [recordsError, setRecordsError] = useState(false)
  const [scheduled, setScheduled] = useState(null)
  // Kelabos ended from here whose record has not landed yet. The server drops
  // a kelabo from the active list the moment it ends and the archive arrives
  // seconds later — without this set the row vanishes from Live now on the
  // next poll and pops back under Recents a minute after that. A ref AND
  // state: the ref is read inside the polling closure, the state re-renders.
  const pendingArchiveRef = useRef(new Set())
  const [pendingArchive, setPendingArchive] = useState(() => new Set())

  // Re-render on any settings change (local edit or a pull from another
  // device): the rail's name and avatar variant are read from localStorage
  // during render, so all this needs is the nudge.
  const [, settingsBump] = useState(0)
  useEffect(() => {
    const resync = () => settingsBump(n => n + 1)
    window.addEventListener(SETTINGS_SYNCED_EVENT, resync)
    return () => window.removeEventListener(SETTINGS_SYNCED_EVENT, resync)
  }, [])

  // The name the user chose in Settings wins over the identity-derived one —
  // the same precedence every join flow uses.
  const name = localStorage.getItem('kelabo-name') || displayName(identity)

  // Active kelabos drive the rail's live badges, so they poll; records only
  // change when a kelabo ends, so they reload on navigation instead.
  useEffect(() => {
    if (!identity) return undefined
    let cancelled = false
    const load = () => {
      api.listKelabos()
        .then(data => {
          if (cancelled) return
          const incoming = Array.isArray(data) ? data : (data?.active || data?.kelabos || [])
          // A kelabo ended from here keeps its row — marked ended — until its
          // record exists. The active list drops it at once, and leaving the
          // gap to the record list is what made an ended kelabo disappear for
          // a minute before popping up under Recents.
          setKelabos(prev => {
            // A kelabo that was live and is gone ended somewhere else (the
            // room, another device): refresh the records now rather than on
            // the next navigation, so it lands under Recents continuously.
            const vanished = (prev || []).filter(
              x => x.status === 'active'
                && !pendingArchiveRef.current.has(x.kelaboId)
                && !incoming.some(y => y.kelaboId === x.kelaboId)
            )
            if (vanished.length) {
              // The archive trails the end by seconds, so look twice: now,
              // and once more shortly after.
              const refresh = () => api.listRecords()
                .then(d => { if (!cancelled) setRecords(Array.isArray(d) ? d : (d?.records || [])) })
                .catch(() => {})
              refresh()
              setTimeout(refresh, 4000)
            }
            return [
              ...incoming,
              ...(prev || []).filter(
                x => pendingArchiveRef.current.has(x.kelaboId) && !incoming.some(y => y.kelaboId === x.kelaboId)
              ),
            ]
          })
          setKelabosError(false)
        })
        .catch(() => { if (!cancelled) setKelabosError(true) })
    }
    load()
    const t = setInterval(load, 8000)
    return () => { cancelled = true; clearInterval(t) }
  }, [identity])

  // Scheduled kelabos change rarely, so this reloads on navigation like records
  // — plus a slow timer, which the navigation reload cannot replace: the
  // starting-soon prompt (notes #9) has to fire for somebody who left the tab
  // open on one page, which is precisely when no navigation ever happens. A
  // minute is well inside the 30-second lead time it needs to notice.
  useEffect(() => {
    if (!identity) return undefined
    let cancelled = false
    const load = () => {
      api.listScheduled()
        .then(data => { if (!cancelled) setScheduled(data?.scheduled || []) })
        .catch(() => { if (!cancelled) setScheduled(list => list || []) })
    }
    load()
    const t = setInterval(load, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [identity, location.pathname])

  useEffect(() => {
    if (!identity) return
    api.listRecords()
      .then(data => {
        setRecords(Array.isArray(data) ? data : (data?.records || []))
        setRecordsError(false)
      })
      .catch(() => setRecordsError(true))
  }, [identity, location.pathname])

  // A tap on a rail link should dismiss the mobile drawer it was tapped in.
  useEffect(() => { setMobileOpen(false) }, [location.pathname])

  const toggleCollapsed = () => {
    setCollapsed(c => {
      localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1')
      return !c
    })
  }

  const onToggleTheme = () => {
    toggleTheme()
    setIcon(themeIcon())
    pushSettings()
  }

  /**
   * Remove one record. Hosts destroy it; participants only drop it from their
   * own list — the confirmation says which, because "delete" would be a lie for
   * a participant and an understatement for a host.
   *
   * `skipConfirm` is Shift-click. Clearing out a page of old kelabos is the one
   * time the dialog is pure friction — the answer is yes twenty times running —
   * and holding a modifier is itself a deliberate act, which is all the
   * confirmation was ever asking for. It is never the default and never
   * triggered by a plain click.
   */
  const removeRecord = async (r, { skipConfirm = false } = {}) => {
    const id = r.archiveId || r.kelaboId
    const isHost = !!(identity && r.host && r.host === identity.email)
    const ok = skipConfirm || await confirm({
      title: isHost ? `Delete “${r.title}”?` : `Remove “${r.title}”?`,
      body: isHost
        ? 'This permanently deletes the transcript, board and minutes for everyone who attended. It cannot be undone.'
        : 'This removes the kelabo from your list. The host keeps their copy.',
      confirmLabel: isHost ? 'Delete permanently' : 'Remove',
    })
    if (!ok) return
    // Drop it locally first: the list is a navigation aid, and waiting on a
    // round-trip to un-render something the user just dismissed feels broken.
    setRecords(list => (list || []).filter(x => (x.archiveId || x.kelaboId) !== id))
    try {
      const res = await api.deleteRecord(id)
      toast(res?.outcome === 'purged' ? 'Kelabo deleted' : 'Removed from your list')
      // If the deleted record is the page we are on, there is nothing to show.
      if (location.pathname === `/kelabos/${id}`) navigate('/kelabos', { replace: true })
    } catch (e) {
      toast(e?.message || 'Could not remove that kelabo')
      api.listRecords()
        .then(data => setRecords(Array.isArray(data) ? data : (data?.records || [])))
        .catch(() => {})
    }
  }

  /**
   * End a live kelabo from outside it (notes #6).
   *
   * Ending used to require being in the room, which is the wrong place to need
   * to be: the kelabo that gets left running is the one everybody already
   * walked away from, and rejoining it — microphone, camera, conference audio,
   * a Deepgram socket — purely to press one button is a lot of machinery for a
   * decision already made. Same endpoint, same host-only check on the server.
   *
   * Always confirmed, never Shift-skippable, unlike removing a record: this one
   * acts on other people who are still in the room.
   */
  const endLiveKelabo = async m => {
    const ok = await confirm({
      title: `End “${m.title}”?`,
      body: `The kelabo ends for everyone still in it${
        m.participantCount ? ` (${m.participantCount} participant${m.participantCount === 1 ? '' : 's'})` : ''
      }. The record is archived.`,
      confirmLabel: 'End kelabo',
    })
    if (!ok) return
    try {
      await api.endKelabo(m.kelaboId)
      // The poll is 8 seconds away and the row is the thing that was just acted
      // on; leaving it reading "live" is the state the click was meant to change.
      setKelabos(list => (list || []).map(x => (x.kelaboId === m.kelaboId ? { ...x, status: 'ended' } : x)))
      pendingArchiveRef.current.add(m.kelaboId)
      setPendingArchive(new Set(pendingArchiveRef.current))
      // No capability map in this list view, so no promise about minutes —
      // the record view says what actually arrived (docs 19 §2).
      toast('Kelabo ended — archiving the record…')
      // The archive is a gateway-side job that trails the end by seconds.
      // Watch the record list until the kelabo lands in it, so the row moves
      // from Live now to Recents on its own instead of waiting for a refresh.
      let tries = 0
      const watch = setInterval(async () => {
        tries += 1
        let found = false
        try {
          const data = await api.listRecords()
          const list = Array.isArray(data) ? data : (data?.records || [])
          setRecords(list)
          // archiveId IS the kelaboId for a fresh archive (gateway archive.js).
          found = list.some(r => (r.archiveId || r.kelaboId) === m.kelaboId)
        } catch { /* keep watching — a failed read says nothing about the archive */ }
        if (found || tries >= 24) {
          clearInterval(watch)
          pendingArchiveRef.current.delete(m.kelaboId)
          setPendingArchive(new Set(pendingArchiveRef.current))
          if (found) setKelabos(list => (list || []).filter(x => x.kelaboId !== m.kelaboId))
        }
      }, 2500)
    } catch (e) {
      toast(e?.code === 'already_ended' ? 'That kelabo had already ended' : 'Could not end that kelabo')
    }
  }

  /**
   * Answer an invitation from inside the app (notes #8).
   *
   * The emailed link still works and is still the only route for someone with
   * no account. This is the second door: an invitation is a thing that happened
   * to you at this domain, so it belongs on the page you already have open,
   * rather than in a mail client you have to go and find.
   *
   * "pending" is how you take an answer back — un-accept, un-decline — which is
   * a real thing people do and previously had no spelling at all.
   */
  const respondToInvite = async (m, response) => {
    const previous = m.myResponse
    setScheduled(list => (list || []).map(x => (x.kelaboId === m.kelaboId ? { ...x, myResponse: response } : x)))
    try {
      await api.rsvp(m.kelaboId, response)
    } catch (e) {
      // Put the old answer back rather than leaving the list asserting something
      // the host will never see.
      setScheduled(list => (list || []).map(x => (x.kelaboId === m.kelaboId ? { ...x, myResponse: previous } : x)))
      toast(e?.code === 'kelabo_cancelled' ? 'That kelabo was cancelled' : 'Could not save your answer — try again')
    }
  }

  /**
   * Cancel a kelabo you scheduled, from the list it appears in.
   *
   * Same endpoint the detail page calls. It lives here rather than on the page
   * because the list on Home and the rail both hold the row, and both need the
   * row to disappear the moment it is called off.
   */
  const cancelScheduled = async m => {
    const ok = await confirm({
      title: `Cancel “${m.title}”?`,
      body: 'Invitees with an email address are told it was called off. This cannot be undone.',
      confirmLabel: 'Cancel kelabo',
      cancelLabel: 'Keep it',
    })
    if (!ok) return
    try {
      await api.cancelKelabo(m.kelaboId)
      setScheduled(list => (list || []).filter(x => x.kelaboId !== m.kelaboId))
      toast('Kelabo cancelled')
    } catch (e) {
      if (e?.code === 'already_active') toast('It has already started — end it from the room instead')
      else toast('Could not cancel that kelabo')
    }
  }

  const live = (kelabos || []).filter(m => m.status === 'active')
  // Only what is still ahead, soonest first, and only a few — the rail is a way
  // back to something, not an agenda.
  const upcoming = (scheduled || [])
    .filter(m => m.status === 'scheduled')
    .slice(0, 6)
  const recents = (records || []).slice(0, 8)

  return (
    <AppDataContext.Provider value={{ kelabos, records, scheduled, kelabosError, recordsError, pendingArchive, removeRecord, endLiveKelabo, respondToInvite, cancelScheduled }}>
      <div className={'shell' + (collapsed ? ' shell-collapsed' : '')}>
        <div
          className={'sidebar-veil' + (mobileOpen ? ' open' : '')}
          onClick={() => setMobileOpen(false)}
        ></div>

        <aside className={'sidebar' + (mobileOpen ? ' open' : '')} aria-label="Main">
          <div className="sidebar-head">
            <Link className="brand" to="/" title="kelabo">
              <span className="logo" aria-hidden="true"></span>
              <span className="sidebar-label">kelabo</span>
            </Link>
            <div className="sidebar-tools">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={() => setSearchOpen(true)}
                title="Search contacts and kelabos"
                aria-label="Search contacts and kelabos"
              >
                <Icon name="search" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                className="sidebar-collapse"
                onClick={toggleCollapsed}
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                <Icon name="sidebar" />
              </Button>
            </div>
          </div>

          {/* The things that CREATE something, in their own block. They were
              identical nav rows before — New kelabo, Schedule, Home, Kelabos
              — and nothing said which ones started something and which ones
              went somewhere, so the group read as the top of the nav list
              rather than as its own thing (notes #10). A tinted, bordered
              block and a rule beneath it say it once, without giving any row
              a colour loud enough to compete with the filled button on the
              page it opens. */}
          <div className="sidebar-actions">
            <Link className="sidebar-item sidebar-new" to="/new" title="New kelabo">
              <Icon name="plus" />
              <span className="sidebar-label">New kelabo</span>
            </Link>
            <Link className="sidebar-item sidebar-new sidebar-new-alt" to="/schedule" title="Schedule a kelabo">
              <Icon name="calendar" />
              <span className="sidebar-label">Schedule</span>
            </Link>
            {/* The third way to end up in a kelabo, beside starting one now and
                putting one in the diary: somebody read you a code. It belongs
                in this block rather than the nav below because it is a thing
                you do, not a place you go. */}
            <Link className="sidebar-item sidebar-new sidebar-new-alt" to="/enter" title="Join with a code">
              <Icon name="arrow-right" />
              <span className="sidebar-label">Join</span>
            </Link>
            {/* A journey is created, not joined or scheduled, but it belongs in
                this action block for the same reason the three above do —
                reachable from anywhere, not just from /journeys itself. No
                route to navigate to (creation is a modal, docs 20 §11), so a
                button rather than a Link, styled identically either way. */}
            <button
              type="button"
              className="sidebar-item sidebar-new sidebar-new-alt"
              onClick={() => setNewJourneyOpen(true)}
              title="New journey"
            >
              <Icon name="plus" />
              <span className="sidebar-label">New journey</span>
            </button>
          </div>

          <nav className="sidebar-nav">
            <NavLink to="/" end className={({ isActive }) => 'sidebar-item' + (isActive ? ' active' : '')} title="Home">
              <Icon name="home" />
              <span className="sidebar-label">Home</span>
            </NavLink>
            <NavLink to="/kelabos" className={({ isActive }) => 'sidebar-item' + (isActive ? ' active' : '')} title="Past kelabos">
              <Icon name="archive" />
              <span className="sidebar-label">Kelabos</span>
            </NavLink>
            <NavLink to="/journeys" className={({ isActive }) => 'sidebar-item' + (isActive ? ' active' : '')} title="Journeys">
              <Icon name="book-open" />
              <span className="sidebar-label">Journeys</span>
            </NavLink>
            <NavLink to="/contacts" className={({ isActive }) => 'sidebar-item' + (isActive ? ' active' : '')} title="Contacts">
              <Icon name="users" />
              <span className="sidebar-label">Contacts</span>
            </NavLink>
          </nav>

          <div className="sidebar-scroll">
            {upcoming.length > 0 && (
              <>
                <div className="sidebar-section sidebar-label">Scheduled</div>
                {upcoming.map(m => (
                  <Link
                    key={m.kelaboId}
                    className="sidebar-item sidebar-entry"
                    to={`/scheduled/${m.kelaboId}`}
                    title={`${m.title} — ${new Date(m.scheduledAt).toLocaleString()}`}
                  >
                    <span className="sdot sdot-scheduled"></span>
                    <span className="sidebar-label sidebar-entry-title">{m.title}</span>
                    <span className="sidebar-label sidebar-when">{shortWhen(m.scheduledAt)}</span>
                  </Link>
                ))}
              </>
            )}

            {live.length > 0 && (
              <>
                <div className="sidebar-section sidebar-label">Live now</div>
                {live.map(m => (
                  <Link
                    key={m.kelaboId}
                    className="sidebar-item sidebar-entry"
                    to={`/join/${m.kelaboId}`}
                    title={m.title}
                  >
                    <Icon name={kelaboKindIcon(m)} size={14} className="kind-icon kind-icon-live" />
                    <span className="sidebar-label sidebar-entry-title">{m.title}</span>
                  </Link>
                ))}
              </>
            )}

            {recents.length > 0 && (
              <>
                <div className="sidebar-section sidebar-label">Recents</div>
                {recents.map(r => (
                  <div className="sidebar-entry-wrap" key={r.archiveId || r.kelaboId}>
                    <Link
                      className="sidebar-item sidebar-entry"
                      to={`/kelabos/${r.archiveId || r.kelaboId}`}
                      title={r.title}
                    >
                      {/* Dialed and convened kelabos share this list; the glyph
                          says which was which (see kelaboKind.js). */}
                      <Icon name={kelaboKindIcon(r)} size={14} className="kind-icon" />
                      <span className="sidebar-label sidebar-entry-title">{r.title}</span>
                    </Link>
                    <button
                      className="remove-btn remove-btn-float sidebar-label"
                      onClick={e => removeRecord(r, { skipConfirm: e.shiftKey })}
                      title={`Remove ${r.title} — hold Shift to skip the confirmation`}
                      aria-label={`Remove ${r.title}`}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="sidebar-foot">
            <Menu
              ariaLabel="Account"
              className="sidebar-account"
              renderTrigger={props => (
                <Button variant="ghost" size="sm" block title={name || 'Account'} {...props}>
                  <Avatar id={identity?.email} name={name} variant={myAvatarVariant()} />
                  <span className="sidebar-label sidebar-entry-title">{name}</span>
                </Button>
              )}
            >
              {({ close }) => (
                <>
                  <div className="menu-id">
                    <Avatar id={identity?.email} name={name} variant={myAvatarVariant()} />
                    <div className="menu-id-text">
                      <div className="menu-id-name">{name}</div>
                      {identity?.email && identity.email !== name && (
                        <div className="menu-id-email">{identity.email}</div>
                      )}
                    </div>
                  </div>
                  <MenuItem icon={<Icon name="settings" />} onClick={() => { close(); navigate('/settings') }}>
                    Settings
                  </MenuItem>
                  <MenuItem icon={<Icon name="logout" />} onClick={() => logout()}>
                    Sign out
                  </MenuItem>
                </>
              )}
            </Menu>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={onToggleTheme}
              title="Toggle theme"
              aria-label="Toggle theme"
            >
              <Icon name={icon} />
            </Button>
          </div>
        </aside>

        {/* Mounted in the shell so it finds you on whatever page you are on. */}
        <StartingSoon scheduled={scheduled} />

        {searchOpen && (
          <SearchDialog
            onClose={() => setSearchOpen(false)}
            onCall={email => { setSearchOpen(false); setCallTo(email) }}
          />
        )}
        {callTo && <CallDialog initial={callTo} onClose={() => setCallTo(null)} />}
        {newJourneyOpen && (
          <NewJourneyModal
            onClose={() => setNewJourneyOpen(false)}
            onCreated={id => { setNewJourneyOpen(false); navigate(`/journeys/${id}`) }}
          />
        )}

        <div className="shell-main">
          <div className="shell-mobilebar">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => setMobileOpen(true)}
              title="Menu"
              aria-label="Open menu"
            >
              <Icon name="menu" />
            </Button>
            {/* Same masked K tile as the sidebar brand — a typed "k" here
                survived the mask redesign and read as a different logo. */}
            <Link className="brand" to="/"><span className="logo" aria-hidden="true"></span>kelabo</Link>
          </div>
          {children}
        </div>
      </div>
    </AppDataContext.Provider>
  )
}
