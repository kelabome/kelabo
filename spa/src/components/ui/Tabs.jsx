/**
 * A tab strip. The caller renders the panel; this only says which one is on.
 *
 * `badge` is a count rendered beside the label — the middle rung of the
 * journey's unread cascade (docs 20 §19.3), where the number has to be
 * visible while you are on a *different* tab of the same page. `mention`
 * picks the louder styling for the same slot, because "somebody wants you"
 * and "there is something here" are different messages.
 */
export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(t => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          className={active === t.id ? 'active' : ''}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge > 0 && (
            <span
              className={'leg-badge' + (t.mention ? ' leg-badge-mention' : '')}
              // The label alone reads as "Legs 3" to a screen reader, which
              // is not what the number means.
              aria-label={`${t.badge} unread`}
            >
              {t.mention ? `@${t.badge}` : t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
