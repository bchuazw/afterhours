export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="10" stroke="#8ea6ff" strokeWidth="1.6" />
        <path d="M12 6v6l4 2" stroke="#8ea6ff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3.5 15.5a10 10 0 0 0 17 0" stroke="#5b7cff" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">
        After<span className="text-accent">Hours</span>
      </span>
    </span>
  );
}
