/**
 * Knuth–Plass line breaking for book paragraphs.
 *
 * Browsers break lines first-fit, one line at a time, which is what leaves
 * rivers of wide gaps in justified text on narrow screens, and a jagged edge
 * with stray short lines in left-aligned text. This measures each paragraph,
 * picks all of its breaks at once with the Knuth–Plass algorithm
 * (knuthPlass.ts), and makes the engine lay the paragraph out that way. The
 * paragraph gets `white-space: nowrap`, so its own spaces no longer wrap, and
 * each chosen break gets an empty span whose `::after` holds a zero-width
 * space with `white-space: normal` (behind a hyphen at a hyphenated break):
 * the only places left where a line can end. The engine then justifies those
 * lines itself, or leaves them ragged in left-aligned text, where the breaks
 * are chosen for an even rag instead of even spacing.
 *
 * Every inserted element is `cfi-inert` and holds no text, and text nodes are
 * only ever split in place (never moved), so CFIs, live ranges (reading
 * position, annotations) and text extraction see the book's own text.
 */
import {
  breakLines,
  KPBreak,
  KPGlue,
  KPItem,
  KPPenalty,
  paragraphEnd,
  raggedBreak,
} from './knuthPlass';
import { Hyphenator, loadHyphenator } from './hyphenator';

export const KP_PARAGRAPH_CLASS = 'readest-kp';
export const KP_MEASURE_CLASS = 'readest-kp-measure';
export const KP_BREAK_CLASS = 'readest-kp-br';
export const KP_HYPHEN_CLASS = 'readest-kp-hyphen';

const INSERTED_SELECTOR = `.${KP_BREAK_CLASS}, .${KP_HYPHEN_CLASS}`;

// Text blocks that may be set. A div counts only when it holds nothing
// but inline content, which the eligibility check below enforces.
const CANDIDATE_SELECTOR = 'p, li, dd, blockquote, div';

// Content the box/glue model cannot describe: replaced and atomic inlines,
// authored line breaks (verse), ruby, and anything another feature injected.
const UNSUPPORTED_SELECTOR =
  'img, svg, math, ruby, br, table, video, audio, iframe, object, embed, canvas, ' +
  'input, button, select, textarea, pre, [cfi-inert], [cfi-skip]';

// Scripts without inter-word spaces gain nothing from breaking at spaces.
const NO_SPACE_LANGS = /^(zh|ja|ko|th|lo|km|my|bo)\b/i;

const HYPHEN_PENALTY = 50;
// Tried in order; the first that sets the paragraph wins. Wide tolerances are
// still better than first fit, whose loose lines are unbounded.
const TOLERANCES = [2, 4, 12];
// Liang patterns allow very short fragments; keep at least this many letters
// before and after a hyphen (TeX's \lefthyphenmin / \righthyphenmin).
const HYPHEN_MIN_BEFORE = 2;
const HYPHEN_MIN_AFTER = 3;
const MIN_HYPHENATE_LENGTH = 5;
// Breaks are chosen against a measure this much narrower, leaving room for
// measuring error: a line that came out too long would overflow the page.
const SLACK_PX = 1;
// White space a left-aligned line may leave at its end before it counts as
// fully loose (TeX's \raggedright uses 2em; a narrow page needs a little more).
const RAGGED_STRETCH_EM = 3;

type TextEntry = { node: Text; start: number; end: number };

type Glue = Extract<KPItem, { type: 'glue' }> & { start: number; end: number };
type Penalty = Extract<KPItem, { type: 'penalty' }> & { offset: number; hyphen: boolean };
type Box = Extract<KPItem, { type: 'box' }> & { start: number; end: number };
// Plain glue and penalties are the ragged-right encoding's own (raggedBreak).
type Item = Box | Glue | Penalty | KPGlue | KPPenalty;

type Paragraph = {
  el: HTMLElement;
  text: string;
  entries: TextEntry[];
  hyphenate: boolean;
  // Left-aligned: breaks only, spaces keep their natural width.
  ragged: boolean;
  lang: string;
  width: number;
  indent: number;
  hyphenWidth: number;
};

