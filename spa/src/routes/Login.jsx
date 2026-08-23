import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, oidcStartUrl } from '../api'
import { config } from '../config'
import { useAuth } from '../auth'
import { TopBar } from '../components/TopBar'
import { OtpInput } from '../components/OtpInput'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { useToast } from '../components/Toaster'
import { useTypeAnywhere } from '../useTypeAnywhere'
import { previewRandomAppearance, restoreSavedAppearance } from '../theme'
import { normaliseDomain, resolveEmail } from '../emailDomain.js'

// The deployment's locked domain, or '' for open registration. Read once: it
// is baked into the bundle at build time, so it cannot change under us.
const lockedDomain = normaliseDomain(config.allowedEmailDomain)

function otpErrorMessage(err) {
  switch (err?.code) {
    case 'invalid_code':
    case 'code_expired':
      return 'Incorrect or expired code — try again.'
    case 'domain_not_allowed':
      // Reachable despite the check in sendCode: the server is the authority,
      // and a stale bundle can disagree with it after the domain is changed.
      return lockedDomain
        ? `Only @${lockedDomain} addresses can sign in.`
        : "This deployment only allows your organization's email domain."
    case 'rate_limited':
      return 'Too many attempts — wait a moment and try again.'
    // The mail never went out, and which of these it is decides who can do
    // anything about it. The server's own message is used when it sent one:
    // the useful part is always provider-specific (an SES sandbox wants a
    // verification email, an unverified MailerSend domain wants DNS records),
    // and a message written here would have to be wrong for one of them.
    case 'email_not_verified':
      return err.message || 'This deployment cannot email your address yet — ask whoever runs it to finish setting up sending.'
    case 'email_suppressed':
      return 'The email provider is blocking messages to this address, usually after an earlier one bounced or was marked as spam.'
    case 'mail_not_configured':
    case 'mail_failed':
      return 'Sign-in email is not working on this deployment — nothing you can do from here, tell whoever runs it.'
    default:
      return 'Something went wrong — try again.'
  }
}

