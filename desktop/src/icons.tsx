// Small rounded line icons for the navigation, drawn on a 24-unit grid and
// coloured by currentColor. Decorative: the label next to each one names it.
const PATHS = {
  send: <path d="M5 12h14M13 6l6 6-6 6" />,
  bell: <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />,
  plus: <path d="M12 5v14M5 12h14" />,
  today: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  assistant: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  awareness: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  pet: (
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
  ),
  chat: <path d="M5.5 17.5 4 21l4.2-1.9A8.5 8.5 0 1 0 5.5 17.5z" />,
  projects: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="4" />
      <path d="M8 3v4M16 3v4M4 10h16" />
    </>
  ),
  handoff: <path d="M7 7.5h11l-3-3M17 16.5H6l3 3" />,
  memory: (
    <path d="m12 3.5 2.4 5.1 5.6.6-4.2 3.8 1.2 5.5L12 15.7l-5 2.8 1.2-5.5L4 9.2l5.6-.6z" />
  ),
  reports: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="4" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  trash: <path d="M4.5 7h15M10 4h4M6.5 7l1 13h9l1-13M10 11v5M14 11v5" />,
  attach: (
    <path d="m20 11.5-7.6 7.6a5 5 0 0 1-7.1-7.1l7.9-7.9a3.4 3.4 0 0 1 4.8 4.8L10.2 16.7a1.7 1.7 0 0 1-2.4-2.4L15 7.1" />
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
