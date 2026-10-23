// The knockbox mark (from the knockbox.nz favicon) and the gallery's stroke icons (24 grid).

export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg className="mark" width={(size * 56) / 40} height={size} viewBox="4 14 56 40" aria-hidden="true">
      <path d="M4 18Q4 14 8 14H14Q18 14 18 18V27A14 14 0 0 0 46 27Q46 23 50 23H56Q60 23 60 27V34Q60 54 40 54H24Q4 54 4 34Z" />
      <circle cx="32" cy="27" r="10" />
    </svg>
  );
}

const ICONS = {
  back: "M15 18l-6-6 6-6",
  next: "M9 6l6 6-6 6",
  up: "M12 19V5M5 12l7-7 7 7",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  share: "M12 15V4M7 9l5-5 5 5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5",
} as const;

export function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}
