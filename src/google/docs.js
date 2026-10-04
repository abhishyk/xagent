// Google Docs / Drive API access + conversion of the Docs JSON structure into
// ordered blocks that preserve headings, lists, tables and code formatting.

import { getAccessToken } from './auth.js';

export class GoogleApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function friendlyGoogleError(status, id, body) {
  if (status === 403) return `Permission denied for document ${id}. Share it (Viewer) with the service account email, and make sure the Google Docs API is enabled.`;
  if (status === 404) return `Document ${id} not found. Check the ID in GOOGLE_DOCUMENT_IDS and that it is shared with the service account.`;
  if (status === 429) return 'Google API rate limit reached. Try again in a minute.';
  return `Google API error ${status}: ${String(body).slice(0, 160)}`;
}

async function googleGet(env, url, id) {
  const token = await getAccessToken(env);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GoogleApiError(res.status, friendlyGoogleError(res.status, id, body));
  }
  return res.json();
}

// Cheap change check (no document download). Needs drive.metadata.readonly and
// the Drive API enabled; callers fall back to a full fetch if it fails.
export async function fetchDriveMeta(env, id) {
  return googleGet(env,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,modifiedTime,version,trashed&supportsAllDrives=true`,
    id);
}

export async function fetchDocument(env, id) {
  return googleGet(env,
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}?includeTabsContent=true`,
    id);
}

export function docUrl(id) {
  return `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`;
}

// ---------------------------------------------------------------------------
// Docs JSON -> blocks
// block = { type: 'heading'|'paragraph'|'list'|'code'|'table', text, level?, headingId?, language? }

const MONO_FONTS = /^(courier|courier new|consolas|monaco|menlo|roboto mono|source code pro|inconsolata|fira code|fira mono|jetbrains mono|ubuntu mono|droid sans mono|dejavu sans mono|lucida console|space mono|ibm plex mono|cousine|anonymous pro|pt mono|oxygen mono|noto sans mono|overpass mono|red hat mono|sometype mono)$/i;

function isMono(textStyle) {
  const f = textStyle?.weightedFontFamily?.fontFamily || textStyle?.fontFamily;
  return !!f && MONO_FONTS.test(f.trim());
}

function paragraphText(p) {
  let text = '';
  let mono = 0;
  let visible = 0;
  for (const el of p.elements || []) {
    let t = '';
    if (el.textRun) {
      t = el.textRun.content || '';
      // Keep the real URL when the visible link text is different ("click here").
      const url = el.textRun.textStyle?.link?.url;
      if (url && /^https?:\/\//i.test(url) && !t.includes(url)) {
        const nl = t.endsWith('\n') ? '\n' : '';
        t = `${t.replace(/\n$/, '')} (${url})${nl}`;
      }
    }
    else if (el.richLink) t = el.richLink.richLinkProperties?.title || el.richLink.richLinkProperties?.uri || '';
    else if (el.person) t = el.person.personProperties?.name || el.person.personProperties?.email || '';
    else if (el.dateElement) t = el.dateElement.dateElementProperties?.displayText || '';
    else if (el.equation) t = '[equation]';
    if (!t) continue;
    text += t;
    const vis = t.replace(/\s/g, '').length;
    visible += vis;
    if (el.textRun && isMono(el.textRun.textStyle)) mono += vis;
  }
  // Docs uses \u000b (vertical tab) for soft line breaks inside a paragraph.
  text = text.replace(/\u000b/g, '\n').replace(/\n$/, '');
  return { text, monoRatio: visible ? mono / visible : 0 };
}

// TITLE is level 0 so HEADING_1 sections nest under the document title.
// Returns null for non-heading paragraphs (SUBTITLE is treated as text).
function headingLevel(style) {
  const t = style?.namedStyleType || '';
  if (t === 'TITLE') return 0;
  const m = t.match(/^HEADING_(\d)$/);
  return m ? Math.min(6, parseInt(m[1], 10)) : null;
}

function tableToBlocks(table) {
  const rows = table.tableRows || [];
  const cellTexts = rows.map((r) => (r.tableCells || []).map((cell) => {
    const parts = [];
    let mono = 0; let n = 0;
    for (const se of cell.content || []) {
      if (se.paragraph) {
        const { text, monoRatio } = paragraphText(se.paragraph);
        parts.push(text);
        if (text.trim()) { n++; mono += monoRatio; }
      }
    }
    return { text: parts.join('\n'), monoRatio: n ? mono / n : 0 };
  }));
  // A 1x1 table whose content is monospaced = a "code box" (common way to paste code in Docs).
  if (cellTexts.length === 1 && cellTexts[0].length === 1 && cellTexts[0][0].monoRatio >= 0.6) {
    return [{ type: 'code', text: cellTexts[0][0].text }];
  }
  const lines = cellTexts.map((r) => `| ${r.map((c) => c.text.replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()).join(' | ')} |`);
  if (lines.length > 1) {
    const cols = cellTexts[0].length;
    lines.splice(1, 0, `|${' --- |'.repeat(cols)}`);
  }
  return [{ type: 'table', text: lines.join('\n') }];
}

