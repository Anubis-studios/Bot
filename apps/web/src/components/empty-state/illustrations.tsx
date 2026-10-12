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
