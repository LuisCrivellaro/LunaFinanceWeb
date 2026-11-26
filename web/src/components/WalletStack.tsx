/**
 * Pilha de cartões selecionáveis (componente próprio, sem código de terceiros).
 *
 * - "fan": cartões em leque vertical; cada cartão de trás mostra `peek` px do
 *   topo (onde fica o nome do titular). O selecionado vai para a frente.
 * - "stack": baralho compacto; com `hoverFan` ele abre em leque ao passar o mouse.
 * Seleção só por clique, toque ou teclado. Não há rotação automática.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, MotionConfig } from "motion/react";

export interface WalletStackItem {
  id: number;
  /** Rótulo acessível do botão do cartão. */
  label: string;
}

interface Props<T extends WalletStackItem> {
  items: T[];
  selectedId: number;
  onSelect(id: number): void;
  renderCard(item: T, state: { selected: boolean }): ReactNode;
  defaultView?: "fan" | "stack";
  hoverFan?: boolean;
  /** Quanto de cada cartão de trás fica visível no leque (px). */
  peek?: number;
  /** Duração da mola (s). */
  duration?: number;
  /** Elasticidade da mola (0 = sem ultrapassar). */
  bounce?: number;
  radius?: number;
  /** Largura máxima do cartão (px); encolhe em containers menores. */
  width?: number;
  /** Altura / largura do cartão. Retrato ID-1 = 1,586. */
  aspect?: number;
  ariaLabel?: string;
}

const STACK_STEP = 10;

export function WalletStack<T extends WalletStackItem>({
  items, selectedId, onSelect, renderCard, defaultView = "fan", hoverFan = false, peek = 48, duration = 0.55, bounce = 0.15,
  radius = 18, width = 236, aspect = 1.586, ariaLabel = "Cartões",
}: Props<T>) {
  const wrap = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(width);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setAvail(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cardW = Math.max(160, Math.min(width, avail));
  const cardH = Math.round(cardW * aspect);
  const fanned = defaultView === "fan" || (hoverFan && hovered);
  const step = fanned ? peek : STACK_STEP;
  const n = items.length;

  // ordem de exibição: os demais na ordem original (atrás), o selecionado na frente
  const order = [...items.filter((i) => i.id !== selectedId), ...items.filter((i) => i.id === selectedId)];
  const height = (n - 1) * step + cardH;

  const move = (dir: 1 | -1) => {
    const idx = items.findIndex((i) => i.id === selectedId);
    const next = items[(idx + dir + n) % n];
    if (next) onSelect(next.id);
  };

  return (
    <MotionConfig reducedMotion="user" transition={{ type: "spring", duration, bounce }}>
      <div ref={wrap} className="wallet-stack-wrap">
        <motion.div
          className="wallet-stack"
          role="group"
          aria-label={ariaLabel}
          style={{ width: cardW }}
          animate={{ height }}
          initial={false}
          onHoverStart={() => setHovered(true)}
          onHoverEnd={() => setHovered(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
              e.preventDefault();
              move(-1);
            }
          }}
        >
          {items.map((item) => {
            const pos = order.indexOf(item);
            const depth = n - 1 - pos; // 0 = frente
            const selected = item.id === selectedId;
            return (
              <motion.button
                key={item.id}
                type="button"
                className="wallet-slot"
                aria-pressed={selected}
                aria-label={item.label}
                onClick={() => onSelect(item.id)}
                initial={false}
                animate={{ y: pos * step, scale: 1 - depth * 0.025 }}
                whileTap={selected ? undefined : { scale: 1 - depth * 0.025 - 0.01 }}
                style={{ width: cardW, height: cardH, borderRadius: radius, zIndex: pos + 1, transformOrigin: "50% 0%" }}
              >
                {renderCard(item, { selected })}
              </motion.button>
            );
          })}
        </motion.div>
      </div>
    </MotionConfig>
  );
}
