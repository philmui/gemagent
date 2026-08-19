import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function SparkIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M12 2.5c.8 5.1 4.4 8.7 9.5 9.5-5.1.8-8.7 4.4-9.5 9.5-.8-5.1-4.4-8.7-9.5-9.5C7.6 11.2 11.2 7.6 12 2.5Z" fill="currentColor" />
      <path d="M19 2.5c.2 1.5 1.1 2.4 2.5 2.5-1.4.2-2.3 1.1-2.5 2.5-.2-1.4-1.1-2.3-2.5-2.5 1.4-.1 2.3-1 2.5-2.5Z" fill="currentColor" opacity=".6" />
    </svg>
  );
}

export function OrbitIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="2.25" fill="currentColor" />
      <ellipse cx="12" cy="12" rx="9" ry="4.25" stroke="currentColor" strokeWidth="1.55" />
      <ellipse cx="12" cy="12" rx="9" ry="4.25" stroke="currentColor" strokeWidth="1.55" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="4.25" stroke="currentColor" strokeWidth="1.55" transform="rotate(120 12 12)" />
    </svg>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect x="8.25" y="2.5" width="7.5" height="12" rx="3.75" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5.5 11.5v.5a6.5 6.5 0 0 0 13 0v-.5M12 18.5v3M8.5 21.5h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M4 10v4h4l5 4V6l-5 4H4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M16 9a4.2 4.2 0 0 1 0 6M18.5 6.5a7.7 7.7 0 0 1 0 11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function MuteIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M4 10v4h4l5 4V6l-5 4H4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="m17 9 4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M5 7h14M9 7V4.5h6V7m-8 0 .75 13h8.5L17 7M10 10.5v6M14 10.5v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="m5 12.5 4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M10 14v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="16" cy="7" r="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8" cy="17" r="2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M4 5.5h16v11H9l-5 3v-14Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M8 9.5h8M8 12.5h5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="3.6" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M19.2 15.5A8.2 8.2 0 0 1 8.5 4.8 8.2 8.2 0 1 0 19.2 15.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BookIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path d="M4 5.5c2.9-.8 5.6-.2 8 1.6v11c-2.4-1.8-5.1-2.4-8-1.6v-11ZM20 5.5c-2.9-.8-5.6-.2-8 1.6v11c2.4-1.8 5.1-2.4 8-1.6v-11Z" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
