import { createHash } from "node:crypto";

type Aspect = "overview" | "typography" | "layout";
type Cue = { aspect: Aspect; excerpt: string; page: number };
type SearchableReference = {
  id: string;
  title: string;
  description: string;
  content: string;
  pages: string[];
};

const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const words = (text: string) =>
  normalize(text)
    .replace(/\bsem[ -]serifas?\b/g, "sans")
    .replace(/\bsans[ -]serif\b/g, "sans")
    .match(/[a-z0-9]+/g) ?? [];

// Brief scaffolding is not evidence for a visual direction. Translation is deliberately
// bounded to design vocabulary; unknown concepts never trigger default brand choices.
const stopWords = new Set(
  words(
    "a an and are as at be by com como da das de design do dos e em for from in is it its na nas no nos o of on or os para por que the to um uma with quero criar crie use usar estilo estilo visual referencia referencias documento documentos relatorio relatorios apresentacao apresentacoes proposta pdf docx pptx slide slides deck report presentation document please por favor make create want would like estilo tipografia typography",
  ),
);
const aliases = [
  "acolhedor acolhedora caloroso calorosa quente warm welcoming",
  "editorial revista magazine",
  "serifada serifadas serifado serifados serifa serif",
  "monoespacada monoespacado monoespacadas mono monospace monospaced",
  "tecnico tecnica tecnicos tecnicas technical engineering",
  "grade grades grid",
  "rigido rigida rigoroso rigorosa precise precision rigorous",
  "cinematografico cinematografica cinema cinematic film",
  "fotografia fotografico fotografica photography photographic",
  "luxo luxuoso luxuosa luxury premium",
  "minimalista minimalismo minimal minimalist minimalism",
  "escuro escura dark",
  "claro clara light",
  "branco branca white",
  "preto preta black",
  "azul blue",
  "verde green",
  "vermelho vermelha red",
  "laranja orange",
  "roxo roxa purple violet",
  "amarelo amarela yellow",
  "creme cream",
  "vibrante vibrantes vibrant vivid",
  "ousado ousada bold expressive expressivo expressiva",
  "brincalhao brincalhona ludico ludica playful",
  "geometrico geometrica geometric",
  "corporativo corporativa empresarial enterprise corporate",
  "financeiro financeira financeiro financial finance",
  "denso densa dense",
  "espacamento espaco whitespace spacing",
  "ilustracao ilustracoes illustration illustrated",
  "retro vintage nostalgic",
].map(words);
const aliasLookup = new Map(
  aliases.flatMap((group) => group.map((word) => [word, group] as const)),
);

