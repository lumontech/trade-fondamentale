// SVG illustrazioni inline per ogni tipo di pattern.
// Educative + visivamente chiare, niente dipendenze esterne.

const GREEN = '#00e096'
const RED   = '#ff3355'
const GOLD  = '#f5c842'
const TEXT  = '#8892a4'
const LINE  = '#3a4258'

const Candle = ({ x, w, top, bottom, bodyTop, bodyBot, color }) => (
  <g>
    <line x1={x + w/2} y1={top} x2={x + w/2} y2={bottom} stroke={color} strokeWidth="1" />
    <rect x={x} y={bodyTop} width={w} height={Math.max(2, bodyBot - bodyTop)} fill={color} />
  </g>
)

// ── CANDLESTICK PATTERNS ────────────────────────────────────────

function BullishEngulfing() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <Candle x={30} w={10} top={15} bottom={45} bodyTop={20} bodyBot={42} color={RED} />
      <Candle x={55} w={14} top={10} bottom={50} bodyTop={15} bodyBot={48} color={GREEN} />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">Body inghiotte precedente</text>
    </svg>
  )
}

function BearishEngulfing() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <Candle x={30} w={10} top={15} bottom={45} bodyTop={18} bodyBot={40} color={GREEN} />
      <Candle x={55} w={14} top={10} bottom={50} bodyTop={12} bodyBot={45} color={RED} />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">Body inghiotte precedente</text>
    </svg>
  )
}

function Hammer() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <Candle x={45} w={10} top={15} bottom={50} bodyTop={15} bodyBot={25} color={GREEN} />
      <line x1={20} y1={50} x2={80} y2={50} stroke={LINE} strokeDasharray="2,2" />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">Mecha lunga sotto, body in alto</text>
    </svg>
  )
}

function ShootingStar() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <Candle x={45} w={10} top={10} bottom={45} bodyTop={35} bodyBot={45} color={RED} />
      <line x1={20} y1={10} x2={80} y2={10} stroke={LINE} strokeDasharray="2,2" />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">Mecha lunga sopra, body in basso</text>
    </svg>
  )
}

function Doji() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <line x1={50} y1={10} x2={50} y2={50} stroke={GOLD} strokeWidth="1.5" />
      <line x1={42} y1={29} x2={58} y2={29} stroke={GOLD} strokeWidth="2" />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">Open ≈ Close (indecisione)</text>
    </svg>
  )
}

function PinBar() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <Candle x={45} w={10} top={20} bottom={50} bodyTop={20} bodyBot={28} color={GREEN} />
      <line x1={20} y1={50} x2={80} y2={50} stroke={GREEN} strokeWidth="1" strokeDasharray="2,2" />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">Lunga reiezione su S/R</text>
    </svg>
  )
}

function MorningStar() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <Candle x={15} w={10} top={5} bottom={40} bodyTop={8} bodyBot={38} color={RED} />
      <Candle x={45} w={10} top={32} bottom={48} bodyTop={38} bodyBot={42} color={GOLD} />
      <Candle x={75} w={10} top={10} bottom={50} bodyTop={12} bodyBot={42} color={GREEN} />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">3 candele: drop → indeciso → rally</text>
    </svg>
  )
}

function EveningStar() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <Candle x={15} w={10} top={20} bottom={55} bodyTop={22} bodyBot={50} color={GREEN} />
      <Candle x={45} w={10} top={12} bottom={28} bodyTop={18} bodyBot={22} color={GOLD} />
      <Candle x={75} w={10} top={10} bottom={50} bodyTop={18} bodyBot={48} color={RED} />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">3 candele: rally → indeciso → drop</text>
    </svg>
  )
}

function InsideBar() {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <Candle x={30} w={12} top={10} bottom={50} bodyTop={15} bodyBot={45} color={LINE} />
      <Candle x={60} w={10} top={20} bottom={42} bodyTop={25} bodyBot={38} color={GOLD} />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">Range dentro candela madre</text>
    </svg>
  )
}

