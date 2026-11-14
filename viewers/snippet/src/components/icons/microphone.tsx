import { h } from 'preact';
import { IconProps } from './types';

export const MicrophoneIcon = ({
  size = 24,
  strokeWidth = 2,
  primaryColor = 'currentColor',
  className,
  title,
}: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={primaryColor}
    stroke-width={strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
    class={className}
    role="img"
    aria-label={title}
  >
    <path stroke="none" d="M0 0h24v24H0z" fill="none" />
    <path d="M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1 -6 0z" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
    <path d="M8 21h8" />
    <path d="M12 19v2" />
  </svg>
);
