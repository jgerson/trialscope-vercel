// Sign-in page illustration: TrialScope's three sources as record cards (patient note, PubMed, trial) in the app's
// source colors, with the logo's lens magnifying a matched line on the trial card. Fine-line, original, no stock art.
const INK = "#080503";
const LINE = "#E7E4DD";
const LINE_2 = "#D3CFC6";
const SOURCES = [
  { label: "NOTE", color: "#8A4B12", soft: "#F6EEE2", x: 62, y: 118, rotate: -9 },
  { label: "PUBMED", color: "#34449A", soft: "#EDEEF6", x: 138, y: 84, rotate: 1 },
  { label: "TRIAL", color: "#2F6B4F", soft: "#E9F0EA", x: 214, y: 112, rotate: 9 },
];
const BARS = [176, 148, 186, 120, 164, 98, 152, 132];

function Card({ label, color, soft, x, y, rotate }: (typeof SOURCES)[number]) {
  const w = 236, h = 300;
  return (
    <g transform={`rotate(${rotate} ${x + w / 2} ${y + h / 2})`}>
      <rect x={x} y={y} width={w} height={h} rx={16} fill="#FFFFFF" stroke={LINE_2} strokeWidth={1.5} />
      <rect x={x + 22} y={y + 24} width={label.length * 9 + 22} height={22} rx={6} fill={soft} />
      <text x={x + 33} y={y + 39.5} fontSize={11} fontWeight={600} letterSpacing={1.2} fill={color}
        fontFamily="var(--font-jetbrains-mono), ui-monospace, monospace">{label}</text>
      <rect x={x + 22} y={y + 66} width={150} height={9} rx={4.5} fill={INK} opacity={0.82} />
      {BARS.map((bw, i) => (
        <rect key={i} x={x + 22} y={y + 96 + i * 22} width={bw} height={7} rx={3.5} fill={LINE} />
      ))}
    </g>
  );
}

export function AuthIllustration() {
  // The lens sits over the trial card; inside it, that card's lines are drawn larger, with one matched line highlighted.
  const cx = 352, cy = 352, r = 94;
  return (
    <svg viewBox="0 0 540 540" role="img" aria-labelledby="auth-art-title" className="h-auto w-full max-w-[520px]">
      <title id="auth-art-title">A magnifying lens over a patient note, a PubMed abstract and a clinical trial record</title>
      <defs>
        <pattern id="auth-dots" width="22" height="22" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.2" fill={LINE_2} />
        </pattern>
        <clipPath id="auth-lens"><circle cx={cx} cy={cy} r={r - 4} /></clipPath>
      </defs>
      <rect width="540" height="540" fill="url(#auth-dots)" opacity={0.55} />
      {SOURCES.map((s) => <Card key={s.label} {...s} />)}

      {/* Lens: the same circle, handle and proportions as the TrialScope mark. */}
      <circle cx={cx} cy={cy} r={r} fill="#FFFFFF" />
      <g clipPath="url(#auth-lens)">
        <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} fill="#FBFBFA" />
        <rect x={cx - 74} y={cy - 52} width={128} height={13} rx={6.5} fill={LINE} />
        <rect x={cx - 74} y={cy - 18} width={150} height={26} rx={9} fill="#E9F0EA" stroke="#2F6B4F" strokeWidth={1.5} />
        <rect x={cx - 62} y={cy - 9} width={96} height={8} rx={4} fill="#2F6B4F" opacity={0.75} />
        <rect x={cx - 74} y={cy + 26} width={110} height={13} rx={6.5} fill={LINE} />
        <rect x={cx - 74} y={cy + 56} width={140} height={13} rx={6.5} fill={LINE} />
      </g>
      <circle cx={cx + 62} cy={cy - 5} r={11} fill="#2F6B4F" />
      <path d={`M${cx + 56.5} ${cy - 5}l3.8 3.8 7-7.6`} fill="none" stroke="#FFFFFF" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={INK} strokeWidth={7} />
      <path d={`M${cx + r * 0.72} ${cy + r * 0.72}L${cx + r * 1.32} ${cy + r * 1.32}`} stroke={INK} strokeWidth={15} strokeLinecap="round" />
    </svg>
  );
}
