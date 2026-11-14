import { h } from "preact";
import { IconProps } from "./types";

export const PlayerStopIcon = ({
  size = 24,
  primaryColor = "currentColor",
  className,
  title,
}: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    class={className}
    role="img"
    aria-label={title}
  >
    <rect x="7.5" y="7.5" width="9" height="9" rx="1.5" fill={primaryColor} />
  </svg>
);
