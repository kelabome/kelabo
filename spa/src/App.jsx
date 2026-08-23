import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth'
import { PresenceProvider } from './presence/PresenceContext'
import { ToastProvider } from './components/Toaster'
import { ConfirmProvider } from './components/ConfirmDialog'
import { PromptProvider } from './components/PromptDialog'
import { AppShell } from './components/AppShell'
import { Banner } from './components/ui/Banner'
import { Skeleton } from './components/ui/Skeleton'
import Home from './routes/Home'
import { Login, extraRoutes } from '@kelabo/variant'
import NewKelabo from './routes/NewKelabo'
import Schedule from './routes/Schedule'
import ScheduledKelabo from './routes/ScheduledKelabo'
import Invitation from './routes/Invitation'
import PairAgent from './routes/PairAgent'
import EnterCode from './routes/EnterCode'
import Lobby from './routes/Lobby'
import Join from './routes/Join'
import Kelabo from './routes/Kelabo'
import Records from './routes/Records'
import { RecordRedirect } from './routes/RecordRedirect'
import RecordDetail from './routes/RecordDetail'
import Journeys from './routes/Journeys'
import JourneyDetail from './routes/JourneyDetail'
import Contacts from './routes/Contacts'
import Settings from './routes/Settings'

/**
 * The signed-in application: everything inside the left rail.
 *
 * The kelabo flow (join → lobby → room) deliberately sits OUTSIDE this — those
 * are focus views, reachable by guests who have no account, and the room needs
 * the full viewport for its two panes.
 */
function ShellRoutes() {
  const { identity, loading } = useAuth()
  if (loading) {
    return (
      <AppShell>
        <main className="page">
          <Skeleton style={{ width: 220, height: 24, marginBottom: 18 }} />
          <Skeleton style={{ width: '100%', height: 62, marginBottom: 10 }} />
          <Skeleton style={{ width: '100%', height: 62 }} />
        </main>
      </AppShell>
    )
  }
  if (!identity) return <Navigate to="/login" replace />
  return <AppShell><Outlet /></AppShell>
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <PromptProvider>
          <AuthProvider>
            <BrowserRouter>
            <PresenceProvider>
              {!window.isSecureContext && (
                <div className="global-banner">
                  <Banner kind="danger">
                    This app is running in an insecure context — microphone capture needs https or localhost.
                  </Banner>
                </div>
              )}
              <Routes>
                <Route element={<ShellRoutes />}>
                  <Route path="/" element={<Home />} />
                  <Route path="/new" element={<NewKelabo />} />
                  <Route path="/schedule" element={<Schedule />} />
                  <Route path="/scheduled/:id" element={<ScheduledKelabo />} />
                  <Route path="/kelabos" element={<Records />} />
                  <Route path="/kelabos/:id" element={<RecordDetail />} />
                  <Route path="/journeys" element={<Journeys />} />
                  <Route path="/journeys/:id" element={<JourneyDetail />} />
                  <Route path="/contacts" element={<Contacts />} />
                  {/* Links already sent out — in notification payloads, in
                      "here's the record" messages — keep working. */}
                  <Route path="/records" element={<Navigate to="/kelabos" replace />} />
                  <Route path="/records/:id" element={<RecordRedirect />} />
                  {/* The previous name of the same page — links from before the
                      rename keep landing. */}
                  <Route path="/meetings" element={<Navigate to="/kelabos" replace />} />
                  <Route path="/meetings/:id" element={<RecordRedirect />} />
                  <Route path="/settings" element={<Settings />} />
                </Route>
                <Route path="/login" element={<Login />} />
                <Route path="/join/:id" element={<Join />} />
                <Route path="/invite/:id" element={<Invitation />} />
                {/* Outside the authenticated group so it can render its own
                    "sign in first" state, like /invite: the bridge opens this
                    URL in whatever browser the developer has, which may not be
                    signed in yet. */}
                <Route path="/pair" element={<PairAgent />} />
                {/* Outside the authenticated group for the same reason as
                    /join: whoever was read a join code is the one person
                    certain not to have a link, and may well have no account.
                    Short path because it gets said out loud too. */}
                <Route path="/enter" element={<EnterCode />} />
                <Route path="/m/:id/lobby" element={<Lobby />} />
                <Route path="/m/:id" element={<Kelabo />} />
                {/* Overlay-provided pages (empty in default builds). */}
                {extraRoutes.map(r => <Route key={r.path} path={r.path} element={r.element} />)}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </PresenceProvider>
            </BrowserRouter>
          </AuthProvider>
        </PromptProvider>
      </ConfirmProvider>
    </ToastProvider>
  )
}
