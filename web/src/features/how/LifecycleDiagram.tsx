/** Static SVG of the position lifecycle: buy -> weekend freeze -> first print -> settle -> claim. */
export function LifecycleDiagram() {
  const steps = [
    { x: 60, title: "Buy", sub: "Fri, market open", detail: "premium in, collateral locked" },
    { x: 260, title: "Feed frozen", sub: "Fri 20:00 → Sun 22:00 UTC", detail: "token trades, feed does not" },
    { x: 460, title: "First print", sub: "at / after expiry", detail: "settle(id) by anyone" },
    { x: 660, title: "Claim", sub: "cash-settled", detail: "max(strike − print, 0) × units" },
  ];
  return (
    <svg viewBox="0 0 720 210" className="w-full" role="img" aria-label="AfterHours position lifecycle">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#5c6275" />
        </marker>
      </defs>
      {/* closed-market band */}
      <rect x="180" y="20" width="200" height="170" fill="#fbbf24" fillOpacity="0.07" stroke="#fbbf24" strokeOpacity="0.25" strokeDasharray="3 3" />
      <text x="280" y="36" textAnchor="middle" fontSize="10" fill="#fbbf24" fillOpacity="0.9" fontFamily="var(--font-mono)">
        closed market · surcharge applies
      </text>

      {/* price path: flat during the weekend, gap down at first print */}
      <path d="M40,120 L120,112 L180,118 L380,118 L392,150 L470,146 L560,152 L700,140" fill="none" stroke="#8ea6ff" strokeWidth="1.6" />
      <line x1="40" y1="134" x2="700" y2="134" stroke="#34d399" strokeDasharray="4 4" strokeWidth="1" />
      <text x="44" y="131" fontSize="9" fill="#34d399" fontFamily="var(--font-mono)">strike</text>
      <path d="M392,134 L392,150" stroke="#fb7185" strokeWidth="2" />
      <text x="398" y="164" fontSize="9" fill="#fb7185" fontFamily="var(--font-mono)">gap → payout</text>

      {/* timeline */}
      <line x1="40" y1="80" x2="700" y2="80" stroke="#2c3142" strokeWidth="1.2" markerEnd="url(#arrow)" />
      {steps.map((s) => (
        <g key={s.title}>
          <circle cx={s.x} cy="80" r="6" fill="#101218" stroke="#8ea6ff" strokeWidth="1.6" />
          <text x={s.x} y="58" textAnchor="middle" fontSize="12" fontWeight="600" fill="#e8eaf0">
            {s.title}
          </text>
          <text x={s.x} y="70" textAnchor="middle" fontSize="9" fill="#8b91a3" fontFamily="var(--font-mono)">
            {s.sub}
          </text>
          <text x={s.x} y="196" textAnchor="middle" fontSize="9.5" fill="#8b91a3">
            {s.detail}
          </text>
        </g>
      ))}
    </svg>
  );
}
