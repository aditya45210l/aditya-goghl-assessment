// Small inline SVG illustrations (no image files, they follow the theme colours).

export function ChatIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 140" className={className} aria-hidden="true">
      <circle cx="100" cy="70" r="62" className="fill-brand/10" />
      <rect x="38" y="34" width="86" height="44" rx="14" className="fill-card stroke-border" strokeWidth="1.5" />
      <rect x="50" y="48" width="52" height="6" rx="3" className="fill-muted-foreground/30" />
      <rect x="50" y="60" width="34" height="6" rx="3" className="fill-muted-foreground/20" />
      <path d="M52 78 l-8 14 l18 -14z" className="fill-card" />
      <rect x="84" y="70" width="80" height="40" rx="14" className="fill-brand" />
      <rect x="96" y="83" width="48" height="6" rx="3" fill="white" opacity="0.85" />
      <rect x="96" y="94" width="30" height="6" rx="3" fill="white" opacity="0.6" />
      <path d="M150 110 l10 12 l-2 -12z" className="fill-brand" />
      <circle cx="160" cy="40" r="6" className="fill-emerald-400" />
      <circle cx="40" cy="104" r="4" className="fill-amber-400" />
    </svg>
  );
}

export function TeamIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 220 160" className={className} aria-hidden="true">
      <circle cx="110" cy="80" r="70" fill="white" opacity="0.08" />
      {[
        { x: 60, y: 70, c: '#60a5fa' },
        { x: 110, y: 52, c: '#f472b6' },
        { x: 160, y: 70, c: '#34d399' },
      ].map((p) => (
        <g key={p.x}>
          <circle cx={p.x} cy={p.y} r="16" fill={p.c} />
          <path d={`M${p.x - 24} ${p.y + 46} a24 22 0 0 1 48 0z`} fill={p.c} opacity="0.85" />
        </g>
      ))}
      <rect x="70" y="122" width="80" height="18" rx="9" fill="white" opacity="0.9" />
      <rect x="80" y="129" width="44" height="4" rx="2" fill="#2563eb" />
    </svg>
  );
}
