// The variant seam (overlay point).
//
// Default builds resolve `@kelabo/variant` to this file, so the app you can
// read is the app you get. An overlay build can alias `@kelabo/variant` to its
// own module with the same exports, swapping pages or adding routes at build
// time — the direction of dependency never reverses: nothing in this repo
// knows an overlay exists.
//
// Exports:
//   Login       — the sign-in page component.
//   extraRoutes — [{ path, element }] appended inside <Routes> (empty here).
//   JourneyHelmExtra — a section rendered at the foot of a journey's Helm tab,
//                 or null. Null here, and deliberately: what a journey's AI
//                 costs is a question only a deployment that bills for it can
//                 answer, and a self-host build runs on its own LLM key and
//                 has nothing to say. The seam exists so that build does not
//                 have to fork JourneyDetail.jsx to add a panel to it.
export { default as Login } from './routes/Login'
export const extraRoutes = []
export const JourneyHelmExtra = null
