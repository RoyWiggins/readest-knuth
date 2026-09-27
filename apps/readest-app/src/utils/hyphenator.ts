/**
 * Dictionary hyphenation (Liang's TeX patterns via the `hyphen` package) for
 * Knuth–Plass line breaking, which needs the break points up front instead of
 * leaving them to the engine's `hyphens: auto`. Patterns load per language on
 * first use; each import is spelled out so the bundler only ships these.
 */
import type { default as CreateHyphenator } from 'hyphen';

type PatternModule = { default: unknown };

const PATTERN_LOADERS: Record<string, () => Promise<PatternModule>> = {
  en: () => import('hyphen/patterns/en-us'),
  'en-gb': () => import('hyphen/patterns/en-gb'),
  de: () => import('hyphen/patterns/de-1996'),
  fr: () => import('hyphen/patterns/fr'),
  es: () => import('hyphen/patterns/es'),
  it: () => import('hyphen/patterns/it'),
  pt: () => import('hyphen/patterns/pt'),
  nl: () => import('hyphen/patterns/nl'),
  sv: () => import('hyphen/patterns/sv'),
  da: () => import('hyphen/patterns/da'),
  nb: () => import('hyphen/patterns/nb'),
  no: () => import('hyphen/patterns/nb'),
  fi: () => import('hyphen/patterns/fi'),
  pl: () => import('hyphen/patterns/pl'),
  cs: () => import('hyphen/patterns/cs'),
  ru: () => import('hyphen/patterns/ru'),
  uk: () => import('hyphen/patterns/uk'),
};

const SOFT_HYPHEN = '\u00AD';

/** Returns the offsets inside `word` where it may be hyphenated. */
export type Hyphenator = (word: string) => number[];

const cache = new Map<string, Promise<Hyphenator | null>>();

const patternKey = (lang: string): string | null => {
  const tag = lang.toLowerCase();
  if (PATTERN_LOADERS[tag]) return tag;
  const primary = tag.split(/[-_]/)[0]!;
  return PATTERN_LOADERS[primary] ? primary : null;
};

/** Load the hyphenator for a BCP 47 language tag, or null when unsupported. */
export const loadHyphenator = (lang: string): Promise<Hyphenator | null> => {
  const key = patternKey(lang);
  if (!key) return Promise.resolve(null);
  let hyphenator = cache.get(key);
  if (!hyphenator) {
    hyphenator = Promise.all([import('hyphen'), PATTERN_LOADERS[key]!()])
      .then(([{ default: createHyphenator }, { default: patterns }]) => {
        const hyphenate = (createHyphenator as typeof CreateHyphenator)(patterns, {
          hyphenChar: SOFT_HYPHEN,
        });
        return (word: string) => {
          const offsets: number[] = [];
          let offset = 0;
          for (const part of hyphenate(word).split(SOFT_HYPHEN).slice(0, -1)) {
            offset += part.length;
            offsets.push(offset);
          }
          return offsets;
        };
      })
      .catch((error) => {
        console.warn('Failed to load hyphenation patterns', key, error);
        return null;
      });
    cache.set(key, hyphenator);
  }
  return hyphenator;
};