type Line = {
  firstBox: Box;
  // Last box of the line, or the hyphen span when the line ends hyphenated.
  end: Box | HTMLElement;
  width: number;
};

type SetParagraph = { el: HTMLElement; lines: Line[] };

const collectEntries = (el: HTMLElement): { entries: TextEntry[]; text: string } => {
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(el, doc.defaultView?.NodeFilter.SHOW_TEXT ?? 4);
  const entries: TextEntry[] = [];
  let text = '';
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const content = node.data;
    if (!content) continue;
    entries.push({ node, start: text.length, end: text.length + content.length });
    text += content;
  }
  return { entries, text };
};

// Text node and offset holding the character at `offset` (or, with `atEnd`,
// the character just before it).
const locate = (entries: TextEntry[], offset: number, atEnd = false) => {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const entry = entries[mid]!;
    const past = atEnd ? entry.end < offset : entry.end <= offset;
    if (past) lo = mid + 1;
    else hi = mid;
  }
  const entry = entries[lo]!;
  return { node: entry.node, offset: offset - entry.start };
};

// One range per document, reused for every measurement: the engine updates
// each live range on every text-node split, so a fresh range per word made
// inserting the breaks quadratic in the size of the chapter.
const measureRanges = new WeakMap<Document, Range>();

const rangeOf = (doc: Document, entries: TextEntry[], start: number, end: number): Range => {
  let range = measureRanges.get(doc);
  if (!range) {
    range = doc.createRange();
    measureRanges.set(doc, range);
  }
  const from = locate(entries, start);
  const to = locate(entries, end, true);
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
};

type Extent = { left: number; right: number; top: number; bottom: number };

// Horizontal extent per line box of a range: client rects that overlap
// vertically belong to the same line (an inline element fully inside the range
// adds its own rect on top of its text's).
const lineExtents = (range: Range): Extent[] => {
  const extents: Extent[] = [];
  for (const rect of range.getClientRects()) {
    if (rect.width === 0 && rect.height === 0) continue;
    const mid = (rect.top + rect.bottom) / 2;
    const line = extents.find((e) => mid > e.top && mid < e.bottom);
    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
    } else {
      extents.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    }
  }
  return extents;
};

const px = (value: string, basis: number): number =>
  value.endsWith('%') ? (parseFloat(value) / 100) * basis : parseFloat(value) || 0;

