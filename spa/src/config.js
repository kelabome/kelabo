const configuredApi = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'
const configuredPortal = import.meta.env.VITE_PORTAL_URL || 'http://localhost:5173'

/**
 * Where this copy of the app talks to the API.
 *
 * Every host we serve the bundle from proxies the control plane at `/api` on
 * that same host — the portal and any alias it also answers on. So the answer
 * is "wherever I am", and the build-time value is used only when the app is
 * served from somewhere that does not proxy: a local dev server, which is
 * exactly the case the fallback covers.
 *
 * Reaching back to the portal host instead would be cross-origin (CORS with
 * credentials) *and* would arrive without the CloudFront origin secret, which
 * an environment configured to require one refuses outright.
 */
function apiBaseFor() {
  if (typeof location === 'undefined' || !configuredApi.endsWith('/api')) return configuredApi
  try {
    return location.origin === new URL(configuredPortal).origin ? configuredApi : `${location.origin}/api`
  } catch {
    return configuredApi
  }
}

export const config = {
  apiBase: apiBaseFor(),
  gatewayBase: import.meta.env.VITE_GATEWAY_BASE_URL || 'http://localhost:3001',
  portalUrl: configuredPortal,
  env: import.meta.env.VITE_ENV || 'dev',
  // Which social sign-in buttons the deployment offers. Empty — the
  // self-hosting default — renders none: work email is the identity there.
  socialProviders: (import.meta.env.VITE_SOCIAL_PROVIDERS || '').split(',').filter(Boolean),
  // The one email domain this deployment admits, baked in at build time from
  // config.allowedEmailDomain. The server is the authority (rest-api/src/otp.js);
  // the browser knows it only so the sign-in page can name it and stop asking
  // people to type what is already fixed. Empty = open registration.
  allowedEmailDomain: import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN || '',
  // What this deployment calls itself, for the sign-in sentence and the tab
  // title. Cosmetic only: it never decides who may sign in — allowedEmailDomain
  // does, and the server is the authority on that. Empty = generic wording.
  orgName: (import.meta.env.VITE_ORG_NAME || '').trim(),
}
