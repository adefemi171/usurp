/**
 * A board avatar.
 *
 * `#8` notes that GitHub OAuth "gives a free identity/avatar", and we have
 * been storing `avatar_url` since M1 without ever rendering it.
 *
 * An anonymous member gets a generated monogram from their pseudonym, never
 * their real image — an avatar is usually the *same* picture a person uses
 * everywhere, which makes it more identifying than a handle, not less.
 *
 * Plain `<img>` rather than `next/image`: these are third-party URLs
 * (avatars.githubusercontent.com, lh3.googleusercontent.com) and routing them
 * through the optimizer would mean either allow-listing remote hosts or
 * proxying every avatar through our own server for no benefit.
 */

/** Deterministic hue from a string, so a pseudonym keeps its colour. */
function hue(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619) >>> 0;
  }
  return hash % 360;
}

function initials(name: string): string {
  const words = name.replace(/^Anonymous\s+/i, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export default function Avatar({
  url,
  name,
  size = 28,
}: {
  url: string | null;
  /** Handle or pseudonym — whichever is being displayed. */
  name: string;
  size?: number;
}) {
  if (url) {
    return (
      <img
        className="avatar"
        src={url}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        // A dead avatar host should not leave a broken-image glyph on the board.
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <span
      className="avatar monogram"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `hsl(${hue(name)} 30% 22%)`,
        color: `hsl(${hue(name)} 55% 72%)`,
      }}
    >
      {initials(name)}
    </span>
  );
}