const fontOf = (style: CSSStyleDeclaration): string =>
  `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

// Per document: the book's web fonts are only available to its own canvases.
const measureContexts = new WeakMap<Document, CanvasRenderingContext2D | null>();
const measureHyphen = (doc: Document, style: CSSStyleDeclaration): number => {
  if (!measureContexts.has(doc)) {
    measureContexts.set(doc, doc.createElement('canvas').getContext('2d'));
  }
  const context = measureContexts.get(doc);
  if (!context) return parseFloat(style.fontSize) / 3;
  context.font = fontOf(style);
  return context.measureText('-').width;
};

const langOf = (el: HTMLElement, fallback: string): string =>
  el.closest('[lang]')?.getAttribute('lang') ||
  el.closest('[xml\\:lang]')?.getAttribute('xml:lang') ||
  fallback;

const isEligible = (el: HTMLElement, lang: string): boolean => {
  if (el.closest(`[cfi-inert], .${KP_PARAGRAPH_CLASS} *`)) return false;
  if (NO_SPACE_LANGS.test(lang)) return false;
  if (el.querySelector(UNSUPPORTED_SELECTOR)) return false;
  if (!/\S\s+\S/.test(el.textContent ?? '')) return false;
  const win = el.ownerDocument.defaultView!;
  const style = win.getComputedStyle(el);
  if (!/^(justify|left|start)$/.test(style.textAlign) || style.textAlignLast === 'justify') {
    return false;
  }
  if (style.direction !== 'ltr' || style.writingMode !== 'horizontal-tb') return false;
  if (style.whiteSpace !== 'normal') return false;
  if (style.display !== 'block' && style.display !== 'list-item') return false;
  if (win.getComputedStyle(el, '::first-letter').float !== 'none') return false;
  // Only inline content: a block child would split the paragraph into
  // anonymous blocks whose lines this model does not know about.
  for (const child of el.querySelectorAll('*')) {
    const childStyle = win.getComputedStyle(child);
    if (childStyle.display !== 'inline' || childStyle.float !== 'none') return false;
    if (childStyle.position === 'absolute' || childStyle.position === 'fixed') return false;
    if (childStyle.whiteSpace !== 'normal') return false;
  }
  return true;
};

const findParagraphs = (
  doc: Document,
  fallbackLang: string,
  hyphenators: Map<string, Hyphenator | null>,
): Paragraph[] => {
  const win = doc.defaultView!;
  const paragraphs: Paragraph[] = [];
  for (const el of doc.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)) {
    const lang = langOf(el, fallbackLang);
    if (!isEligible(el, lang)) continue;
    const style = win.getComputedStyle(el);
    const contentWidth =
      parseFloat(style.width) -
      (style.boxSizing === 'border-box'
        ? parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.borderRightWidth)
        : 0);
    if (!(contentWidth > 0)) continue;
    const { entries, text } = collectEntries(el);
    paragraphs.push({
      el,
      text,
      entries,
      lang,
      hyphenate: style.hyphens === 'auto' && !!hyphenators.get(lang),
      ragged: style.textAlign !== 'justify',
      width: contentWidth,
      indent: px(style.textIndent, contentWidth),
      hyphenWidth: measureHyphen(doc, style),
    });
  }
  return paragraphs;
};

const HARD_HYPHEN = /[-\u2010\u2013\u2014]/;
const LETTER = /\p{L}/u;
const WORD_RE = /\p{L}+/gu;
const SOFT_HYPHEN = '\u00AD';

// Offsets inside the word text `word` (starting at `start` in the paragraph)
// where a line may break, and whether the break needs a hyphen drawn.
const wordBreaks = (
  word: string,
  start: number,
  hyphenator: Hyphenator | null,
): { offset: number; hyphen: boolean }[] => {
  const breaks: { offset: number; hyphen: boolean }[] = [];
  const hasSoftHyphen = word.includes(SOFT_HYPHEN);
  for (let i = 1; i < word.length - 1; i++) {
    const ch = word[i]!;
    if (ch === SOFT_HYPHEN) {
      // Break before the soft hyphen: it then starts the next line, where it
      // stays invisible, and the drawn hyphen is the only one.
      breaks.push({ offset: start + i, hyphen: true });
    } else if (HARD_HYPHEN.test(ch) && LETTER.test(word[i - 1]!) && LETTER.test(word[i + 1]!)) {
      breaks.push({ offset: start + i + 1, hyphen: false });
    }
  }
  if (hyphenator && !hasSoftHyphen) {
    for (const match of word.matchAll(WORD_RE)) {
      const letters = match[0];
      if (letters.length < MIN_HYPHENATE_LENGTH) continue;
      for (const offset of hyphenator(letters)) {
        if (offset < HYPHEN_MIN_BEFORE || letters.length - offset < HYPHEN_MIN_AFTER) continue;
        breaks.push({ offset: start + match.index + offset, hyphen: true });
      }
    }
  }
  return breaks.sort((a, b) => a.offset - b.offset);
};

// Box, glue and penalty items for a paragraph, measured in its current
// (unjustified, unhyphenated) layout.
const itemize = (
  paragraph: Paragraph,
  hyphenators: Map<string, Hyphenator | null>,
): Item[] | null => {
  const { el, text, entries } = paragraph;
  const doc = el.ownerDocument;
  const hyphenator = paragraph.hyphenate ? hyphenators.get(paragraph.lang)! : null;
  const items: Item[] = [];
  const boxExtents: Extent[][] = [];
  const pendingGlue: { glue: Glue; before: number }[] = [];

  const pushBox = (start: number, end: number) => {
    const extents = lineExtents(rangeOf(doc, entries, start, end));
    boxExtents.push(extents);
    const width = extents.reduce((sum, e) => sum + e.right - e.left, 0);
    items.push({ type: 'box', width, start, end });
  };

  const words = [...text.matchAll(/[^ \t\n\r\f]+/g)];
  if (words.length < 2) return null;
  words.forEach((match, w) => {
    const start = match.index;
    const word = match[0];
    if (w > 0) {
      const prev = words[w - 1]!;
      const glue: Glue = {
        type: 'glue',
        width: 0,
        stretch: 0,
        shrink: 0,
        start: prev.index + prev[0].length,
        end: start,
      };
      pendingGlue.push({ glue, before: boxExtents.length });
      items.push(glue);
    }
    let fragmentStart = start;
    for (const { offset, hyphen } of wordBreaks(word, start, hyphenator)) {
      if (offset <= fragmentStart) continue;
      pushBox(fragmentStart, offset);
      items.push({
        type: 'penalty',
        width: hyphen ? paragraph.hyphenWidth : 0,
        penalty: HYPHEN_PENALTY,
        flagged: true,
        offset,
        hyphen,
      });
      fragmentStart = offset;
    }
    pushBox(fragmentStart, start + word.length);
  });

  // A space is as wide as the gap between the boxes around it when both sit
  // on the same line; otherwise take the paragraph's typical space.
  const measured: number[] = [];
  const gapWidth = ({ before }: { before: number }): number | null => {
    const prev = boxExtents[before - 1]?.at(-1);
    const next = boxExtents[before]?.[0];
    if (!prev || !next) return null;
    const mid = (next.top + next.bottom) / 2;
    if (mid < prev.top || mid > prev.bottom) return null;
    return next.left - prev.right;
  };
  for (const pending of pendingGlue) {
    const width = gapWidth(pending);
    if (width !== null && width > 0) measured.push(width);
  }
  measured.sort((a, b) => a - b);
  const style = doc.defaultView!.getComputedStyle(el);
  const typical = measured[measured.length >> 1] ?? parseFloat(style.fontSize) / 4;
  for (const pending of pendingGlue) {
    const width = gapWidth(pending);
    const glueWidth = width !== null && width > 0 ? width : typical;
    // Stretch by half like TeX. No shrink: the engine justifies the lines,
    // and it only ever widens spaces.
    pending.glue.width = glueWidth;
    pending.glue.stretch = glueWidth / 2;
  }

  const body = paragraph.ragged
    ? toRagged(items, RAGGED_STRETCH_EM * parseFloat(style.fontSize))
    : items;
  return [...body, ...(paragraphEnd() as Item[])];
};

// Every space and hyphenation point becomes a line end that may take up to
// `stretch` of white space, while the spaces themselves keep their width.
const toRagged = (items: Item[], stretch: number): Item[] =>
  items.flatMap((item): Item[] => {
    if (item.type === 'glue' && 'start' in item) {
      const space: Penalty = {
        type: 'penalty',
        width: 0,
        penalty: 0,
        flagged: false,
        offset: item.start,
        hyphen: false,
      };
      return raggedBreak(space, stretch, item.width);
    }
    if (item.type === 'penalty') return raggedBreak(item, stretch);
    return [item];
  });

const makeElement = (doc: Document, className: string): HTMLElement => {
  const el = doc.createElement('span');
  el.className = className;
  el.setAttribute('cfi-inert', '');
  el.setAttribute('aria-hidden', 'true');
  return el;
};

// Insert `inserted` before the character at `offset`, splitting its text node in
// place. Callers go from the end of the paragraph backwards, so the entries of
// earlier offsets still describe the (now shorter) original nodes.
const insertAt = (entries: TextEntry[], offset: number, inserted: Node) => {
  const { node, offset: local } = locate(entries, offset);
  const target = local > 0 ? node.splitText(local) : node;
  target.parentNode!.insertBefore(inserted, target);
};

const applyBreaks = (paragraph: Paragraph, items: Item[], breaks: KPBreak[]): SetParagraph => {
  const { el, entries } = paragraph;
  const doc = el.ownerDocument;
  const insertions: { offset: number; marker: HTMLElement }[] = [];
  const lines: Line[] = [];
  let start = 0;
  breaks.slice(0, -1).forEach(({ position }, index) => {
    while (start < position && items[start]!.type !== 'box') start++;
    const firstBox = items[start] as Box;
    let end: Box | HTMLElement = firstBox;
    for (let i = start; i < position; i++) {
      const item = items[i]!;
      if (item.type === 'box') end = item as Box;
    }
    const item = items[position]!;
    if (item.type === 'glue' && 'start' in item) {
      // Before the space, so the space starts the next line, where the engine
      // drops it: after it, the space would end this line short of the edge.
      insertions.push({ offset: item.start, marker: makeElement(doc, KP_BREAK_CLASS) });
    } else if (item.type === 'penalty' && 'hyphen' in item) {
      const marker = makeElement(doc, item.hyphen ? KP_HYPHEN_CLASS : KP_BREAK_CLASS);
      if (item.hyphen) end = marker;
      insertions.push({ offset: item.offset, marker });
    }
    lines.push({ firstBox, end, width: paragraph.width - (index === 0 ? paragraph.indent : 0) });
    start = position + 1;
  });
  // Back to front, so the entries of earlier offsets stay valid.
  insertions
    .sort((a, b) => b.offset - a.offset)
    .forEach(({ offset, marker }) => insertAt(entries, offset, marker));
  el.classList.add(KP_PARAGRAPH_CLASS);
  return { el, lines };
};

const revertParagraph = (el: HTMLElement) => {
  el.querySelectorAll(INSERTED_SELECTOR).forEach((node) => node.remove());
  el.classList.remove(KP_PARAGRAPH_CLASS);
  el.normalize();
};

/** Remove every Knuth–Plass break from the document. */
export const clearKnuthPlass = (doc: Document) => {
  doc.querySelectorAll<HTMLElement>(`.${KP_PARAGRAPH_CLASS}`).forEach(revertParagraph);
};

// Measuring can be off a little (kerning across spaces, inline padding). A
// line that came out longer than the measure cannot wrap, and would run past
// the edge of the page: leave such a paragraph to the engine.
const fitsMeasure = ({ el, lines }: SetParagraph): boolean => {
  const doc = el.ownerDocument;
  const { entries } = collectEntries(el);
  return lines.every((line) => {
    const head = lineExtents(
      rangeOf(doc, entries, line.firstBox.start, line.firstBox.start + 1),
    )[0];
    const tail =
      // Not `instanceof HTMLElement`: the span belongs to the book's frame.
      (
        'nodeType' in line.end
          ? [...line.end.getClientRects()]
          : lineExtents(rangeOf(doc, entries, line.end.end - 1, line.end.end))
      ).at(-1);
    return !!head && !!tail && tail.right - head.left <= line.width + 0.5;
  });
};

const STYLE_ID = 'readest-kp-style';
const STYLES = `
  :root .${KP_MEASURE_CLASS}.${KP_MEASURE_CLASS} {
    text-align: left !important;
    -webkit-hyphens: manual !important;
    hyphens: manual !important;
    hanging-punctuation: none !important;
  }
  :root .${KP_PARAGRAPH_CLASS}.${KP_PARAGRAPH_CLASS} {
    white-space: nowrap !important;
    text-align-last: auto !important;
    hanging-punctuation: none !important;
  }
  .${KP_BREAK_CLASS}::after {
    content: '\\200B';
    white-space: normal;
  }
  .${KP_HYPHEN_CLASS}::after {
    content: '-\\200B';
    white-space: normal;
  }
