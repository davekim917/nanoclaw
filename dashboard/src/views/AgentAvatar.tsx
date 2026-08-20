import { faceSrc, type OfficeState } from './office-data.js';

/**
 * An agent's face, wherever one is drawn — fleet row, room card, floor plan.
 *
 * One component on purpose: the fallback rule is the load-bearing part, and an
 * agent that has no avatar must look the same everywhere rather than being a
 * bust in one place and a letter in another. Nothing here invents an image: the
 * only `src` it will ever emit is one `faceSrc` has already validated as a
 * plain https/data image URL.
 */
export function AgentAvatar({
  name,
  avatarUrl,
  status,
  size = 36,
  initials,
}: {
  name: string;
  avatarUrl?: string | null | undefined;
  /** Absent means "do not draw a state dot" — a face on its own. */
  status?: OfficeState | undefined;
  size?: number;
  /**
   * Override the monogram. The default is one letter, which is right at 36px
   * in a floor plan and ambiguous in a 25px stack, where every agent sharing a
   * first letter collapses to one glyph. Callers may pass two — the FALLBACK
   * RULE (real face, else a monogram on the neutral mark) still lives only
   * here, which is the part that must not fork.
   */
  initials?: string;
}) {
  const src = faceSrc(avatarUrl);
  return (
    <span className="tm-avatar" style={{ width: size, height: size }}>
      {src ? (
        <img className="tm-avatar-face" src={src} alt="" width={size} height={size} />
      ) : (
        <span className="tm-avatar-face tm-avatar-mark" data-fallback="true" aria-hidden="true">
          {initials?.trim() || name.trim().charAt(0).toUpperCase() || '·'}
        </span>
      )}
      {status && <i className={`tm-avatar-dot ${status}`} data-status={status} />}
    </span>
  );
}