function contentToRawBlocks(content, out, tabId = null) {
  for (const se of content || []) {
    if (se.paragraph) {
      const p = se.paragraph;
      const { text, monoRatio } = paragraphText(p);
      const level = headingLevel(p.paragraphStyle);
      if (level !== null && text.trim()) {
        out.push({ type: 'heading', level, text: text.trim(), headingId: p.paragraphStyle?.headingId || null, tabId });
      } else if (p.bullet) {
        const depth = p.bullet.nestingLevel || 0;
        out.push({ type: 'list', text: `${'  '.repeat(depth)}- ${text.trim()}`, mono: monoRatio >= 0.8 });
      } else {
        out.push({ type: 'paragraph', text, mono: monoRatio >= 0.8 && text.trim().length > 0 });
      }
    } else if (se.table) {
      out.push(...tableToBlocks(se.table));
    }
    // sectionBreak / tableOfContents are ignored.
  }
}

// Each tab becomes a section. Tab headings get negative levels (-100 + depth) so
// the Title/Heading 1–6 inside a tab nest under it and child tabs nest under
// their parent tab. Tabs whose title is in `exclude` (and their child tabs) are skipped.
function collectTabs(tabs, out, depth = 0, exclude = new Set()) {
  for (const tab of tabs || []) {
    const title = (tab.tabProperties?.title || '').trim();
    if (title && exclude.has(title.toLowerCase())) continue;
    const tabId = tab.tabProperties?.tabId || null;
    const body = tab.documentTab?.body?.content;
    if (title && (tabs.length > 1 || depth > 0)) {
      out.push({ type: 'heading', level: -100 + depth, text: title, headingId: null, tabId, tab: true });
    }
    contentToRawBlocks(body, out, tabId);
    collectTabs(tab.childTabs, out, depth + 1, exclude);
  }
}

export function parseExcludeTabs(raw) {
  return new Set(String(raw || '').split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

const CODE_LINE_HINTS = [
  /^\s*(#include|#define|#if|#endif|import |from \S+ import|package |using |namespace )/,
  /^\s*(public|private|protected|static|def|class|struct|function|func|fn|async|const|let|var|return|if|else|for|while|switch|case|try|catch|echo|export)\b.*[({:;=]\s*$/,
  /[;{}]\s*$/,
  /^\s*(\}|\{|\)|end|fi|done|esac)\s*;?\s*$/,
  /^\s*(\/\/|\/\*|\*\/|# )/,
  /^\s{4,}\S/,
  /^\s*[A-Za-z_][\w.]*\s*=\s*\S+\s*$/,
  /^\s*<\/?[a-zA-Z][\w:-]*[^>]*>\s*$/,
];

export function looksLikeCode(line) {
  if (!line.trim()) return false;
  return CODE_LINE_HINTS.some((re) => re.test(line));
}

// Merge consecutive monospace paragraphs and ``` fenced regions into code blocks.
// In source_code documents, runs of code-looking plain paragraphs are also merged.
function mergeCode(raw, docType) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const b = raw[i];
    // Literal ``` fences typed into the document.
    const fence = b.type === 'paragraph' && b.text.trim().match(/^```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const lines = [];
      let j = i + 1;
      while (j < raw.length && !(raw[j].type === 'paragraph' && /^```\s*$/.test(raw[j].text.trim()))) {
        lines.push(raw[j].text);
        j++;
      }
      out.push({ type: 'code', text: lines.join('\n'), language: fence[1] || null });
      i = j + 1;
      continue;
    }
    // A single paragraph can itself contain a fenced block (soft line breaks).
    if (b.type === 'paragraph') {
      const m = b.text.match(/^```\s*([\w+#.-]*)\n([\s\S]*?)\n```\s*$/);
      if (m) { out.push({ type: 'code', text: m[2], language: m[1] || null }); i++; continue; }
    }
    const isCodeish = (x) => x.type === 'paragraph' && (x.mono || (docType === 'source_code' && looksLikeCode(x.text)));
    if (isCodeish(b) || (b.type === 'paragraph' && b.mono)) {
      const lines = [];
      let j = i;
      // Allow blank paragraphs inside a code run.
      while (j < raw.length && (isCodeish(raw[j]) || (raw[j].type === 'paragraph' && !raw[j].text.trim() && j + 1 < raw.length && isCodeish(raw[j + 1])))) {
        lines.push(raw[j].text);
        j++;
      }
      const monoRun = raw.slice(i, j).some((x) => x.mono);
      if (lines.length >= 2 || monoRun) {
        out.push({ type: 'code', text: lines.join('\n'), language: null });
        i = j;
        continue;
      }
    }
    if (b.type === 'code') { out.push(b); i++; continue; }
    if ((b.type === 'paragraph' || b.type === 'list') && !b.text.trim()) { i++; continue; }
    const { mono, ...rest } = b;
    out.push(rest);
    i++;
  }
  return out;
}

export function documentToBlocks(doc, docType = 'handbook', { excludeTabs = new Set() } = {}) {
  const raw = [];
  if (Array.isArray(doc.tabs) && doc.tabs.length) collectTabs(doc.tabs, raw, 0, excludeTabs);
  else contentToRawBlocks(doc.body?.content, raw);
  return mergeCode(raw, docType);
}
