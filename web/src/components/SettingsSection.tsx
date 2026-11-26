import type { ReactNode } from "react";

/** Bloco padrão das Configurações (cartão com título e descrição). */
export function Section({ id, title, desc, children }: { id: string; title: string; desc?: string; children: ReactNode }) {
  return (
    <section id={id} className="card settings-section" aria-labelledby={`${id}-t`}>
      <header className="settings-section-head">
        <h2 id={`${id}-t`}>{title}</h2>
        {desc && <p>{desc}</p>}
      </header>
      <div className="stack">{children}</div>
    </section>
  );
}
