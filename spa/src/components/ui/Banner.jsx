import { Icon } from './Icon'

/**
 * A standing message in the room.
 *
 * Most banners describe a *condition* — the camera is blocked, the room is full
 * — and disappear on their own when the condition lifts, so there is nothing to
 * close. `onClose` is for the other kind: a statement of fact that is true from
 * the moment it arrives and never becomes false, like the length a call has
 * been given. Those have to be dismissed by the person who read them, because
 * nothing else will ever dismiss them, and a toast that vanished in two seconds
 * is not "being told".
 */
export function Banner({ kind = 'warn', children, style, onClose, closeLabel = 'Dismiss' }) {
  return (
    <div className={`banner banner-${kind}${onClose ? ' banner-closable' : ''}`} role="alert" style={style}>
      <div className="banner-body">{children}</div>
      {onClose && (
        <button type="button" className="banner-close" onClick={onClose} title={closeLabel} aria-label={closeLabel}>
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  )
}
