import { afterEach, describe, expect, it } from 'vitest';
import * as CFI from 'foliate-js/epubcfi.js';
import {
  applyKnuthPlass,
  clearKnuthPlass,
  KP_BREAK_CLASS,
  KP_GAP_CLASS,
  KP_HYPHEN_CLASS,
  KP_PARAGRAPH_CLASS,
  manageKnuthPlass,
} from '@/utils/knuthPlassLayout';
import { loadHyphenator } from '@/utils/hyphenator';

const TEXT =
  'In olden times when wishing still helped one, there lived a king whose daughters ' +
  'were all beautiful; and the youngest was so beautiful that the sun itself, which ' +
  'has seen so much, was astonished whenever it shone in her face. Close by the ' +
  "king's castle lay a great dark forest, and under an old lime-tree in the forest " +
  'was a well, and when the day was very warm, the king’s child went out into the ' +
  'forest and sat down by the side of the cool fountain; and when she was bored she ' +
  'took a golden ball, and threw it up on high and caught it; and this ball was her ' +
  'favorite plaything.';

const STYLE = `
  body { margin: 0; font: 18px/1.5 serif; }
  p { width: 280px; margin: 0 0 1em; text-align: justify; text-indent: 1.5em; hyphens: auto; }
`;

let iframe: HTMLIFrameElement | null = null;

const makeDoc = async (body: string): Promise<Document> => {
  iframe = document.createElement('iframe');
  iframe.style.cssText = 'width: 600px; height: 800px; border: 0';
  document.body.append(iframe);
  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(
    `<!doctype html><html lang="en"><head><style>${STYLE}</style></head><body>${body}</body></html>`,
  );
  doc.close();
  await doc.fonts.ready;
  return doc;
};

afterEach(() => {
  iframe?.remove();
  iframe = null;
});

// Rendered lines of an element: [left, right] of the text on each line box.
const renderedLines = (el: HTMLElement) => {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  const lines: { top: number; left: number; right: number }[] = [];
  for (const rect of range.getClientRects()) {
    if (rect.width === 0) continue;
    const line = lines.find((l) => Math.abs(l.top - rect.top) < rect.height / 2);
    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
    } else lines.push({ top: rect.top, left: rect.left, right: rect.right });
  }
  return lines.sort((a, b) => a.top - b.top);
};

describe('applyKnuthPlass', () => {
  it('sets a justified paragraph flush on both sides with forced breaks', async () => {
    const doc = await makeDoc(`<p>${TEXT}</p>`);
    const p = doc.querySelector('p')!;
    applyKnuthPlass(doc, { lang: 'en' });

    expect(p.classList.contains(KP_PARAGRAPH_CLASS)).toBe(true);
    const breaks = p.querySelectorAll(`.${KP_BREAK_CLASS}`);
    expect(breaks.length).toBeGreaterThan(3);

    const lines = renderedLines(p);
    // One line per forced break, plus the last line.
    expect(lines.length).toBe(breaks.length + 1);
    const contentRight = p.getBoundingClientRect().right;
    for (const line of lines.slice(0, -1)) {
      expect(Math.abs(contentRight - line.right)).toBeLessThan(0.75);
    }
    // The last line keeps its natural width.
    expect(lines.at(-1)!.right).toBeLessThan(contentRight - 1);
  });

  it('keeps the text, CFIs and a live range untouched', async () => {
    const doc = await makeDoc(
      `<p>${TEXT} <em>An emphasized tail that runs on for a while.</em></p>`,
    );
    const p = doc.querySelector('p')!;
    const textBefore = p.textContent;
    const htmlBefore = p.innerHTML;
    const em = p.querySelector('em')!.firstChild as Text;
    const range = doc.createRange();
    range.setStart(p.firstChild!, 200);
    range.setEnd(em, 10);
    const cfiBefore = CFI.fromRange(range);
    const selected = range.toString();

    applyKnuthPlass(doc, { lang: 'en' });
    expect(p.querySelectorAll(`.${KP_GAP_CLASS}`).length).toBeGreaterThan(10);
    expect(p.textContent).toBe(textBefore);
    expect(range.toString()).toBe(selected);
    expect(CFI.fromRange(range)).toBe(cfiBefore);
    expect(CFI.toRange(doc, CFI.parse(cfiBefore)).toString()).toBe(selected);

    clearKnuthPlass(doc);
    expect(p.innerHTML).toBe(htmlBefore);
    expect(range.toString()).toBe(selected);
  });

  it('hyphenates with dictionary patterns and draws the hyphen', async () => {
    const hyphenator = await loadHyphenator('en');
    expect(hyphenator).not.toBeNull();
    const doc = await makeDoc(
      `<p style="width: 180px">${TEXT} Notwithstanding extraordinarily incomprehensible circumstances.</p>`,
    );
    const p = doc.querySelector('p')!;
    applyKnuthPlass(doc, { lang: 'en', hyphenators: new Map([['en', hyphenator]]) });
    const hyphens = p.querySelectorAll(`.${KP_HYPHEN_CLASS}`);
    expect(hyphens.length).toBeGreaterThan(0);
    expect(doc.defaultView!.getComputedStyle(hyphens[0]!, '::after').content).toBe('"-"');
    // Every hyphen sits at a line end.
    hyphens.forEach((hyphen) =>
      expect(hyphen.nextElementSibling?.classList.contains(KP_BREAK_CLASS)).toBe(true),
    );
  });

  it('leaves unjustified, verse and single-line paragraphs alone', async () => {
    const doc = await makeDoc(
      `<p style="text-align: left">${TEXT}</p><p>Line one<br>line two</p><p>Short.</p>`,
    );
    applyKnuthPlass(doc, { lang: 'en' });
    expect(doc.querySelectorAll(`.${KP_BREAK_CLASS}, .${KP_GAP_CLASS}`).length).toBe(0);
  });

  it('sets the paragraphs again when the width changes', async () => {
    const doc = await makeDoc(`<p>${TEXT}</p>`);
    const p = doc.querySelector('p')!;
    manageKnuthPlass(doc, true, 'en');
    await expect.poll(() => p.classList.contains(KP_PARAGRAPH_CLASS)).toBe(true);
    const before = p.querySelectorAll(`.${KP_BREAK_CLASS}`).length;
    doc.head.insertAdjacentHTML('beforeend', '<style>p { width: 420px !important }</style>');
    await expect
      .poll(() => {
        const count = p.querySelectorAll(`.${KP_BREAK_CLASS}`).length;
        return count > 0 && count < before;
      })
      .toBe(true);
    const contentRight = p.getBoundingClientRect().right;
    for (const line of renderedLines(p).slice(0, -1)) {
      expect(Math.abs(contentRight - line.right)).toBeLessThan(0.75);
    }
    manageKnuthPlass(doc, false);
    expect(doc.querySelectorAll(`.${KP_PARAGRAPH_CLASS}`).length).toBe(0);
  });
});
