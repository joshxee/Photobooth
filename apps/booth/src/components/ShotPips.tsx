interface ShotPipsProps {
  total: number;
  /** 1-based shot in progress; shots before it show as done. 0 means none started. */
  current: number;
  variant: "attract" | "countdown";
}

export function ShotPips({ total, current, variant }: ShotPipsProps) {
  return (
    <div className={`pips pips--${variant}`} aria-hidden="true">
      {Array.from({ length: total }, (_, i) => {
        const shot = i + 1;
        const state = shot < current ? "done" : shot === current ? "current" : "todo";
        return <span key={shot} className={`pips__pip pips__pip--${state}`} />;
      })}
    </div>
  );
}
