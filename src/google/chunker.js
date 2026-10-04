// Heading-aware chunking with code-block preservation and source-code metadata
// extraction (Spec §6, §7, §8). Chunk ids are content-addressed so unchanged
// chunks keep their id across syncs and are never re-embedded.

import { sha256Hex } from '../utils/crypto.js';
import { detectVersion } from '../utils/version.js';

const EXT_LANG = {
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', java: 'java',
  kt: 'kotlin', go: 'go', rs: 'rust', py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript',
  php: 'php', rb: 'ruby', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', bat: 'batch', cmd: 'batch',
  sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', html: 'html', css: 'css', ini: 'ini',
  conf: 'conf', cfg: 'conf', toml: 'toml', service: 'systemd', ipxe: 'ipxe', pxe: 'pxe', mk: 'make',
  cshtml: 'razor', aspx: 'aspx', vb: 'vbnet', lua: 'lua', pl: 'perl', swift: 'swift',
};

const FILE_RE = new RegExp(
  `(?:^|[\\s"'\`(\\[:])((?:~?/)?(?:[\\w.-]+/)*[\\w.-]+\\.(?:${Object.keys(EXT_LANG).join('|')}))(?=$|[\\s"'\`)\\],:;])`,
  'i'
);
const MAKEFILE_RE = /\b((?:[\w.-]+\/)*(?:Makefile|Dockerfile|Kconfig|CMakeLists\.txt))\b/;