function Tweezer({ top = false }) {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <Candle x={30} w={10} top={top?10:50} bottom={top?40:10} bodyTop={top?15:20} bodyBot={top?38:45} color={top?GREEN:RED} />
      <Candle x={60} w={10} top={top?10:50} bottom={top?45:10} bodyTop={top?15:20} bodyBot={top?40:45} color={top?RED:GREEN} />
      <line x1={20} y1={top?10:50} x2={80} y2={top?10:50} stroke={GOLD} strokeWidth="0.7" strokeDasharray="2,2" />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">Stesso {top?'high':'low'} consecutivo</text>
    </svg>
  )
}

// ── CHART PATTERNS ──────────────────────────────────────────────

function HeadShoulders({ inverse = false }) {
  const yScale = inverse ? -1 : 1
  const yBase = inverse ? 50 : 10
  // 3 punti: spalla SX, testa, spalla DX
  const points = inverse
    ? "5,15 15,30 25,15 35,10 45,15 55,30 65,15 75,30 85,15 95,10".split(' ')
    : "5,45 15,30 25,45 35,50 45,45 55,30 65,45 75,30 85,45 95,50".split(' ')
  // Disegno semplificato
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <polyline
        points={inverse
          ? "5,15 18,35 30,20 50,45 70,20 82,35 95,15"
          : "5,45 18,25 30,40 50,15 70,40 82,25 95,45"}
        fill="none" stroke={inverse ? GREEN : RED} strokeWidth="1.5" />
      {/* neckline */}
      <line x1={5} y1={inverse ? 25 : 35} x2={95} y2={inverse ? 25 : 35} stroke={GOLD} strokeWidth="0.8" strokeDasharray="3,2" />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">
        {inverse ? 'H&S Inversa (bullish)' : 'Testa e Spalle (bearish)'}
      </text>
    </svg>
  )
}

function DoubleTopBottom({ top = true }) {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <polyline
        points={top
          ? "5,40 25,15 45,35 65,15 85,40"
          : "5,20 25,45 45,25 65,45 85,20"}
        fill="none" stroke={top ? RED : GREEN} strokeWidth="1.5" />
      {/* neckline */}
      <line x1={5} y1={top ? 35 : 25} x2={85} y2={top ? 35 : 25} stroke={GOLD} strokeWidth="0.8" strokeDasharray="3,2" />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">
        {top ? 'Doppio Massimo' : 'Doppio Minimo'}
      </text>
    </svg>
  )
}

function Triangle({ kind = 'sym' }) {
  // kind: 'asc' | 'desc' | 'sym'
  const upper = kind === 'asc'
    ? "5,15 95,15"
    : kind === 'desc'
      ? "5,15 95,30"
      : "5,15 95,28"
  const lower = kind === 'asc'
    ? "5,45 95,30"
    : kind === 'desc'
      ? "5,45 95,45"
      : "5,45 95,32"
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <polyline points={upper} fill="none" stroke={RED} strokeWidth="1.2" strokeDasharray="3,2" />
      <polyline points={lower} fill="none" stroke={GREEN} strokeWidth="1.2" strokeDasharray="3,2" />
      {/* zigzag price */}
      <polyline points="10,40 20,20 30,38 40,22 50,35 60,25 70,32 80,28" fill="none" stroke={GOLD} strokeWidth="1.2" />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">
        {kind === 'asc' ? 'Triangolo Ascendente' : kind === 'desc' ? 'Triangolo Discendente' : 'Triangolo Simmetrico'}
      </text>
    </svg>
  )
}

function Wedge({ rising = true }) {
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <polyline
        points={rising ? "5,40 95,18" : "5,15 95,40"}
        fill="none" stroke={RED} strokeWidth="1.2" strokeDasharray="3,2" />
      <polyline
        points={rising ? "5,48 95,25" : "5,25 95,48"}
        fill="none" stroke={GREEN} strokeWidth="1.2" strokeDasharray="3,2" />
      <polyline points={rising
        ? "10,45 22,38 32,42 44,32 56,36 68,28 80,32"
        : "10,30 22,38 32,32 44,40 56,36 68,42 80,38"} fill="none" stroke={GOLD} strokeWidth="1.2" />
      <text x="50" y="58" fontSize="6" fill={TEXT} textAnchor="middle">
        {rising ? 'Cuneo Ascendente (bearish)' : 'Cuneo Discendente (bullish)'}
      </text>
    </svg>
  )
}

