import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>
const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export const Arrow = (p: P) => (
  <svg {...base} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
)
export const Play = (p: P) => (
  <svg {...base} {...p}><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" /></svg>
)
export const Book = (p: P) => (
  <svg {...base} {...p}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5V5.5M8 7h8M8 11h6" /></svg>
)
export const Users = (p: P) => (
  <svg {...base} {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><circle cx="17" cy="9" r="2.5" /><path d="M16 15.5a5 5 0 0 1 5.5 4.5" /></svg>
)
export const Shield = (p: P) => (
  <svg {...base} {...p}><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z" /><path d="M9 12l2 2 4-4" /></svg>
)
export const Pulse = (p: P) => (
  <svg {...base} {...p}><path d="M3 12h4l2.5-6 4 12 2.5-6H21" /></svg>
)
export const Radar = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 3v9l6 4" /></svg>
)
export const Doc = (p: P) => (
  <svg {...base} {...p}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></svg>
)
export const Eye = (p: P) => (
  <svg {...base} {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></svg>
)
export const Scale = (p: P) => (
  <svg {...base} {...p}><path d="M12 3v18M5 21h14M3 8h18" /><path d="M6 8l-3 7a3 3 0 0 0 6 0zM18 8l-3 7a3 3 0 0 0 6 0z" /></svg>
)
export const Gauge = (p: P) => (
  <svg {...base} {...p}><path d="M4 16a8 8 0 1 1 16 0" /><path d="M12 16l4-5" /><circle cx="12" cy="16" r="1.4" fill="currentColor" /></svg>
)
export const Chat = (p: P) => (
  <svg {...base} {...p}><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12h5" /></svg>
)
export const Check = (p: P) => (
  <svg {...base} {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
)
export const Copy = (p: P) => (
  <svg {...base} {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
)
export const Sound = (p: P) => (
  <svg {...base} {...p}><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></svg>
)
export const Mute = (p: P) => (
  <svg {...base} {...p}><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M17 9l4 6M21 9l-4 6" /></svg>
)
export const Instagram = (p: P) => (
  <svg {...base} {...p}><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none" /></svg>
)
export const Discord = (p: P) => (
  <svg {...base} {...p}><path d="M8.5 5.5c2.3-.7 4.7-.7 7 0l.8 1.8c2 .5 3.2 1.4 3.7 2.2.8 3.2.8 6-.3 8.7-1.4 1-2.9 1.6-4.3 1.9l-.9-1.8c-1.6.4-3.4.4-5 0l-.9 1.8c-1.4-.3-2.9-.9-4.3-1.9-1.1-2.7-1.1-5.5-.3-8.7.5-.8 1.7-1.7 3.7-2.2z" /><circle cx="9.5" cy="12.5" r="1.2" fill="currentColor" stroke="none" /><circle cx="14.5" cy="12.5" r="1.2" fill="currentColor" stroke="none" /></svg>
)
export const Logo = (p: P) => (
  <svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true" {...p}>
    <defs>
      <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#3fd8c7" />
        <stop offset=".55" stopColor="#4f8dff" />
        <stop offset="1" stopColor="#b48cff" />
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="16" fill="#071020" />
    <rect x="1.5" y="1.5" width="61" height="61" rx="15" fill="none" stroke="url(#logo-g)" strokeWidth="2" />
    <path d="M13 42 L24 29 L32 35 L51 18" fill="none" stroke="url(#logo-g)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="51" cy="18" r="5" fill="#3fd8c7" />
  </svg>
)
