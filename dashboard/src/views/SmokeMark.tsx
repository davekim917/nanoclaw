/**
 * The room-card and overflow-list form of the floor plan's smoke vignette.
 *
 * Same fact, same class, smaller drawing. It reuses `.tm-smoke-wisp` on purpose:
 * the reduced-motion rule lives on that one selector, so a phone honours the
 * preference without this component knowing the preference exists — and the
 * live/static behaviour can never drift between the two presentations.
 *
 * A phone is the operator's primary device and the room strip is the ONLY floor
 * it gets, so a signal that only drew on the desktop plan was a signal they
 * could not see.
 */
export function SmokeMark() {
  return (
    <span className="tm-smokemark" data-vignette="smoke" title="a run is live in this room">
      <svg viewBox="0 0 20 26" width="16" height="21" aria-hidden="true" focusable="false">
        <rect x="5" y="18" width="10" height="7" className="tm-vignette-body" />
        <path className="tm-smoke-wisp" d="M8,18 C6,13 11,10 8.5,5" />
        <path className="tm-smoke-wisp" d="M11,18 C13,12 8,9 11.5,3" />
        <path className="tm-smoke-wisp" d="M9.5,18 C8,15 11,13 9.5,10" />
      </svg>
      <span className="tm-sr-only">live run</span>
    </span>
  );
}
