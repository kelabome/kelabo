/**
 * The app's icon set — inline, stroked, sized in ems so an icon always matches
 * the text next to it.
 *
 * These replace the emoji that used to stand in for icons (✕ ⛶ ☾ 👥 🗎 ✦ 🐞 ⋯).
 * Emoji render from the *user's* font stack, so they changed shape, weight and
 * colour on every OS — which is most of why the UI read as inconsistent.
 *
 * Add an icon by adding one entry to PATHS. Everything is drawn on a 24×24
 * grid with `currentColor`, so an icon inherits the colour of whatever it sits
 * in and needs no per-use styling.
 */

const PATHS = {
  home: 'M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1z M9 21v-8h6v8',
  archive: 'M3 4h18v4H3zM5 8v12a1 1 0 001 1h12a1 1 0 001-1V8M10 12h4',
  sidebar: 'M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2z M9 3v18',
  menu: 'M3 6h18M3 12h18M3 18h18',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  'arrow-left': 'M19 12H5M11 18l-6-6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M18 15l-6-6-6 6',
  x: 'M18 6L6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6L9 17l-5-5',
  maximize: 'M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M3 16v3a2 2 0 002 2h3',
  minimize: 'M8 3v3a2 2 0 01-2 2H3M16 3v3a2 2 0 002 2h3M21 16h-3a2 2 0 00-2 2v3M3 16h3a2 2 0 012 2v3',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  calendar: 'M4 5h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z M3 10h18 M8 3v4 M16 3v4',
  star: 'M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3 1.1-6.5L2.6 9.8l6.5-.9z',
  phone: 'M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012 4.2 2 2 0 014 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8.1 9.6a16 16 0 006 6l1.1-1.1a2 2 0 012.1-.5c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z',
  'user-plus': 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M19 8v6M22 11h-6',
  'file-text': 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  sparkles: 'M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  palette: 'M12 3a9 9 0 000 18 2 2 0 001.6-3.2 2 2 0 011.6-3.2H18a3 3 0 003-3.1A9 9 0 0012 3z M7.5 10.5h.01M10.5 7.5h.01M14.5 7.5h.01M17 10.5h.01',
  bug: 'M8 6V4a4 4 0 018 0v2M5 10h14M6 10v5a6 6 0 0012 0v-5M12 12v8M2 13h4M18 13h4M3.5 7l2.5 2M20.5 7L18 9M3.5 19L6 17M20.5 19L18 17',
  'more-horizontal': 'M12 13a1 1 0 100-2 1 1 0 000 2M19 13a1 1 0 100-2 1 1 0 000 2M5 13a1 1 0 100-2 1 1 0 000 2',
  pencil: 'M17 3a2.8 2.8 0 014 4L7.5 20.5 2 22l1.5-5.5z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z M12 15a3 3 0 100-6 3 3 0 000 6z',
  'eye-off': 'M10.6 6.2A9.9 9.9 0 0112 6c6.4 0 10 7 10 7a17 17 0 01-3 3.9M6.3 6.3A17 17 0 002 13s3.6 7 10 7a9.8 9.8 0 005.7-1.7M3 3l18 18M9.9 10a3 3 0 004.2 4.2',
  copy: 'M20 9H11a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  link: 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  send: 'M22 2L11 13 M22 2l-7 20-4-9-9-4z',
  bell: 'M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9z M13.7 21a2 2 0 01-3.4 0',
  mail: 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2z M22 7l-10 6L2 7',
  'check-circle': 'M21 11.1V12a9 9 0 11-5.3-8.2 M21 5L12 14l-2.7-2.7',
  'x-circle': 'M12 21a9 9 0 100-18 9 9 0 000 18z M15 9l-6 6 M9 9l6 6',
  'stop-circle': 'M12 21a9 9 0 100-18 9 9 0 000 18z M9.5 9.5h5v5h-5z',
  'rotate-ccw': 'M3 3v6h6 M3.5 13a9 9 0 105-8.7L3 9',
  'book-open': 'M2 4h5a3 3 0 013 3v13a2.5 2.5 0 00-2.5-2.5H2z M22 4h-5a3 3 0 00-3 3v13a2.5 2.5 0 012.5-2.5H22z',
  // --- connection status ------------------------------------------------------
  cloud: 'M18 10h-1.3A8 8 0 109 20h9a5 5 0 000-10z',
  waveform: 'M3 11v2 M7.5 8v8 M12 4v16 M16.5 9v6 M21 11v2',
  broadcast: 'M12 14a2 2 0 100-4 2 2 0 000 4z M7.8 16.2a6 6 0 010-8.4 M16.2 7.8a6 6 0 010 8.4 M4.9 19.1a10 10 0 010-14.2 M19.1 4.9a10 10 0 010 14.2',
  // --- kelabo room ---------------------------------------------------------
  grid: 'M3 4h7v7H3z M14 4h7v7h-7z M3 13h7v7H3z M14 13h7v7h-7z',
  'layout-focus': 'M3 4h12v16H3z M17 4h4v7h-4z M17 13h4v7h-4z',
  spotlight: 'M12 8a4 4 0 100 8 4 4 0 000-8z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M4.9 4.9l1.5 1.5 M17.6 17.6l1.5 1.5 M4.9 19.1l1.5-1.5 M17.6 6.4l1.5-1.5',
  captions: 'M4 5h16a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2z M7 12h3 M14 12h3',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18z M3.6 9h16.8 M3.6 15h16.8 M12 3a14 14 0 000 18 M12 3a14 14 0 010 18',
  mic: 'M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3z M19 11a7 7 0 01-14 0 M12 18v4 M8 22h8',
  'mic-off': 'M3 3l18 18 M9 5a3 3 0 016 0v5 M15 14.5A3 3 0 019 12v-1 M19 11a7 7 0 01-9.9 6.4 M5 8.5V11a7 7 0 003.6 6.1 M12 18v4 M8 22h8',
  video: 'M3 7a2 2 0 012-2h9a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2z M16 10l5-3v10l-5-3z',
  volume: 'M11 5L6 9H2v6h4l5 4z M15.5 8.5a5 5 0 010 7 M18.5 5.5a9.5 9.5 0 010 13',
  'video-off': 'M3 3l18 18 M16 10l5-3v10l-3.5-2.1 M14.5 5H5a2 2 0 00-1.7 1 M3 8.5V17a2 2 0 002 2h9a2 2 0 001.8-1.2',
  'panel-right': 'M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2z M15 3v18',
  'message-square': 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16z M21 21l-4.35-4.35',
  code: 'M9 18l-6-6 6-6 M15 6l6 6-6 6',
  'screen-share': 'M3 5a2 2 0 012-2h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z M8 21h8 M12 16v5 M12 6.5v5 M9.5 9L12 6.5 14.5 9',
  help: 'M9.2 9a3 3 0 015.7 1c0 2-3 2.4-3 4.4 M12 18.5h.01 M12 21a9 9 0 100-18 9 9 0 000 18z',
  'minus-circle': 'M12 21a9 9 0 100-18 9 9 0 000 18z M8 12h8',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 7v5l3 2',
  terminal: 'M4 17l6-5-6-5 M12 19h8',
  pin: 'M9 3h6l-1 6 3 3v2H7v-2l3-3z M12 14v7',
  // A mention. The stroke stops short of closing the outer arc, which is what
  // reads as "@" rather than as a spiral at 12px.
  at: 'M16 12a4 4 0 10-4 4 M16 8v5a3 3 0 006 0v-1a9 9 0 10-3.5 7.1',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1v.2a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1.1-1.5 1.6 1.6 0 00-1.8.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7h-.2a2 2 0 110-4h.1a1.6 1.6 0 001.5-1.1 1.6 1.6 0 00-.4-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5v-.2a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1h.2a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
}

/**
 * `name` picks the glyph; `size` is in px (16 matches 14px body text).
 * Decorative by default — pass a `label` only when the icon is the *sole*
 * content of a control and nothing else names it.
 */
export function Icon({ name, size = 16, label, className = '', strokeWidth = 1.75, ...rest }) {
  const d = PATHS[name]
  if (!d) return null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? 'icon ' + className : 'icon'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
      {...rest}
    >
      {d.split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : 'M' + seg} />
      ))}
    </svg>
  )
}