export function detectFileName(text) {
  if (!text) return null;
  const explicit = String(text).match(/\b(?:file(?:name)?|path|source)\s*[:=]\s*`?([^\s`]+)`?/i);
  if (explicit && /[./]/.test(explicit[1])) return explicit[1].replace(/[),.;:]+$/, '');
  const m = String(text).match(FILE_RE) || String(text).match(MAKEFILE_RE);
  return m ? m[1] : null;
}

export function languageFromFile(fileName) {
  if (!fileName) return null;
  if (/Makefile$/i.test(fileName)) return 'make';
  if (/Dockerfile$/i.test(fileName)) return 'dockerfile';
  const ext = fileName.split('.').pop().toLowerCase();
  return EXT_LANG[ext] || null;
}

function guessLanguage(code) {
  if (/^\s*#!.*\b(ba|z)?sh\b/m.test(code)) return 'bash';
  if (/^\s*#include\s*[<"]/m.test(code)) return /\b(class|namespace|std::|template\s*<)/.test(code) ? 'cpp' : 'c';
  if (/\b[A-Za-z_]\w*::~?[A-Za-z_]\w*\s*\([^;]*\)\s*(const\s*)?\{/.test(code)) return 'cpp';
  if (/^\s*(def |import \w|from \w+ import)/m.test(code)) return 'python';
  if (/^\s*package \w+;?\s*$/m.test(code) && /\bfunc\b/.test(code)) return 'go';
  if (/\b(public|private)\s+(static\s+)?(class|void|int|String)\b/.test(code)) return /\busing System\b/.test(code) ? 'csharp' : 'java';
  if (/<\?php/.test(code)) return 'php';
  if (/\b(function|const|let)\b.*=>|\bconsole\.log\b|\brequire\(/.test(code)) return 'javascript';
  if (/^\s*\[[\w .-]+\]\s*$/m.test(code) && /=/.test(code)) return 'ini';
  if (/^\s*(DEFAULT|LABEL|KERNEL|APPEND|PROMPT|TIMEOUT)\b/m.test(code)) return 'pxelinux';
  if (/^#!ipxe/m.test(code)) return 'ipxe';
  return null;
}

const NOT_FUNCS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'elif', 'else', 'foreach', 'using', 'lock', 'typeof', 'new', 'delete', 'echo', 'print']);

export function extractCodeMeta(code, language) {
  const funcs = new Set();
  const classes = new Set();
  const add = (set, name) => { if (name && !NOT_FUNCS.has(name) && set.size < 10) set.add(name); };
  const patterns = [
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,                                    // python
    /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm,       // js
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm,
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm,                                // go
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm,                               // rust
    /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/gm,                               // shell
    /^[ \t]*(?:[\w:<>,*&\[\]]+[ \t]+)+[*&]*([A-Za-z_~][\w:~]*)[ \t]*\([^;{()]*\)[ \t]*(?:const[ \t]*)?(?:noexcept[ \t]*)?(?:override[ \t]*)?\{?[ \t]*$/gm, // C/C++/Java/C#
    /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+([A-Za-z_]\w*)\s*\(/gm, // php
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) {
      add(funcs, m[1]);
    }
  }
  for (const m of code.matchAll(/\b(?:class|struct|interface|enum|trait|impl)\s+([A-Za-z_]\w*)/g)) add(classes, m[1]);
  // Qualified C++ method definitions: Foo::bar(  -> class Foo
  for (const f of funcs) if (f.includes('::')) add(classes, f.split('::').slice(-2, -1)[0]);

  let module = null;
  const mod = code.match(/^\s*(?:package|namespace|module)\s+([\w.:]+)/m);
  if (mod) module = mod[1];

  return {
    functionName: funcs.size ? [...funcs].join(', ') : null,
    className: classes.size ? [...classes].join(', ') : null,
    module,
    language: language || guessLanguage(code),
  };
}

// ---------------------------------------------------------------------------

function splitLong(text, size, overlap) {
  // Split by paragraphs first, then sentences, then hard cut.
  const pieces = [];
  const paras = text.split(/\n{2,}/);
  let cur = '';
  const push = () => { if (cur.trim()) pieces.push(cur.trim()); cur = ''; };
  for (const p of paras) {
    if (p.length > size) {
      push();
      const sentences = p.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
      let s = '';
      for (const sen of sentences) {
        if (sen.length > size) {
          if (s) { pieces.push(s.trim()); s = ''; }
          for (let i = 0; i < sen.length; i += size - overlap) pieces.push(sen.slice(i, i + size));
        } else if ((s + ' ' + sen).length > size) {
          pieces.push(s.trim()); s = sen;
        } else s = s ? `${s} ${sen}` : sen;
      }
      if (s.trim()) pieces.push(s.trim());
    } else if ((cur + '\n\n' + p).length > size) {
      push(); cur = p;
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  push();
  // Add overlap from the previous piece for continuity.
  if (overlap > 0 && pieces.length > 1) {
    for (let i = pieces.length - 1; i > 0; i--) {
      const tail = pieces[i - 1].slice(-overlap);
      const cut = tail.indexOf(' ');
      const lead = cut >= 0 ? tail.slice(cut + 1) : tail;
      if (lead) pieces[i] = `…${lead}\n${pieces[i]}`;
    }
  }
  return pieces;
}

function splitCode(code, maxLen) {
  if (code.length <= maxLen) return [code];
  const lines = code.split('\n');
  const out = [];
  let cur = [];
  let len = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Prefer to break at a blank line or before a top-level definition.
    const boundary = !line.trim() || /^(\S.*\(.*\)\s*\{?\s*$|def |class |func |function )/.test(line);
    if (len + line.length + 1 > maxLen && cur.length) {
      out.push(cur.join('\n')); cur = []; len = 0;
    } else if (boundary && len > maxLen * 0.6 && cur.length) {
      out.push(cur.join('\n')); cur = []; len = 0;
    }
    if (line.length > maxLen) {
      for (let j = 0; j < line.length; j += maxLen) out.push(line.slice(j, j + maxLen));
      continue;
    }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) out.push(cur.join('\n'));
  return out.filter((s) => s.trim());
}

/**
 * Convert blocks into chunks.
 * @returns {Promise<Array>} chunks with id, index, type, heading, headingId, section,
 *   content, embedText, contentHash, version, fileName, language, className, functionName, module
 */
export async function chunkBlocks(blocks, { documentId, documentName, documentType, documentVersion, embeddingModel, chunkSize = 1800, chunkOverlap = 200 }) {
  const stack = []; // [{level, text, id}]
  const draft = [];
  let textBuf = [];
  let lastParagraph = '';

  const sectionPath = () => stack.map((h) => h.text).join(' > ');
  const current = () => stack[stack.length - 1] || null;
  // Deep-link anchor "tabId|headingId" (either part may be empty).
  const anchor = (h) => (h && (h.tabId || h.id) ? `${h.tabId || ''}|${h.id || ''}` : null);
  const sectionVersion = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const v = detectVersion(stack[i].text);
      if (v) return v;
    }
    return documentVersion || null;
  };
  const sectionFile = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = detectFileName(stack[i].text);
      if (f) return f;
    }
    return null;
  };

  const flushText = () => {
    const text = textBuf.join('\n\n').trim();
    textBuf = [];
    if (!text) return;
    const h = current();
    const headingLine = h ? `${'#'.repeat(Math.min(Math.max(h.level + 1, 1), 6))} ${h.text}\n` : '';
    for (const piece of splitLong(text, chunkSize, chunkOverlap)) {
      draft.push({
        type: 'text', heading: h?.text || null, headingId: anchor(h), section: sectionPath(),
        content: `${headingLine}${piece}`, version: sectionVersion(), fileName: null,
      });
    }
  };

  for (const b of blocks) {
    if (b.type === 'heading') {
      flushText();
      while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop();
      stack.push({ level: b.level, text: b.text, id: b.headingId || null, tabId: b.tabId || null });
      lastParagraph = '';
      continue;
    }
    if (b.type === 'code') {
      flushText();
      const h = current();
      const firstLine = b.text.split('\n', 1)[0];
      const fileName = detectFileName(lastParagraph) || detectFileName(firstLine) || sectionFile();
      const language = b.language || languageFromFile(fileName);
      for (const piece of splitCode(b.text, chunkSize * 2)) {
        const meta = extractCodeMeta(piece, language);
        const lead = lastParagraph && lastParagraph.length < 300 ? `${lastParagraph}\n` : '';
        draft.push({
          type: 'code', heading: h?.text || null, headingId: anchor(h), section: sectionPath(),
          content: `${lead}\`\`\`${meta.language || ''}\n${piece}\n\`\`\``,
          version: sectionVersion(), fileName, language: meta.language, className: meta.className,
          functionName: meta.functionName, module: meta.module || (fileName ? fileName.replace(/\.[^.]+$/, '') : null),
        });
      }
      lastParagraph = '';
      continue;
    }
    // paragraph / list / table
    textBuf.push(b.text);
    if (b.type === 'paragraph') lastParagraph = b.text.trim();
  }
  flushText();

  // Finalize: ids, hashes, embedding text. Duplicate chunks collapse to one id.
  const seen = new Set();
  const chunks = [];
  for (const d of draft) {
    const contentHash = await sha256Hex(d.content);
    const id = `c${(await sha256Hex(`${documentId}\u0000${d.section}\u0000${d.type}\u0000${d.content}\u0000${embeddingModel}`)).slice(0, 40)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const header = [
      `Document: ${documentName}`,
      `Type: ${documentType}`,
      d.section ? `Section: ${d.section}` : null,
      d.version ? `Version: ${d.version}` : null,
      d.fileName ? `File: ${d.fileName}` : null,
      d.functionName ? `Functions: ${d.functionName}` : null,
      d.className ? `Classes: ${d.className}` : null,
    ].filter(Boolean).join('\n');
    chunks.push({ ...d, id, index: chunks.length, contentHash, embedText: `${header}\n\n${d.content}`.slice(0, 8000) });
  }
  return chunks;
}
