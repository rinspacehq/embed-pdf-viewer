import { h } from "preact";
import { IconProps } from "./types";

export const PlayerPlayIcon = ({
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
    <path d="M8.5 6.35v11.3L18 12 8.5 6.35Z" fill={primaryColor} />
  </svg>
);
