// `style` is honoured, not dropped. App.jsx sizes three of these inline for
// the pre-auth shell and every one of those dimensions was silently ignored.
export function Skeleton({ className = '', style }) {
  return <div className={'skel ' + className} style={style} aria-hidden="true"></div>
}

// `rows` is accepted as well as `n`: every call site in the app passed `rows`,
// which this signature ignored, so a "2 rows" and a "4 rows" placeholder both
// rendered 3.
export function SkeletonRows({ n, rows, count = n ?? rows ?? 3 }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div className="row" key={i}>
          <Skeleton className="skel-dot" />
          <div className="row-main">
            <Skeleton className="skel-title" />
            <Skeleton className="skel-text" />
          </div>
        </div>
      ))}
    </div>
  )
}
