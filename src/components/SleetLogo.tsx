import { useId } from "react";

/** Sleet's icon (the same artwork as app-icon.svg): slanted streaks of sleet on a dark tile. */
export function SleetLogo({ size = 24, className }: { size?: number; className?: string }) {
  // Gradient ids must be unique on the page (the logo can appear more than once).
  const id = useId().replace(/:/g, "");
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1b2030" />
          <stop offset="1" stopColor="#0d1018" />
        </linearGradient>
        <linearGradient id={`${id}-ice`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7fb8ff" />
          <stop offset="1" stopColor="#e6f4ff" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="128" fill={`url(#${id}-tile)`} />
      <g fill="none" stroke={`url(#${id}-ice)`} strokeLinecap="round" strokeWidth="30">
        <path d="M178 104 L126 268" />
        <path d="M262 156 L194 372" />
        <path d="M340 110 L300 236" />
        <path d="M404 210 L352 374" />
        <path d="M292 312 L268 388" />
      </g>
    </svg>
  );
}
