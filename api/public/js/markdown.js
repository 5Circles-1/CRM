import { esc } from './util.js';

/**
 * A very small markdown renderer — enough for the training modules and
 * nothing more: headings, tables, lists, blockquotes, bold, italics, inline
 * code and links.
 *
 * Written rather than installed because this UI has no build step and no
 * dependencies, and because everything it renders is content we author
 * ourselves. Every value is escaped before any markup is added, so a stray
 * angle bracket in a rule cannot become a tag.
 */

const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, href) =>
      /^(https?:|#|\/)/i.test(href) ? `<a href="${esc(href)}">${text}</a>` : m);

const slugify = (s) =>
  s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

/** Split a markdown table row, dropping the empty edges from | a | b |. */
const cells = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function renderMarkdown(md) {
  const lines = String(md ?? '').split('\n');
  const out = [];
  let i = 0;

  const flushList = (tag, items) =>
    out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    // Heading
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length + 1; // h1 is the page title, start at h2
      const text = heading[2];
      out.push(`<h${level} id="s-${slugify(text)}">${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    // Table: a header row followed by a |---|---| separator
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        body.push(cells(lines[i]));
        i += 1;
      }
      out.push(`<div style="overflow-x:auto"><table class="table"><thead><tr>${
        head.map((c) => `<th>${inline(c)}</th>`).join('')
      }</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
      }</tbody></table></div>`);
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoted = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${inline(quoted.join(' '))}</blockquote>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ''));
        i += 1;
      }
      flushList('ol', items);
      continue;
    }

    // Unordered list
    if (/^[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s/, ''));
        i += 1;
      }
      flushList('ul', items);
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const para = [];
    while (
      i < lines.length && lines[i].trim()
      && !/^(#{1,4}\s|[-*]\s|\d+\.\s|>|\|)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

/** Headings in a module, for the on-page contents list. */
export function outline(md) {
  return String(md ?? '')
    .split('\n')
    .map((l) => /^(#{2,3})\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ depth: m[1].length, text: m[2], id: `s-${slugify(m[2])}` }));
}
