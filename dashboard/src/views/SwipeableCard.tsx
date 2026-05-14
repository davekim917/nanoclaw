import { useRef, useState, type ReactNode, type TouchEvent, type KeyboardEvent, type CSSProperties } from 'react';

/**
 * Mobile swipe-to-archive wrapper for inbox / board cards.
 *
 * On desktop the dismiss `×` is a hover-revealed button in the card head
 * (`.nc-card-dismiss`); on mobile there's no hover, so the button stays
 * at opacity 0 and tapping anywhere goes to the detail view instead.
 * SwipeableCard fixes that without forcing a tiny tap target: a left swipe
 * past {@link SWIPE_THRESHOLD_PX} reveals a red "dismiss" zone behind the
 * card and, on release, fires the archive callback. Right swipes are
 * ignored. Below threshold, the card snaps back.
 *
 * Tap behavior is preserved — if the gesture moved less than
 * {@link TAP_THRESHOLD_PX} we treat it as a tap and forward `onClick`.
 * Swipes set a ref that short-circuits the synthetic click event React
 * fires at the end of a touch sequence.
 *
 * Desktop is unaffected: mouse interactions never trip the touch
 * handlers, the card just renders + click forwards as before.
 */

interface Props {
  children: ReactNode;
  /** False when the card isn't archivable (already archived, running task, etc.). */
  enabled: boolean;
  onArchive: () => void;
  onClick?: () => void;
  className?: string;
  role?: string;
  tabIndex?: number;
  onKeyDown?: (e: KeyboardEvent) => void;
  'data-session-id'?: string;
  'data-task-id'?: string;
}

const SWIPE_THRESHOLD_PX = 80;
const SWIPE_CAP_PX = 200;
const TAP_THRESHOLD_PX = 10;

export function SwipeableCard({ children, enabled, onArchive, onClick, className, onKeyDown, ...passthrough }: Props) {
  const [deltaX, setDeltaX] = useState(0);
  const [animating, setAnimating] = useState(true);
  const touchStartX = useRef<number | null>(null);
  const movedRef = useRef(false);

  const handleTouchStart = (e: TouchEvent) => {
    if (!enabled || !e.touches[0]) return;
    touchStartX.current = e.touches[0].clientX;
    movedRef.current = false;
    setAnimating(false);
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (touchStartX.current === null || !e.touches[0]) return;
    const dx = e.touches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > TAP_THRESHOLD_PX) movedRef.current = true;
    // Only react to leftward gestures — right swipes are not bound to
    // any action and would otherwise feel rubber-bandy.
    setDeltaX(dx < 0 ? Math.max(dx, -SWIPE_CAP_PX) : 0);
  };

  const handleTouchEnd = () => {
    if (touchStartX.current === null) return;
    touchStartX.current = null;
    setAnimating(true);
    if (deltaX < -SWIPE_THRESHOLD_PX) {
      // Slide off-screen then fire the callback. The 200ms matches the
      // CSS transition so the operator sees the card leave before the
      // SWR refetch hides it on the next render.
      setDeltaX(-window.innerWidth);
      window.setTimeout(() => onArchive(), 200);
    } else {
      setDeltaX(0);
    }
  };

  const handleClick = () => {
    // After a swipe React still fires a synthetic click on touchend; the
    // `movedRef` guard suppresses navigating into the detail view.
    if (movedRef.current) return;
    onClick?.();
  };

  const cardStyle: CSSProperties = {
    transform: `translateX(${deltaX}px)`,
    transition: animating ? 'transform 0.2s ease' : 'none',
  };
  const revealOpacity = enabled ? Math.min(Math.abs(deltaX) / SWIPE_THRESHOLD_PX, 1) : 0;

  return (
    <div className="nc-swipeable">
      <div className="nc-swipe-reveal" style={{ opacity: revealOpacity }} aria-hidden="true">
        <span>× dismiss</span>
      </div>
      <div
        className={className}
        style={cardStyle}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onClick={handleClick}
        {...(onKeyDown ? { onKeyDown } : {})}
        {...passthrough}
      >
        {children}
      </div>
    </div>
  );
}
