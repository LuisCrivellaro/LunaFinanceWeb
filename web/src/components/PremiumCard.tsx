/**
 * Face do cartão de crédito da família (Visa Infinite preto, Itaú Personnalité,
 * LATAM Pass), em formato retrato. Marcas desenhadas aqui em SVG/CSS, sem
 * arquivos externos. Todos os cartões têm a mesma aparência: muda só o titular.
 * Medidas em % e em `cqw` para escalar com a largura do cartão.
 */

function Chip() {
  return (
    <svg className="pc-chip" viewBox="0 0 40 52" aria-hidden>
      <defs>
        <linearGradient id="pcChipMetal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f2f2f4" />
          <stop offset="0.35" stopColor="#b9b9be" />
          <stop offset="0.6" stopColor="#e4e4e8" />
          <stop offset="1" stopColor="#8f8f95" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="39" height="51" rx="7" fill="url(#pcChipMetal)" stroke="#6f6f75" strokeWidth="0.8" />
      <g fill="none" stroke="#7b7b81" strokeWidth="0.9" strokeLinecap="round">
        <path d="M20 0.8v13M20 38v13.2" />
        <path d="M0.8 17h11.5c2.4 0 3.7 1.3 3.7 3.7v10.6c0 2.4-1.3 3.7-3.7 3.7H0.8" />
        <path d="M39.2 17H27.7c-2.4 0-3.7 1.3-3.7 3.7v10.6c0 2.4 1.3 3.7 3.7 3.7h11.5" />
        <path d="M16 14h8M16 38h8" />
        <path d="M0.8 26h3M39.2 26h-3" />
      </g>
    </svg>
  );
}

function LatamPass() {
  return (
    <svg className="pc-latam" viewBox="0 0 104 36" aria-hidden>
      <g fill="none" stroke="#f4f4f6" strokeLinecap="round">
        <path d="M2 27c5-1 9.5-4.5 12.5-10" strokeWidth="2.2" />
        <path d="M4.5 32c6-1.2 11-5 14-11.5" strokeWidth="1.6" />
        <path d="M9 35c4.5-1 8.3-3.6 10.8-7.6" strokeWidth="1.1" />
      </g>
      <text x="25" y="12" className="pc-latam-top">
        LATAM
      </text>
      <text x="23.5" y="33.5" className="pc-latam-pass">
        PASS
      </text>
    </svg>
  );
}

export function PremiumCard({ holder, relation, last4 }: { holder: string; relation: string | null; last4?: string | null }) {
  return (
    <div className="pc" aria-hidden>
      <span className="pc-sheen" />
      <div className="pc-strip">
        <span className="pc-id">
          <span className="pc-holder">{holder}</span>
          {relation && <span className="pc-relation">{relation}</span>}
        </span>
        {last4 && (
          <span className="pc-last4">
            <span className="pc-dots">••••</span> {last4}
          </span>
        )}
      </div>

      <div className="pc-visa">
        <span className="pc-visa-word">VISA</span>
        <span className="pc-visa-tier">Infinite</span>
      </div>
      <Chip />

      <div className="pc-itau">
        <span className="pc-itau-mark">itaú</span>
        <span className="pc-itau-line" />
        <span className="pc-itau-name">Personnalitê</span>
      </div>
      <LatamPass />
    </div>
  );
}
