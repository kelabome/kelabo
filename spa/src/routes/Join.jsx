import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTypeAnywhere } from '../useTypeAnywhere'
import { api } from '../api'
import { pushSettings } from '../settings'
import { useAuth, displayName } from '../auth'
import { TopBar } from '../components/TopBar'
import { Skeleton } from '../components/ui/Skeleton'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { useToast } from '../components/Toaster'
import { DeviceCheck } from '../components/DeviceCheck'

export default function Join() {
  const { id } = useParams()
  const toast = useToast()
  const navigate = useNavigate()
  const { identity, loading: authLoading } = useAuth()
  const [kelabo, setKelabo] = useState(null)
  const [state, setState] = useState('loading') // loading|invalid|ready|joining|error
  const [name, setName] = useState('')
  const [mode, setMode] = useState(localStorage.getItem('kelabo-mode') || 'audio-board')
  const nameRef = useRef(null)
  // Typing or pasting anywhere on the page fills the name box.
  useTypeAnywhere(nameRef, state === 'ready')

  useEffect(() => {
    if (authLoading) return
    setName(localStorage.getItem('kelabo-name') || displayName(identity) || '')
  }, [authLoading, identity])

  useEffect(() => {
    api.getKelabo(id)
      .then(m => {
        if (m.status === 'ended') {
          // An ended kelabo cannot be joined, but it can be read. Links to
          // /join outlive the kelabo (a journey's Kelabos tab held one for as
          // long as its status snapshot said "active") — send the visitor to
          // the record instead of a dead-end banner; RecordDetail applies its
          // own access rules.
          navigate(`/kelabos/${id}`, { replace: true })
        } else if (m.status && m.status !== 'active') {
          setState('invalid')
        } else {
          setKelabo(m)
          setState('ready')
        }
      })
      .catch(() => setState('invalid'))
  }, [id, navigate])

  const join = async () => {
    const displayNameValue = name.trim()
    if (!displayNameValue) {
      toast('Please enter your name')
      return
    }
    setState('joining')
    try {
      await api.joinKelabo(id, displayNameValue, mode)
      localStorage.setItem('kelabo-name', displayNameValue)
      pushSettings()
      localStorage.setItem('kelabo-mode', mode)
      navigate(`/m/${id}/lobby`)
    } catch (e) {
      setState('ready')
      if (e.status === 404 || e.status === 410) setState('invalid')
      else toast('Could not join — try again')
    }
  }

  return (
    <>
      <TopBar minimal showSignIn />
      <main className="page">
        <section className="card card-pad anim-in">
          {state === 'loading' && (
            <>
              <Skeleton className="skel-title" />
              <Skeleton className="skel-text" />
            </>
          )}

          {state === 'invalid' && (
            <>
              <h1 className="page-title">Can't join this kelabo</h1>
              <Banner kind="danger">This invite link is invalid or the kelabo has ended.</Banner>
              <p className="page-sub page-sub-tight">Ask the host for a fresh invite link.</p>
              {/* An ended kelabo's live META eventually expires, so this page
                  cannot tell "bad link" from "long over" — but the archived
                  record outlives the META, so offer it to someone signed in. */}
              {identity && (
                <p className="page-sub page-sub-tight">
                  If it already ended and you were part of it, <Link to={`/kelabos/${id}`}>its record may be available</Link>.
                </p>
              )}
            </>
          )}

          {(state === 'ready' || state === 'joining') && kelabo && (
            <>
              <div className="title-row">
                <h1 className="page-title">Join “{kelabo.title}”</h1>
                <span className="chip chip-live"><span className="dot"></span>live</span>
              </div>
              <p className="page-sub">
                Hosted by {kelabo.hostIdentity || 'the host'} · {kelabo.participantCount ?? (kelabo.participants || []).length} people in the room
              </p>

              <div className="field">
                <label className="label" htmlFor="name">Your name</label>
                <input
                  className="input"
                  id="name"
                  ref={nameRef}
                  placeholder="Sam"
                  autoComplete="name"
                  value={name}
                  autoFocus
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') join() }}
                />
              </div>

              {/* Only when there is a microphone to check. Watch-only joins have
                  nothing to set up, and showing them a dead level meter would
                  invite them to debug a device they deliberately opted out of. */}
              {mode === 'audio-board' && (
                <div className="field">
                  <span className="label">Camera and microphone</span>
                  <DeviceCheck />
                </div>
              )}

              <div className="field">
                <span className="label">How do you want to join?</span>
                <div className="vstack-sm">
                  <label className={'radio-card' + (mode === 'audio-board' ? ' selected' : '')}>
                    <input type="radio" name="mode" value="audio-board" checked={mode === 'audio-board'} onChange={() => setMode('audio-board')} />
                    <span>
                      <span className="rc-title">Join the call + watch board</span><br />
                      <span className="rc-sub">
                        You hear and are heard by everyone. Your speech is transcribed and the assistant can
                        help you.
                      </span>
                    </span>
                  </label>
                  <label className={'radio-card' + (mode === 'board-only' ? ' selected' : '')}>
                    <input type="radio" name="mode" value="board-only" checked={mode === 'board-only'} onChange={() => setMode('board-only')} />
                    <span>
                      <span className="rc-title">Watch board only</span><br />
                      <span className="rc-sub">Follow the shared board and transcript. No microphone, and not on the call.</span>
                    </span>
                  </label>
                </div>
              </div>

              <Button variant="primary" block onClick={join} disabled={state === 'joining'}>
                {state === 'joining' ? 'Joining…' : 'Join kelabo'}
              </Button>
              <p className="form-note">
                {identity ? 'Joining with your signed-in identity.' : 'Joining as a guest — no account needed.'}
              </p>
            </>
          )}
        </section>
      </main>
    </>
  )
}
