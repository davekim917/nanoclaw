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
}: {
  name: string;
  avatarUrl?: string | null | undefined;
  /** Absent means "do not draw a state dot" — a face on its own. */
  status?: OfficeState | undefined;
  size?: number;
}) {
  const src = faceSrc(avatarUrl);
  return (
    <span className="tm-avatar" style={{ width: size, height: size }}>
      {src ? (
        <img className="tm-avatar-face" src={src} alt="" width={size} height={size} />
      ) : (
        <span className="tm-avatar-face tm-avatar-mark" data-fallback="true" aria-hidden="true">
          {name.trim().charAt(0).toUpperCase() || '·'}
        </span>
      )}
      {status && <i className={`tm-avatar-dot ${status}`} data-status={status} />}
    </span>
  );
}
