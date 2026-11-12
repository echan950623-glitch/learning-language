import type { ConceptCardView } from "@/domain/conceptCardLookup";

/** The teaching side of a practice concept, shown before its first question. */
export function ConceptCardContent({ view }: { view: ConceptCardView }) {
  const { card } = view;
  return (
    <div className="flex flex-col gap-8">
      <div>
        {view.level ? <p className="eyebrow">{view.level}</p> : null}
        <p lang="ja" className="mt-2 break-words font-display text-3xl font-medium leading-snug text-foreground">{view.title}</p>
        {card ? <p className="mt-4 text-base leading-7 text-foreground">{card.meaning}</p> : null}
      </div>
      {card?.connection ? (
        <section aria-label="接續">
          <h2 className="eyebrow">接續</h2>
          <p lang="ja" className="mt-2 whitespace-pre-line leading-7 text-foreground">{card.connection}</p>
        </section>
      ) : null}
      {card?.examples.length ? (
        <section aria-label="例句">
          <h2 className="eyebrow">例句</h2>
          <ul className="mt-3 flex flex-col gap-4">
            {card.examples.map(example => (
              <li key={example.ja} className="border-l-2 border-foreground pl-4">
                <p lang="ja" className="leading-7 text-foreground">{example.ja}</p>
                {example.zh ? <p className="mt-1 text-sm leading-6 text-foreground-muted">{example.zh}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {card?.contrast ? (
        <section aria-label="容易混淆">
          <h2 className="eyebrow">容易混淆</h2>
          <p className="mt-2 text-sm leading-6 text-foreground">{card.contrast}</p>
        </section>
      ) : null}
      {!card ? <p className="text-sm leading-6 text-foreground-muted">這組練習還沒有概念說明，可以直接開始作答，解析會在答題後出現。</p> : null}
    </div>
  );
}
