// Minimal, XSS-safe Markdown renderer + lightweight syntax highlighter.
// All text is HTML-escaped BEFORE any markup is generated; only a fixed set of
// tags is ever produced, and links are restricted to http(s)/mailto.
(function (global) {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  // ---------- highlighting ----------
  const KEYWORDS = new Set((
    'if else elif for while do switch case break continue return function func fn def class struct enum interface ' +
    'public private protected static const let var new delete try catch finally throw throws import from export ' +
    'package namespace using include define ifdef ifndef endif void int long short char bool boolean float double ' +
    'unsigned signed auto true false null nullptr None True False self this async await yield lambda in is not and or ' +
    'then fi done esac local readonly virtual override extends implements typedef sizeof goto default'
  ).split(/\s+/));
  const SQL_KEYWORDS = new Set('select insert update delete where join create table into values set alter drop from and or not null'.split(' '));
  const HASH_COMMENT = new Set(['bash', 'sh', 'shell', 'zsh', 'python', 'py', 'yaml', 'yml', 'ini', 'conf', 'toml', 'ruby', 'rb',
    'perl', 'make', 'dockerfile', 'pxelinux', 'ipxe', 'systemd', 'powershell', 'ps1', '']);

  function highlight(code, lang) {
    const l = (lang || '').toLowerCase();
    const hash = HASH_COMMENT.has(l);
    const re = hash
      ? /(\/\*[\s\S]*?\*\/|#[^\n]*|\/\/[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|((?<![\w.])\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)/g
      : /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|--[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|((?<![\w.])\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)/g;
    let out = '';
    let last = 0;
    let m;
    if (code.length > 60000) return esc(code); // keep big pastes fast
    while ((m = re.exec(code))) {
      out += esc(code.slice(last, m.index));
      if (m[1] !== undefined) {
        // In C-like languages a leading "--" is only a comment for SQL/Lua.
        if (m[1].startsWith('--') && !/^(sql|lua)$/.test(l)) out += esc(m[1]);
        else out += `<span class="tok-com">${esc(m[1])}</span>`;
      } else if (m[2] !== undefined) out += `<span class="tok-str">${esc(m[2])}</span>`;
      else if (m[3] !== undefined) out += `<span class="tok-num">${esc(m[3])}</span>`;
      else out += (KEYWORDS.has(m[4]) || (l === 'sql' && SQL_KEYWORDS.has(m[4].toLowerCase()))) ? `<span class="tok-kw">${esc(m[4])}</span>` : esc(m[4]);
      last = re.lastIndex;
    }
    return out + esc(code.slice(last));
  }

  function codeBlock(code, lang) {
    const safeLang = (lang || '').replace(/[^\w+#.-]/g, '').slice(0, 24);
    return `<div class="code-block"><div class="code-head"><span>${esc(safeLang || 'code')}</span>` +
      `<button class="copy" type="button">Copy</button></div>` +
      `<pre><code>${highlight(code, safeLang)}</code></pre></div>`;
  }

  // ---------- inline ----------
  function inline(text) {
    const slots = [];
    const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    let s = String(text);
    s = s.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`));
    s = s.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, href) =>
      keep(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`));
    s = s.replace(/\[(S\d{1,2})\]/g, (_, l) => keep(`<span class="cite" title="Source ${esc(l)}">${esc(l)}</span>`));
    s = esc(s);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,:;!?]|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
  }

  // ---------- blocks ----------
  function renderBlocks(src) {
    const lines = src.split('\n');
    const out = [];
    let i = 0;
    const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        const lvl = Math.min(m[1].length, 4); // keep headings modest
        out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); i++; continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${renderBlocks(buf.join('\n'))}</blockquote>`); continue;
      }
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>');
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          const l = lines[i++];
          const im = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (im) items.push({ indent: im[1].length, text: im[3] });
          else items[items.length - 1].text += ` ${l.trim()}`;
        }
        const tag = ordered ? 'ol' : 'ul';
        let html = `<${tag}>`;
        const base = items[0].indent;
        for (const it of items) {
          const nested = it.indent > base + 1;
          html += `<li${nested ? ' class="nested"' : ''}>${inline(it.text)}</li>`;
        }
        out.push(`${html}</${tag}>`);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
             !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
        para.push(lines[i++]);
      }
      if (!para.length) { para.push(lines[i++]); }
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  function render(markdown) {
    const lines = String(markdown || '')
      .replace(/\r\n?/g, '\n')
      .replace(/【\s*(S\d{1,2})[^】]*】/g, '[$1]') // normalise 【S1】-style citations
      .split('\n');
    const parts = [];
    let buf = [];
    const flush = () => { if (buf.length) parts.push(renderBlocks(buf.join('\n'))); buf = []; };
    for (let i = 0; i < lines.length; i++) {
      const open = lines[i].match(/^\s{0,3}```[ \t]*([\w+#.-]*)/);
      if (!open) { buf.push(lines[i]); continue; }
      flush();
      const code = [];
      i++;
      // Unclosed fences (e.g. mid-stream) run to the end of the text.
      while (i < lines.length && !/^\s{0,3}```\s*$/.test(lines[i])) code.push(lines[i++]);
      parts.push(codeBlock(code.join('\n'), open[1]));
    }
    flush();
    return parts.join('');
  }

  // Copy buttons (event delegation; works for streamed content too).
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('.code-block .copy');
    if (!btn) return;
    const code = btn.closest('.code-block').querySelector('code').textContent;
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });

  global.SecMarkdown = { render, escape: esc, highlight };
})(window);