`;

const ensureStyles = (doc: Document) => {
  if (!doc.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.append(style);
};

// Set `paragraphs`, reading and writing the layout in bulk: one measuring
// pass over them all, one pass inserting the breaks, one checking them, so
// each batch costs a few layouts rather than a few per paragraph.
const setParagraphs = (paragraphs: Paragraph[], hyphenators: Map<string, Hyphenator | null>) => {
  if (paragraphs.length === 0) return;

  // Measure at natural spacing with no engine hyphenation.
  paragraphs.forEach(({ el }) => el.classList.add(KP_MEASURE_CLASS));
  const itemized = paragraphs.map((paragraph) => itemize(paragraph, hyphenators));
  paragraphs.forEach(({ el }) => el.classList.remove(KP_MEASURE_CLASS));

  const set: SetParagraph[] = [];
  paragraphs.forEach((paragraph, i) => {
    const items = itemized[i];
    if (!items) return;
    const lineWidth = (line: number) =>
      paragraph.width - SLACK_PX - (line === 0 ? paragraph.indent : 0);
    for (const tolerance of TOLERANCES) {
      const breaks = breakLines(items, lineWidth, { tolerance });
      if (!breaks) continue;
      if (breaks.length > 1) set.push(applyBreaks(paragraph, items, breaks));
      break;
    }
  });

  set.filter((paragraph) => !fitsMeasure(paragraph)).forEach(({ el }) => revertParagraph(el));
};

/**
 * Set every eligible paragraph of `doc` with Knuth–Plass breaks at once,
 * replacing any earlier run. The reader goes through manageKnuthPlass, which
 * does the same in batches without blocking the page.
 */
export const applyKnuthPlass = (
  doc: Document,
  { lang = '', hyphenators = new Map<string, Hyphenator | null>() } = {},
) => {
  clearKnuthPlass(doc);
  ensureStyles(doc);
  setParagraphs(findParagraphs(doc, lang, hyphenators), hyphenators);
};

// The paragraphs in the order the reader needs them: those on screen, then
// the ones before them, nearest first (setting those shifts the page, so get
// it over with), then the ones after. Returns how many are on screen.
const inReadingOrder = (doc: Document, paragraphs: Paragraph[]) => {
  const win = doc.defaultView!;
  // The part of the section's frame the app window shows, in frame coordinates.
  const frame = win.frameElement?.getBoundingClientRect();
  const view = {
    left: Math.max(0, -(frame?.left ?? 0)),
    top: Math.max(0, -(frame?.top ?? 0)),
    right: Math.min(
      win.innerWidth,
      (win.parent?.innerWidth ?? win.innerWidth) - (frame?.left ?? 0),
    ),
    bottom: Math.min(
      win.innerHeight,
      (win.parent?.innerHeight ?? win.innerHeight) - (frame?.top ?? 0),
    ),
  };
  const onScreen = (el: HTMLElement) =>
    [...el.getClientRects()].some(
      (r) =>
        r.right > view.left && r.left < view.right && r.bottom > view.top && r.top < view.bottom,
    );
  let first = paragraphs.findIndex(({ el }) => onScreen(el));
  if (first < 0) first = 0;
  let last = first;
  while (last + 1 < paragraphs.length && onScreen(paragraphs[last + 1]!.el)) last++;
  return {
    ordered: [
      ...paragraphs.slice(first, last + 1),
      ...paragraphs.slice(0, first).reverse(),
      ...paragraphs.slice(last + 1),
    ],
    visible: last + 1 - first,
  };
};

// What the lines are measured against. Only properties that need no layout to
// read, so checking costs a style recalc and not a reflow of the whole
// section; the widths come from the ResizeObserver instead.
const layoutSignature = (doc: Document, samples: Element[], widths: string): string => {
  const win = doc.defaultView;
  if (!win || !doc.body) return '';
  return [doc.body, ...samples]
    .map((el) => {
      const s = win.getComputedStyle(el);
      return [
        fontOf(s),
        s.lineHeight,
        s.wordSpacing,
        s.letterSpacing,
        s.textIndent,
        s.textAlign,
        s.hyphens,
        s.fontVariant,
        s.textTransform,
      ].join(',');
    })
    .concat(widths)
    .join('|');
};

type Controller = {
  lang: string;
  destroy: () => void;
  refresh: () => void;
};

const controllers = new WeakMap<Document, Controller>();

// A batch runs for about this long before the page gets a turn again.
const BATCH_MS = 8;
// After a style change (a slider being dragged), wait this long for it to
// settle before setting the paragraphs again.
const RESTYLE_DELAY_MS = 150;

const createController = (doc: Document, lang: string): Controller => {
  const win = doc.defaultView!;
  let signature = '';
  let samples: Element[] = [];
  // Widths of the body and the samples, read where layout is fresh anyway.
  const readWidths = () => [doc.body, ...samples].map((el) => el?.clientWidth).join(',');
  let widths = readWidths();
  let frame = 0;
  let timer = 0;
  // Bumped whenever a run in progress is superseded or the controller stops.
  let generation = 0;
  const hyphenators = new Map<string, Hyphenator | null>();

  const run = async () => {
    const current = generation;
    const superseded = () => current !== generation;
    // Hyphenation patterns load once per language in the section.
    const langs = new Set(
      [...doc.querySelectorAll<HTMLElement>('[lang], html')].map((el) =>
        langOf(el, controller.lang),
      ),
    );
    langs.add(controller.lang);
    await Promise.all(
      [...langs]
        .filter((l) => l && !hyphenators.has(l))
        .map(async (l) => hyphenators.set(l, await loadHyphenator(l))),
    );
    await doc.fonts?.ready;
    if (superseded()) return;
    ensureStyles(doc);
    const { ordered, visible } = inReadingOrder(
      doc,
      findParagraphs(doc, controller.lang, hyphenators),
    );
    // What is on screen goes first and in one piece; the rest in batches
    // sized to BATCH_MS, yielding to the page in between.
    let size = Math.max(visible, 1);
    for (let i = 0; i < ordered.length; ) {
      const started = performance.now();
      setParagraphs(ordered.slice(i, i + size), hyphenators);
      i += size;
      const elapsed = Math.max(performance.now() - started, 1);
      size = Math.max(1, Math.round((size * BATCH_MS) / elapsed));
      // The app's timer, not the section frame's: engines throttle timers in
      // frames that are off screen, as preloaded sections are.
      await new Promise((resolve) => setTimeout(resolve));
      if (superseded()) return;
    }
    samples.forEach((el) => resizeObserver.unobserve(el));
    samples = [...doc.querySelectorAll(`.${KP_PARAGRAPH_CLASS}`)].slice(0, 3);
    samples.forEach((el) => resizeObserver.observe(el));
    widths = readWidths();
    signature = layoutSignature(doc, samples, widths);
  };

  // Our own insertions resize the body too; only a change in what the lines
  // are measured against (width, font, spacing) warrants setting them again.
  // Breaks set for the old layout no longer fit, so they go right away; the
  // new ones follow once the change settles.
  const check = () => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
    const next = layoutSignature(doc, samples, widths);
    if (next === signature) return;
    const first = signature === '';
    signature = next;
    generation++;
    clearKnuthPlass(doc);
    win.clearTimeout(timer);
    timer = win.setTimeout(run, first ? 0 : RESTYLE_DELAY_MS);
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(check);
  };

  const resizeObserver = new win.ResizeObserver(() => {
    widths = readWidths();
    schedule();
  });
  resizeObserver.observe(doc.documentElement);
  if (doc.body) resizeObserver.observe(doc.body);
  // A stylesheet change is checked right away, before the engine lays out the
  // old breaks under the new style only for them to be cleared.
  const mutationObserver = new win.MutationObserver(check);
  if (doc.head) {
    mutationObserver.observe(doc.head, { childList: true, subtree: true, characterData: true });
  }
  doc.fonts?.addEventListener('loadingdone', schedule);

  const controller: Controller = {
    lang,
    refresh: () => {
      signature = '';
      schedule();
    },
    destroy: () => {
      generation++;
      win.clearTimeout(timer);
      if (frame) win.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      doc.fonts?.removeEventListener('loadingdone', schedule);
      clearKnuthPlass(doc);
      doc.getElementById(STYLE_ID)?.remove();
    },
  };
  return controller;
};

/**
 * Turn Knuth–Plass line breaking on or off for a loaded section. While on, the
 * paragraphs are set again whenever the page width or text style changes.
 * `lang` is the book's language, used where the markup declares none.
 */
export const manageKnuthPlass = (doc: Document, enabled: boolean, lang = '') => {
  const existing = controllers.get(doc);
  if (!enabled) {
    existing?.destroy();
    controllers.delete(doc);
    return;
  }
  if (!doc.defaultView || !doc.documentElement) return;
  const controller = existing ?? createController(doc, lang);
  controller.lang = lang;
  controllers.set(doc, controller);
  controller.refresh();
};