export default function Login() {
  const toast = useToast()
  const navigate = useNavigate()
  const { identity, loading, refresh } = useAuth()
  const [step, setStep] = useState('email')
  const [email, setEmail] = useState('')
  const [state, setState] = useState('idle') // idle|sending|code_sent|verifying
  const [error, setError] = useState(null)
  const [countdown, setCountdown] = useState(0)
  const [otpKey, setOtpKey] = useState(0)
  // The code as typed so far, reported by OtpInput — the Verify button reads
  // this instead of scraping the boxes out of the DOM by class name.
  const [code, setCode] = useState('')
  const timerRef = useRef(null)
  const emailRef = useRef(null)

  // Typing or pasting anywhere on the email step goes into the email box.
  // (The OTP step captures its own digits — see OtpInput.)
  useTypeAnywhere(emailRef, step === 'email')

  useEffect(() => {
    if (!loading && identity) navigate('/', { replace: true })
  }, [loading, identity, navigate])

  // Each visit to the sign-in page wears a random palette — a shop window for
  // the schemes. Preview only: leaving the page restores the saved appearance.
  useEffect(() => {
    previewRandomAppearance()
    return restoreSavedAppearance
  }, [])

  useEffect(() => () => clearInterval(timerRef.current), [])

  const startCountdown = seconds => {
    clearInterval(timerRef.current)
    const until = Date.now() + seconds * 1000
    localStorage.setItem('kelabo-otp-next', String(until))
    setCountdown(seconds)
    timerRef.current = setInterval(() => {
      const left = Math.ceil((Number(localStorage.getItem('kelabo-otp-next') || 0) - Date.now()) / 1000)
      if (left <= 0) {
        clearInterval(timerRef.current)
        setCountdown(0)
      } else {
        setCountdown(left)
      }
    }, 1000)
  }

  useEffect(() => {
    const left = Math.ceil((Number(localStorage.getItem('kelabo-otp-next') || 0) - Date.now()) / 1000)
    if (left > 0) startCountdown(left)
  }, [])

  const sendCode = async () => {
    // On a locked deployment a bare local part is enough — the domain is
    // filled in here. A wrong domain is refused without a round-trip.
    const resolved = resolveEmail(email, lockedDomain)
    if (!resolved.ok) {
      if (resolved.reason === 'wrong_domain') setError(`Only @${lockedDomain} addresses can sign in.`)
      else toast(lockedDomain ? `Enter your name, or your full @${lockedDomain} address` : 'Enter your work email')
      emailRef.current?.focus()
      return
    }
    const value = resolved.email
    // Show what was actually sent: the OTP step, resend and verify all read
    // this, so leaving a half-typed address in state would break verify.
    if (value !== email) setEmail(value)
    if (countdown > 0) return
    setState('sending')
    setError(null)
    try {
      const res = await api.otpRequest(value)
      setState('code_sent')
      setStep('otp')
      setOtpKey(k => k + 1); setCode('')
      startCountdown(res?.resendInSeconds ?? 30)
    } catch (e) {
      setState('idle')
      if (e?.code === 'rate_limited') startCountdown(60)
      setError(otpErrorMessage(e))
    }
  }

  const resend = async e => {
    e.preventDefault()
    if (countdown > 0) return
    try {
      const res = await api.otpRequest(email.trim())
      toast('New code sent')
      setOtpKey(k => k + 1); setCode('')
      startCountdown(res?.resendInSeconds ?? 30)
    } catch (err) {
      if (err?.code === 'rate_limited') startCountdown(60)
      setError(otpErrorMessage(err))
    }
  }

  const verify = async code => {
    if (code.length !== 6 || state === 'verifying') return
    setState('verifying')
    setError(null)
    try {
      await api.otpVerify(email.trim(), code)
      toast('Signed in — welcome')
      await refresh()
      navigate('/', { replace: true })
    } catch (e) {
      setState('code_sent')
      setError(otpErrorMessage(e))
      setOtpKey(k => k + 1); setCode('')
    }
  }

  return (
    <>
      <TopBar minimal />
      <main className="page-narrow">
        {/* The brand mark, drawn in the active scheme's own accent — a CSS
            mask over the glyph's alpha, so the logo is always the same colour
            family as the button below it, whatever scheme and theme the
            visitor landed with. */}
        <div className="auth-brand" aria-hidden="true">
          <span className="auth-brand-mark"></span>
        </div>

        {step === 'email' && (
          <section className="card card-pad anim-in">
            <h1 className="page-title">Sign in</h1>
            {/* Corp email leads: on a self-hosted deployment the business
                address IS the identity — the tenant, the directory, presence.
                Social sign-in still works, but as the fallback, below.
                The domain itself is named once only, in the note under the
                button, beside the field where it is actually typed — saying it
                here as well made the card repeat itself. */}
            <p className="page-sub">Use your {config.orgName || 'corp'} email to receive a sign-in code.</p>

            {error && <Banner kind="danger">{error}</Banner>}

            <div className="field">
              <input
                className="input"
                ref={emailRef}
                type="email"
                placeholder={lockedDomain ? `you@${lockedDomain}` : 'you@company.com'}
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') sendCode() }}
              />
            </div>
            <Button variant="primary" block onClick={sendCode} disabled={state === 'sending' || countdown > 0}>
              {state === 'sending' ? 'Sending…' : countdown > 0 ? `Send code (${countdown}s)` : 'Send code'}
            </Button>
            <p className="form-note">
              {lockedDomain
                ? <>Only <strong>@{lockedDomain}</strong> addresses can sign in — you can leave the domain off.</>
                : <>Only addresses on this deployment's allowed domain can sign in.</>}
            </p>

            {/* Social sign-in exists only where the deployment configured it
                (socialProviders + OAuth secrets) — a self-hosted org gets a
                page that asks for the one identity it actually manages. */}
            {config.socialProviders.length > 0 && (
              <>
            <div className="divider-label">or continue with</div>

            <div className="auth-social">
            {config.socialProviders.includes('google') && (
            <Button as="a" variant="social" block href={oidcStartUrl('google')}>
              <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.3h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.2-2 3.7-5 3.7-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.7-2.9c-1 .7-2.4 1.2-4.2 1.2-3.2 0-5.9-2.1-6.8-5.1l-3.9 3C3.3 21.3 7.3 24 12 24z"/><path fill="#FBBC05" d="M5.2 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3l-3.9-3C.5 8.2 0 10 0 12s.5 3.8 1.3 5.3l3.9-3z"/><path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.3 0 3.3 2.7 1.3 6.7l3.9 3c.9-3 3.6-5 6.8-5z"/></svg>
              Continue with Google
            </Button>
            )}
            {config.socialProviders.includes('apple') && (
            <Button as="a" variant="social" block href={oidcStartUrl('apple')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.05 12.54c0-2.4 1.96-3.55 2.05-3.6-1.12-1.64-2.86-1.86-3.48-1.89-1.48-.15-2.89.87-3.64.87-.75 0-1.9-.85-3.13-.83-1.61.02-3.1.94-3.93 2.38-1.68 2.9-.43 7.2 1.2 9.56.8 1.16 1.75 2.45 3 2.4 1.2-.05 1.66-.78 3.12-.78s1.87.78 3.14.75c1.3-.02 2.12-1.17 2.91-2.34.92-1.34 1.3-2.64 1.32-2.71-.03-.01-2.53-.97-2.56-3.81zM14.65 5.4c.66-.8 1.1-1.9 1.1-3 0-.15-.01-.3-.04-.43-1.05.04-2.32.7-3.07 1.58-.67.78-1.26 2.02-1.1 3.21 1.17.09 2.37-.6 3.11-1.36z"/></svg>
              Continue with Apple
            </Button>
            )}
            </div>
              </>
            )}
          </section>
        )}

        {step === 'otp' && (
          <section className="card card-pad anim-in">
            <h1 className="page-title">Enter 6-digit code</h1>
            <p className="page-sub page-sub-tight">Sent to <strong>{email}</strong></p>

            <OtpInput key={otpKey} onComplete={verify} onChange={setCode} disabled={state === 'verifying'} />

            {error && <Banner kind="danger">{error}</Banner>}

            <Button
              variant="primary"
              block
              disabled={state === 'verifying'}
              onClick={() => verify(code)}
            >
              {state === 'verifying' ? 'Verifying…' : 'Verify'}
            </Button>
            <p className="form-note">
              Didn't get it?{' '}
              <a href="#" onClick={resend} className={countdown > 0 ? 'link-disabled' : ''}>Resend</a>{' '}
              {countdown > 0 ? `(${countdown}s)` : ''}
            </p>
          </section>
        )}
      </main>
    </>
  )
}
