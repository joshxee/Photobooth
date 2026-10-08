import { useEffect, useRef, useState, type CSSProperties } from "react";

interface FillButtonProps {
  label: string;
  /** Called once the fill animation completes. */
  onFire: () => void;
  /** How long the pill takes to fill after being tapped. The original app used 3 s. */
  fillMs?: number;
  size?: "large" | "medium";
}

/**
 * The pill from the original design: tapping it fills it left to right with a green wash, and
 * only when the fill completes does the action fire. (A deliberate pause, not a hold.)
 */
export function FillButton({ label, onFire, fillMs = 3000, size = "medium" }: FillButtonProps) {
  const [filling, setFilling] = useState(false);
  const fire = useRef(onFire);
  fire.current = onFire;

  useEffect(() => {
    if (!filling) return;
    const timer = setTimeout(() => fire.current(), fillMs);
    return () => clearTimeout(timer);
  }, [filling, fillMs]);

  return (
    <button
      type="button"
      className={`pill pill--fill pill--${size}${filling ? " is-filling" : ""}`}
      style={{ "--fill-ms": `${fillMs}ms` } as CSSProperties}
      disabled={filling}
      onClick={() => setFilling(true)}
    >
      <span className="pill__fill" aria-hidden="true" />
      <span className="pill__dot" aria-hidden="true" />
      <span className="pill__label">{label}</span>
    </button>
  );
}
