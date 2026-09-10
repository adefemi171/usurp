import { TITLES, type BoardTitle } from "@usurp/db";

/** Small vector emblems: consistent across platforms, with text as the label. */
export function TitleIcon({ title }: { title: BoardTitle }) {
  return (
    <svg
      className="title-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-emblem={title}
    >
      {title === "sovereign" ? (
        <>
          <path d="m3 6 5 5 4-8 4 8 5-5-2 12H5L3 6Z" />
          <path d="M7 22h10" />
        </>
      ) : title === "usurper" ? (
        <>
          <path d="m17 3-3 19M17 4C10 0 4 3 2 10c4-4 9-5 14-3" />
          <path d="m11 15-3-4-3 4-1 6h8l-1-6Z" />
          <path d="M7 16h2" />
        </>
      ) : (
        <path d="m12 3 7 9-7 9-7-9 7-9Z" />
      )}
    </svg>
  );
}

export default function TitleBadge({
  title,
}: {
  title: BoardTitle | undefined;
}) {
  if (!title) return null;
  const copy = TITLES[title];
  return (
    <span className={`title-badge ${title}`} title={copy.blurb}>
      <TitleIcon title={title} />
      {copy.label}
    </span>
  );
}
