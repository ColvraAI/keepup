// The brief as markdown (the issue and the .md file) and as simple inline-styled HTML.
// No tracking, no remote images, nothing that needs a stylesheet.
import type { Brief } from './brief.ts';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LINK = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;
const A = 'color:#0b57d0;text-decoration:underline';

/** Escapes everything, then turns back only markdown links to https addresses. */
function inline(text: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    parts.push(esc(text.slice(last, match.index)), `<a href="${esc(match[2])}" style="${A}">${esc(match[1])}</a>`);
    last = match.index + match[0].length;
  }
  return [...parts, esc(text.slice(last))].join('');
}

const HEADING = {
  shipped: 'What shipped that touches this product',
  heldBack: 'Checked and held back',
  watching: 'Watching',
  team: 'Your team',
};

function itemMarkdown(item: Brief['items'][number], index: number): string {
  const head = `${index + 1}. ${item.plain} · ${item.effect} · ${item.proof} · effort: ${item.effort.toLowerCase()}`;
  const lines = item.details.map((d) => `   ${d}`);
  return [head, ...lines, ...(item.pr ? [`   → ${item.pr}`] : [])].join('\n');
}

const section = (title: string, body: string[], join = '\n'): string[] => (body.length ? [`**${title}**\n\n${body.join(join)}`] : []);
const bullets = (lines: string[]): string[] => lines.map((l) => `- ${l}`);

export function renderMarkdownBody(brief: Omit<Brief, 'body'>): string {
  if (brief.items.length + brief.heldBack.length + brief.watching.length + brief.team.length === 0) return brief.quietLine;
  return [
    ...section(HEADING.shipped, brief.items.map(itemMarkdown), '\n\n'),
    ...section(HEADING.heldBack, bullets(brief.heldBack)),
    ...section(HEADING.watching, bullets(brief.watching)),
    ...section(HEADING.team, bullets(brief.team)),
    brief.quietLine,
    `---\n\n${brief.note}`,
  ].join('\n\n');
}

export function renderMarkdownFile(brief: Brief): string {
  return `# ${brief.title}\n\n${brief.body}\n`;
}

const H2 = 'font-size:15px;margin:24px 0 8px;color:#111';
const P = 'margin:0 0 8px;color:#222';

function htmlSection(title: string, body: string): string {
  return `<h2 style="${H2}">${esc(title)}</h2>${body}`;
}

function htmlList(lines: string[]): string {
  return `<ul style="padding-left:20px;margin:0">${lines.map((l) => `<li style="margin:0 0 6px;color:#222">${inline(l)}</li>`).join('')}</ul>`;
}

function htmlItem(item: Brief['items'][number]): string {
  const head = `<p style="${P};font-weight:600">${inline(item.plain)} <span style="font-weight:400;color:#555">· ${esc(item.effect)} · ${esc(item.proof)} · effort: ${esc(item.effort.toLowerCase())}</span></p>`;
  const details = item.details.map((d) => `<p style="${P}">${inline(d)}</p>`).join('');
  const pr = item.pr ? `<p style="${P}">→ ${inline(item.pr)}</p>` : '';
  return `<div style="margin:0 0 16px">${head}${details}${pr}</div>`;
}

export function renderHtml(brief: Brief): string {
  const quiet = `<p style="margin:24px 0 8px;color:#222">${esc(brief.quietLine)}</p>`;
  const note = brief.note && brief.body !== brief.quietLine ? `<p style="margin:16px 0 0;font-size:12px;color:#777">${inline(brief.note)}</p>` : '';
  const sections = [
    brief.items.length ? htmlSection(HEADING.shipped, brief.items.map(htmlItem).join('')) : '',
    brief.heldBack.length ? htmlSection(HEADING.heldBack, htmlList(brief.heldBack)) : '',
    brief.watching.length ? htmlSection(HEADING.watching, htmlList(brief.watching)) : '',
    brief.team.length ? htmlSection(HEADING.team, htmlList(brief.team)) : '',
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(brief.title)}</title></head><body style="margin:0;padding:24px;background:#fff"><div style="max-width:600px;margin:0 auto;font:15px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif"><h1 style="font-size:20px;margin:0 0 16px;color:#111">${esc(brief.title)}</h1>${sections}${quiet}${note}</div></body></html>`;
}
