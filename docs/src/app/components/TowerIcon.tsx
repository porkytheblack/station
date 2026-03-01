export function TowerIcon({ size = 80, className }: { size?: number; className?: string }) {
  const s = { stroke: "var(--rust)" };

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Spine */}
      <line x1="50" y1="5" x2="50" y2="95" style={s} strokeWidth="2.5" />

      {/* Antenna tip */}
      <line x1="50" y1="5" x2="50" y2="1" style={s} strokeWidth="1.5" />
      <circle cx="50" cy="5" r="1.8" style={{ fill: "var(--rust)" }} />

      {/* Section 1: top narrow */}
      <line x1="39" y1="25" x2="50" y2="5" style={s} strokeWidth="1.5" />
      <line x1="61" y1="25" x2="50" y2="5" style={s} strokeWidth="1.5" />
      <line x1="39" y1="25" x2="61" y2="25" style={s} strokeWidth="1" />
      <line x1="39" y1="25" x2="50" y2="15" style={s} strokeWidth="0.7" opacity="0.5" />
      <line x1="61" y1="25" x2="50" y2="15" style={s} strokeWidth="0.7" opacity="0.5" />

      {/* Section 2 */}
      <line x1="27" y1="50" x2="39" y2="25" style={s} strokeWidth="1.8" />
      <line x1="73" y1="50" x2="61" y2="25" style={s} strokeWidth="1.8" />
      <line x1="27" y1="50" x2="73" y2="50" style={s} strokeWidth="1.2" />
      <line x1="27" y1="50" x2="61" y2="25" style={s} strokeWidth="0.7" opacity="0.4" />
      <line x1="73" y1="50" x2="39" y2="25" style={s} strokeWidth="0.7" opacity="0.4" />
      <line x1="32" y1="37" x2="68" y2="37" style={s} strokeWidth="0.6" opacity="0.4" />

      {/* Section 3: platform */}
      <line x1="18" y1="70" x2="27" y2="50" style={s} strokeWidth="2" />
      <line x1="82" y1="70" x2="73" y2="50" style={s} strokeWidth="2" />
      <line x1="16" y1="70" x2="84" y2="70" style={s} strokeWidth="1.8" />
      <rect x="16" y="69" width="68" height="2.5" style={{ fill: "var(--rust)" }} opacity="0.25" />
      <line x1="18" y1="70" x2="73" y2="50" style={s} strokeWidth="0.7" opacity="0.4" />
      <line x1="82" y1="70" x2="27" y2="50" style={s} strokeWidth="0.7" opacity="0.4" />
      <line x1="22" y1="60" x2="78" y2="60" style={s} strokeWidth="0.6" opacity="0.35" />

      {/* Section 4: base wide */}
      <line x1="10" y1="88" x2="18" y2="70" style={s} strokeWidth="2.2" />
      <line x1="90" y1="88" x2="82" y2="70" style={s} strokeWidth="2.2" />
      <line x1="8" y1="88" x2="92" y2="88" style={s} strokeWidth="1.5" />
      <line x1="10" y1="88" x2="82" y2="70" style={s} strokeWidth="0.9" opacity="0.35" />
      <line x1="90" y1="88" x2="18" y2="70" style={s} strokeWidth="0.9" opacity="0.35" />
      <line x1="13" y1="79" x2="87" y2="79" style={s} strokeWidth="0.6" opacity="0.4" />
      <path d="M50 72 L55 79 L50 86 L45 79 Z" style={{ stroke: "var(--rust)" }} strokeWidth="0.7" fill="none" opacity="0.3" />

      {/* Concrete base */}
      <rect x="43" y="88" width="14" height="5" style={{ fill: "var(--rust)" }} opacity="0.4" />
      <rect x="44" y="93" width="12" height="3" style={{ fill: "var(--rust)" }} opacity="0.25" />
    </svg>
  );
}

