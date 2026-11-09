export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="6" className="fill-foreground" />
      <path d="M8 5.5v13M16 5.5v13" className="stroke-background" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M6 9h12M6 12h12M6 15h12" className="stroke-background" strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
    </svg>
  )
}