// ── HARMONIC PATTERNS ───────────────────────────────────────────

function HarmonicXABCD({ name }) {
  // Schema generico XABCD per Gartley/Bat/Cypher/Butterfly/Crab
  // Bullish: X high, A low, B high, C low, D low
  return (
    <svg viewBox="0 0 100 60" className="w-full h-full">
      <polyline
        points="5,15 25,48 40,28 60,42 80,52"
        fill="none" stroke={GOLD} strokeWidth="1.5" />
      <circle cx={5} cy={15} r="2" fill={RED} />
      <circle cx={25} cy={48} r="2" fill={GREEN} />
      <circle cx={40} cy={28} r="2" fill={RED} />
      <circle cx={60} cy={42} r="2" fill={GREEN} />
      <circle cx={80} cy={52} r="2" fill={GREEN} />
      <text x={5}  y={11} fontSize="6" fill={TEXT} textAnchor="middle">X</text>
      <text x={25} y={56} fontSize="6" fill={TEXT} textAnchor="middle">A</text>
      <text x={40} y={24} fontSize="6" fill={TEXT} textAnchor="middle">B</text>
      <text x={60} y={38} fontSize="6" fill={TEXT} textAnchor="middle">C</text>
      <text x={80} y={56} fontSize="6" fill={GOLD} textAnchor="middle" fontWeight="bold">D=PRZ</text>
      <text x="50" y="6" fontSize="6" fill={TEXT} textAnchor="middle">{name}: 5 punti XABCD con ratios Fibonacci</text>
    </svg>
  )
}

// ── ROUTER ──────────────────────────────────────────────────────

const PATTERNS = {
  'Bullish Engulfing':           BullishEngulfing,
  'Bearish Engulfing':           BearishEngulfing,
  'Hammer':                      Hammer,
  'Shooting Star':               ShootingStar,
  'Doji':                        Doji,
  'Dragonfly Doji':              Doji,
  'Gravestone Doji':             Doji,
  'Bullish Pin Bar':             () => <PinBar />,
  'Bearish Pin Bar':             () => <PinBar />,
  'Inside Bar':                  InsideBar,
  'Morning Star':                MorningStar,
  'Evening Star':                EveningStar,
  'Tweezer Top':                 () => <Tweezer top={true} />,
  'Tweezer Bottom':              () => <Tweezer top={false} />,
  'Head & Shoulders':            () => <HeadShoulders inverse={false} />,
  'Inverse Head & Shoulders':    () => <HeadShoulders inverse={true} />,
  'Double Top':                  () => <DoubleTopBottom top={true} />,
  'Double Bottom':               () => <DoubleTopBottom top={false} />,
  'Ascending Triangle':          () => <Triangle kind="asc" />,
  'Descending Triangle':         () => <Triangle kind="desc" />,
  'Symmetric Triangle':          () => <Triangle kind="sym" />,
  'Rising Wedge':                () => <Wedge rising={true} />,
  'Falling Wedge':               () => <Wedge rising={false} />,
  'Gartley':                     () => <HarmonicXABCD name="Gartley" />,
  'Bat':                         () => <HarmonicXABCD name="Bat" />,
  'Cypher':                      () => <HarmonicXABCD name="Cypher" />,
  'Butterfly':                   () => <HarmonicXABCD name="Butterfly" />,
  'Crab':                        () => <HarmonicXABCD name="Crab" />,
}

export default function PatternIllustration({ name }) {
  const Comp = PATTERNS[name]
  if (!Comp) return (
    <div className="flex items-center justify-center text-text-muted font-mono text-xs">
      {name}
    </div>
  )
  return (
    <div className="w-full h-full flex items-center justify-center bg-bg-primary rounded-md p-1">
      <Comp />
    </div>
  )
}
