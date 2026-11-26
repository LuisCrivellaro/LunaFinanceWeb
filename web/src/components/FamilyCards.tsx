/**
 * "Cartões da família" — topo da coluna direita do painel.
 * Pilha com os 4 cartões (mesma arte); o selecionado mostra os gastos do mês
 * e as últimas despesas do titular. Dados de GET /api/wallet.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { CreditCard, Lock, ReceiptText } from "lucide-react";
import { get, qs } from "../lib/api";
import { dateShort, firstName, monthName, money } from "../lib/format";
import type { Transaction } from "../lib/types";
import { CardSkeleton, CategoryIcon, Empty, ErrorState, Money } from "./ui";
import { WalletStack } from "./WalletStack";
import { PremiumCard } from "./PremiumCard";

interface WalletCard {
  userId: number;
  name: string;
  relation: string | null;
  color: string;
  invoiceHolder: boolean;
  last4: string | null;
  expenseCents: number | null;
  cardCents: number | null;
  expenseCount: number | null;
  recent: Transaction[] | null;
}

interface WalletResponse {
  month: string;
  invoice: { holderId: number | null; holderName: string | null; familyCardCents: number | null };
  cards: WalletCard[];
}

/** Configuração inicial da pilha. Valores em BRL/pt-BR via lib/format (money). */
const STACK = { defaultView: "fan", hoverFan: false, peek: 48, duration: 0.55, bounce: 0.15, radius: 18 } as const;

/** `onOpen` recebe só lançamentos de `editableUserId` (cada um edita os próprios). */
export function FamilyCards({ month, onOpen, editableUserId }: { month: string; onOpen?(t: Transaction): void; editableUserId?: number }) {
  const q = useQuery({
    queryKey: ["wallet", month],
    queryFn: () => get<WalletResponse>(`/wallet${qs({ month })}`),
  });
  const cards = q.data?.cards ?? [];
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // começa no titular da fatura (Luís Carlos) e mantém a escolha ao trocar de mês
  useEffect(() => {
    if (!q.data) return;
    if (selectedId == null || !q.data.cards.some((c) => c.userId === selectedId)) {
      setSelectedId(q.data.invoice.holderId ?? q.data.cards[0]?.userId ?? null);
    }
  }, [q.data, selectedId]);

  const selected = cards.find((c) => c.userId === selectedId) ?? null;
  const mName = monthName(month);

  return (
    <section className="card family-cards" aria-label="Cartões da família">
      <div className="card-head">
        <h2>Cartões da família</h2>
        <span className="meta" style={{ textTransform: "capitalize" }}>{mName}</span>
      </div>

      {q.error ? (
        <ErrorState error={q.error} retry={() => q.refetch()} />
      ) : !q.data || selected == null ? (
        <CardSkeleton h={420} />
      ) : (
        <>
          <WalletStack
            items={cards.map((c) => ({ ...c, id: c.userId, label: `Cartão de ${c.name}${c.relation ? `, ${c.relation}` : ""}${c.last4 ? `, final ${c.last4}` : ""}` }))}
            selectedId={selected.userId}
            onSelect={setSelectedId}
            renderCard={(c) => <PremiumCard holder={c.name} relation={c.relation} last4={c.last4} />}
            defaultView={STACK.defaultView}
            hoverFan={STACK.hoverFan}
            peek={STACK.peek}
            duration={STACK.duration}
            bounce={STACK.bounce}
            radius={STACK.radius}
            ariaLabel="Cartões da família — escolha um titular"
          />

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={selected.userId}
              className="fc-detail"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              aria-live="polite"
            >
              <div className="fc-who">
                <span className="fc-dot" style={{ ["--c" as string]: selected.color }} aria-hidden />
                <b>{selected.name}</b>
                {selected.relation && <span className="chip">{selected.relation}</span>}
                {selected.last4 && <span className="chip tnum">final {selected.last4}</span>}
                {selected.invoiceHolder && <span className="chip primary">Titular da fatura</span>}
              </div>

              <div className="fc-stats">
                <div>
                  <span className="eyebrow">Gastos no mês</span>
                  <span className="v num">{selected.expenseCents == null ? "—" : money(selected.expenseCents)}</span>
                  <span className="s">
                    {selected.expenseCount == null ? "sem acesso" : `${selected.expenseCount} despesa${selected.expenseCount === 1 ? "" : "s"}`}
                  </span>
                </div>
                <div>
                  <span className="eyebrow">No cartão</span>
                  <span className="v num">{selected.cardCents == null ? "—" : money(selected.cardCents)}</span>
                  <span className="s">pagos no crédito</span>
                </div>
              </div>

              <div className="fc-list-head">
                <span>Últimas despesas de {firstName(selected.name)}</span>
              </div>
              {selected.recent == null ? (
                <p className="fc-locked">
                  <Lock size={14} aria-hidden /> Sua conta vê só os totais de {firstName(selected.name)}.
                </p>
              ) : selected.recent.length === 0 ? (
                <Empty icon={<ReceiptText size={20} />} title="Nenhuma despesa no mês" text="Quando houver gastos, eles aparecem aqui." />
              ) : (
                <div className="list">
                  {selected.recent.map((t) => {
                    const canOpen = Boolean(onOpen) && t.userId === editableUserId;
                    return (
                      <div
                        key={t.id}
                        className={`list-item${canOpen ? " clickable" : ""}`}
                        onClick={canOpen ? () => onOpen!(t) : undefined}
                        role={canOpen ? "button" : undefined}
                        tabIndex={canOpen ? 0 : undefined}
                        onKeyDown={canOpen ? (e) => e.key === "Enter" && onOpen!(t) : undefined}
                      >
                        <CategoryIcon icon={t.categoryIcon} color={t.categoryColor} size={34} />
                        <div style={{ minWidth: 0 }}>
                          <div className="title">{t.description}</div>
                          <div className="sub">
                            <span>{dateShort(t.date)}</span>
                            <span>{t.categoryName ?? "Sem categoria"}</span>
                            {t.paymentMethod === "credit_card" && (
                              <span className="fc-paid-card" title="Cartão de crédito">
                                <CreditCard size={12} aria-hidden /> Cartão
                              </span>
                            )}
                          </div>
                        </div>
                        <Money cents={t.amountCents} className="amount" />
                      </div>
                    );
                  })}
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {q.data.invoice.holderName && (
            <div className="fc-invoice">
              <CreditCard size={16} aria-hidden />
              <div style={{ minWidth: 0 }}>
                <div>
                  Fatura única no nome de <b>{firstName(q.data.invoice.holderName)}</b>
                </div>
                <div className="s">compras no cartão de todos em {mName}, por data da compra</div>
              </div>
              <span className="num">{q.data.invoice.familyCardCents == null ? "—" : money(q.data.invoice.familyCardCents)}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