export function referenceIndex(reference: SearchableReference) {
  const sections = [...reference.content.matchAll(/^## (.+)\r?$/gm)].map(
    (match, index, matches) => ({
      heading: normalize(match[1]).replace(/^\d+\.\s*/, ""),
      start: match.index + match[0].length,
      end: matches[index + 1]?.index ?? reference.content.length,
    }),
  );
  const selected = {
    overview: sections.find(({ heading }) => /overview|visual theme|atmosphere/.test(heading)),
    typography: sections.find(({ heading }) => /^typography/.test(heading)),
    layout: sections.find(({ heading }) => /^layout/.test(heading)),
  };
  const sectionText = (aspect: Aspect) => {
    const section = selected[aspect];
    return section ? reference.content.slice(section.start, section.end) : "";
  };
  const cues: Cue[] = [];
  for (const aspect of ["overview", "typography", "layout"] as const) {
    const section = selected[aspect];
    if (!section) continue;
    const text = sectionText(aspect);
    // Prefer composition prose to a spacing-token inventory.
    const usefulHeading =
      aspect === "layout"
        ? /### (?:Grid[^\n]*|Whitespace[^\n]*|Composition[^\n]*)\n+/i.exec(text)
        : undefined;
    const candidateStart = usefulHeading ? usefulHeading.index + usefulHeading[0].length : 0;
    const paragraph = /^[^\s#|][^\n]*(?:\n(?!\s*$|#|\|)[^\n]+)*/m.exec(text.slice(candidateStart));
    if (!paragraph) continue;
    const start = section.start + candidateStart + paragraph.index;
    let offset = 0;
    const page = reference.pages.findIndex((chunk) => {
      if (start < offset + chunk.length) return true;
      offset += chunk.length;
      return false;
    });
    let excerpt = reference.content.slice(
      start,
      Math.min(start + 420, start + paragraph[0].length, offset + reference.pages[page].length),
    );
    if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
    cues.push({ aspect, excerpt, page });
  }
  const description =
    reference.description === "|"
      ? (cues.find(({ aspect }) => aspect === "overview")?.excerpt.slice(0, 400) ?? reference.title)
      : reference.description;
  return {
    description,
    cues,
    name: new Set(words(`${reference.id} ${reference.title}`)),
    descriptionTerms: new Set(words(description)),
    summary: new Set(words(sectionText("overview"))),
    structure: new Set(words(`${sectionText("typography")} ${sectionText("layout")}`)),
    body: new Set(words(reference.content)),
  };
}

type IndexedReference = SearchableReference & { index: ReturnType<typeof referenceIndex> };

export function rankReferences<T extends IndexedReference>(references: T[], query: string) {
  const terms = [...new Set(words(query).filter((word) => !stopWords.has(word)))].slice(0, 24);
  const groups = terms.map((term) => ({ term, alternatives: aliasLookup.get(term) ?? [term] }));
  const frequency = new Map(
    groups.map(({ term, alternatives }) => [
      term,
      references.filter(({ index }) => alternatives.some((word) => index.body.has(word))).length,
    ]),
  );
  const phrase = ` ${words(query).join(" ")} `;
  return references
    .map((entry) => {
      const exact = [entry.id, entry.title].some((name) =>
        phrase.includes(` ${words(name).join(" ")} `),
      );
      const matchedTerms: string[] = [];
      let score = 0;
      for (const { term, alternatives } of groups) {
        const fields = [
          [entry.index.name, 12],
          [entry.index.descriptionTerms, 7],
          [entry.index.summary, 2],
          [entry.index.structure, 1],
          [entry.index.body, 0.15],
        ] as const;
        const weight = fields.reduce(
          (sum, [tokens, weight]) =>
            sum + (alternatives.some((word) => tokens.has(word)) ? weight : 0),
          0,
        );
        if (!weight) continue;
        matchedTerms.push(term);
        score +=
          weight * (0.2 + Math.log((references.length + 1) / ((frequency.get(term) ?? 0) + 1)));
      }
      score *= 0.4 + (0.6 * matchedTerms.length) / Math.max(1, groups.length);
      if (exact) score += 1000;
      return { entry, score, exact, matchedTerms };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        createHash("sha256")
          .update(`${normalize(query)}:${a.entry.id}`)
          .digest("hex")
          .localeCompare(
            createHash("sha256")
              .update(`${normalize(query)}:${b.entry.id}`)
              .digest("hex"),
          ),
    );
}

export function diverseReferences<T extends IndexedReference>(
  ranked: ReturnType<typeof rankReferences<T>>,
  limit: number,
  recentIds: Set<string>,
) {
  if (!ranked.length) return [];
  // Compare source language about typography/composition, not palette IDs or a brand rotation.
  const signature = (entry: T) =>
    new Set(
      [...entry.index.summary, ...entry.index.structure].filter(
        (word) => word.length > 3 && !stopWords.has(word),
      ),
    );
  const similarity = (a: T, b: T) => {
    const first = signature(a);
    const second = signature(b);
    const common = [...first].filter((word) => second.has(word)).length;
    return common / (first.size + second.size - common || 1);
  };
  const strongest = ranked.find(({ exact }) => !exact)?.score ?? ranked[0].score;
  const pool = ranked.filter(({ score, exact }) => exact || score >= strongest * 0.45);
  const selected: typeof ranked = [];
  while (pool.length && selected.length < limit) {
    const utility = (candidate: (typeof ranked)[number]) => {
      if (candidate.exact) return candidate.score;
      const resemblance = Math.max(
        0,
        ...selected.map(({ entry }) => similarity(entry, candidate.entry)),
      );
      return (
        candidate.score / strongest -
        resemblance * 0.35 -
        (recentIds.has(candidate.entry.id) ? 0.12 : 0)
      );
    };
    pool.sort((a, b) => utility(b) - utility(a));
    const next = pool.shift();
    if (next) selected.push(next);
  }
  return selected;
}