export function TowerIllustration({ className }: { className?: string }) {
  const sr = { stroke: "var(--rust)" };
  const sp = { stroke: "var(--patina)" };
  const sw = { stroke: "var(--wire)" };

  return (
    <svg
      viewBox="0 0 340 520"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ opacity: 0.85, width: "100%", maxWidth: 340, height: "auto" }}
    >
      {/* Signal rings from antenna tip */}
      <circle
        cx="170"
        cy="30"
        r="0"
        style={{ stroke: "var(--signal-green)" }}
        strokeWidth="1"
        fill="none"
        className="signal-ring"
      />
      <circle
        cx="170"
        cy="30"
        r="0"
        style={{ stroke: "var(--signal-green)" }}
        strokeWidth="1"
        fill="none"
        className="signal-ring"
      />
      <circle
        cx="170"
        cy="30"
        r="0"
        style={{ stroke: "var(--signal-green)" }}
        strokeWidth="1"
        fill="none"
        className="signal-ring"
      />

      {/* Tower spine */}
      <line x1="170" y1="20" x2="170" y2="490" style={sr} strokeWidth="3" />

      {/* Tower top antenna */}
      <line x1="170" y1="20" x2="170" y2="0" style={sr} strokeWidth="2" />
      <circle cx="170" cy="20" r="4" style={{ fill: "var(--rust)" }} />

      {/* Flight path trace */}
      <path
        d="M 330 10 Q 310 15 285 25 Q 270 31 260 38"
        style={sw}
        strokeWidth="0.7"
        fill="none"
        strokeDasharray="3 5"
        opacity="0.25"
      />

      {/* Seagull approaching from top right, banking left */}
      <g>
        {/* Body */}
        <ellipse cx="260" cy="38" rx="9" ry="3.5" style={{ fill: "var(--wire)" }} transform="rotate(-8, 260, 38)" />
        {/* Head */}
        <ellipse cx="252" cy="36" rx="4.5" ry="3.5" style={{ fill: "var(--wire)" }} transform="rotate(-8, 252, 36)" />
        {/* Beak pointing toward tower tip */}
        <path d="M248 37 L243 39.5 L247 40" style={{ fill: "var(--rust)" }} stroke="none" />
        {/* Left wing (near wing, angled down in banking descent) */}
        <path d="M258 36 Q248 26 236 30 Q244 34 252 35" style={{ fill: "var(--wire)" }} stroke="none" />
        {/* Right wing (far wing, angled up) */}
        <path d="M262 37 Q276 28 294 22 Q282 30 270 36" fill="#4A4A4C" stroke="none" />
        {/* Wing highlight edges */}
        <path d="M258 36 Q248 26 236 30" stroke="#5A5A5E" strokeWidth="0.5" fill="none" />
        <path d="M262 37 Q276 28 294 22" stroke="#5A5A5E" strokeWidth="0.5" fill="none" />
        {/* Tail feathers */}
        <path d="M268 39 Q276 42 272 46 Q270 42 268 39" style={{ fill: "var(--wire)" }} />
        <path d="M269 38 Q278 40 275 43" fill="#4A4A4C" />
        {/* Eye */}
        <circle cx="250" cy="35.5" r="1" style={{ fill: "var(--always-light)" }} />
        <circle cx="250" cy="35.5" r="0.4" style={{ fill: "var(--always-dark)" }} />
      </g>

      {/* Section 1 - top narrow (y=20-100) */}
      <line x1="130" y1="100" x2="170" y2="20" style={sr} strokeWidth="2" />
      <line x1="210" y1="100" x2="170" y2="20" style={sr} strokeWidth="2" />
      <line x1="130" y1="100" x2="210" y2="100" style={sr} strokeWidth="1.5" />
      <line x1="130" y1="100" x2="170" y2="60" style={sr} strokeWidth="1" opacity="0.5" />
      <line x1="210" y1="100" x2="170" y2="60" style={sr} strokeWidth="1" opacity="0.5" />
      <line x1="170" y1="60" x2="130" y2="100" style={sr} strokeWidth="1" opacity="0.5" />
      <line x1="170" y1="60" x2="210" y2="100" style={sr} strokeWidth="1" opacity="0.5" />

      {/* Section 2 (y=100-200) */}
      <line x1="90" y1="200" x2="130" y2="100" style={sr} strokeWidth="2" />
      <line x1="250" y1="200" x2="210" y2="100" style={sr} strokeWidth="2" />
      <line x1="90" y1="200" x2="250" y2="200" style={sr} strokeWidth="1.5" />
      <line x1="90" y1="200" x2="210" y2="100" style={sr} strokeWidth="1" opacity="0.4" />
      <line x1="250" y1="200" x2="130" y2="100" style={sr} strokeWidth="1" opacity="0.4" />
      <line x1="108" y1="150" x2="232" y2="150" style={sr} strokeWidth="1" opacity="0.5" />

      {/* Section 3 (y=200-320) platform section */}
      <line x1="60" y1="320" x2="90" y2="200" style={sr} strokeWidth="2.5" />
      <line x1="280" y1="320" x2="250" y2="200" style={sr} strokeWidth="2.5" />
      <line x1="55" y1="320" x2="285" y2="320" style={sr} strokeWidth="2.5" />
      <rect x="55" y="315" width="230" height="8" style={{ fill: "var(--rust)" }} opacity="0.3" />
      <line x1="60" y1="320" x2="250" y2="200" style={sr} strokeWidth="1" opacity="0.4" />
      <line x1="280" y1="320" x2="90" y2="200" style={sr} strokeWidth="1" opacity="0.4" />
      <line x1="75" y1="260" x2="265" y2="260" style={sr} strokeWidth="1" opacity="0.4" />

      {/* Section 4 - lower wide (y=320-440) */}
      <line x1="40" y1="440" x2="60" y2="320" style={sr} strokeWidth="3" />
      <line x1="300" y1="440" x2="280" y2="320" style={sr} strokeWidth="3" />
      <line x1="35" y1="440" x2="305" y2="440" style={sr} strokeWidth="2" />
      <line x1="40" y1="440" x2="280" y2="320" style={sr} strokeWidth="1.5" opacity="0.4" />
      <line x1="300" y1="440" x2="60" y2="320" style={sr} strokeWidth="1.5" opacity="0.4" />
      <line x1="48" y1="380" x2="292" y2="380" style={sr} strokeWidth="1" opacity="0.5" />
      <path d="M170 340 L190 380 L170 420 L150 380 Z" style={{ stroke: "var(--rust)" }} strokeWidth="1" fill="none" opacity="0.3" />

      {/* Section 5 - base (y=440-490) */}
      <line x1="25" y1="490" x2="40" y2="440" style={sr} strokeWidth="3.5" />
      <line x1="315" y1="490" x2="300" y2="440" style={sr} strokeWidth="3.5" />
      <line x1="20" y1="490" x2="320" y2="490" style={sr} strokeWidth="2" />
      <line x1="25" y1="490" x2="300" y2="440" style={sr} strokeWidth="1" opacity="0.4" />
      <line x1="315" y1="490" x2="40" y2="440" style={sr} strokeWidth="1" opacity="0.4" />

      {/* Base concrete block */}
      <rect x="145" y="490" width="50" height="18" style={{ fill: "var(--rust)" }} opacity="0.5" />
      <rect x="148" y="508" width="44" height="8" style={{ fill: "var(--rust)" }} opacity="0.3" />

      {/* Vine / overgrowth suggestions */}
      <path d="M60 320 Q50 340 45 370 Q52 380 48 400" style={sp} strokeWidth="1.5" fill="none" opacity="0.6" />
      <path d="M55 350 Q40 355 35 370" style={sp} strokeWidth="1" fill="none" opacity="0.5" />
      <path d="M280 320 Q290 345 295 375 Q288 388 292 410" style={sp} strokeWidth="1.5" fill="none" opacity="0.6" />
      <path d="M285 355 Q300 360 305 375" style={sp} strokeWidth="1" fill="none" opacity="0.5" />

      {/* Overgrowth at base */}
      <path
        d="M0 500 Q20 480 40 490 Q60 475 80 490 Q100 478 120 488 Q140 480 160 490 Q180 476 200 488 Q220 479 240 490 Q260 476 280 490 Q300 478 320 490 Q335 484 340 500"
        style={sp}
        strokeWidth="1.5"
        fill="rgba(74,103,65,0.08)"
      />
      <path
        d="M0 510 Q30 495 60 505 Q90 494 120 504 Q150 493 180 503 Q210 492 240 503 Q270 492 300 502 Q325 495 340 510"
        style={sp}
        strokeWidth="1"
        fill="none"
        opacity="0.5"
      />

      {/* Measurement tick marks - engineering feel */}
      <line x1="16" y1="490" x2="12" y2="490" style={sr} strokeWidth="1" opacity="0.3" />
      <line x1="16" y1="440" x2="12" y2="440" style={sr} strokeWidth="1" opacity="0.3" />
      <line x1="16" y1="380" x2="12" y2="380" style={sr} strokeWidth="1" opacity="0.3" />
      <line x1="16" y1="320" x2="12" y2="320" style={sr} strokeWidth="1" opacity="0.3" />
      <line x1="14" y1="490" x2="14" y2="320" style={sr} strokeWidth="0.5" opacity="0.2" />
    </svg>
  );
}
