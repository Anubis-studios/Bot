/** Empty-state vignettes in the rail glyphs' duotone: 1.6 strokes over 22 % fills. */
import type { ComponentProps } from "react";

const Frame = (props: ComponentProps<"svg">) => (
  <svg
    aria-hidden="true"
    width="160"
    height="112"
    viewBox="0 0 160 112"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="text-muted-foreground"
    {...props}
  />
);

const DAYS = [32, 50, 68, 86].flatMap((x) =>
  [44, 60, 76].map((y) => ({ x, y }))
);

export const RoutinesIllustration = () => (
  <Frame>
    <rect
      x="20"
      y="14"
      width="96"
      height="84"
      rx="10"
      className="fill-background"
    />
    <path d="M20 34h96 M44 8v12 M92 8v12" />
    {DAYS.map(({ x, y }) => (
      <rect
        key={`${x}-${y}`}
        x={x}
        y={y}
        width="10"
        height="10"
        rx="3"
        fill="currentColor"
        {...(x === 50
          ? { fillOpacity: 0.22 }
          : { stroke: "none", opacity: 0.12 })}
      />
    ))}
    <circle cx="118" cy="78" r="24" className="fill-background" stroke="none" />
    <circle
      cx="118"
      cy="78"
      r="24"
      fill="currentColor"
      stroke="none"
      opacity="0.22"
    />
    <path d="M142 78a24 24 0 1 1-6.9-17.1 M142 54v10.5h-10.5 M118 64.5V78l7.5 6" />
  </Frame>
);

export const ArtifactsIllustration = () => (
  <Frame>
    <rect
      x="34"
      y="18"
      width="72"
      height="86"
      rx="8"
      transform="rotate(-8 70 61)"
      className="fill-background"
    />
    <rect
      x="54"
      y="14"
      width="72"
      height="86"
      rx="8"
      transform="rotate(7 90 57)"
      className="fill-background"
    />
    <rect
      x="44"
      y="20"
      width="72"
      height="86"
      rx="8"
      className="fill-background"
    />
    <rect
      x="52"
      y="28"
      width="56"
      height="34"
      rx="4"
      fill="currentColor"
      fillOpacity="0.22"
    />
    <circle cx="97" cy="38" r="4" />
    <path d="M56 58l12-11 9 8 7-5 14 10 M52 74h40 M52 82h52 M52 90h28" />
  </Frame>
);
