import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { extractDelta, extractText, iterateSse } from '../src/ai/model.js';
import { buildContextBlock } from '../src/ai/prompts.js';
import { extractCodeMeta, detectFileName, chunkBlocks } from '../src/google/chunker.js';
import { detectVersion, versionsCompatible } from '../src/utils/version.js';
import { parseDocumentConfig } from '../src/google/sync.js';
import { looksLikeCode } from '../src/google/docs.js';

// Load the browser markdown renderer in a sandbox.
function loadMarkdown() {
  const sandbox = { window: {}, document: { addEventListener() {} }, navigator: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../public/markdown.js', import.meta.url), 'utf8'), sandbox);
  return sandbox.window.SecMarkdown;
}

describe('markdown renderer (XSS safety)', () => {
  const md = loadMarkdown();
  test('raw HTML is escaped', () => {
    const out = md.render('<img src=x onerror=alert(1)> <script>alert(1)</script>');
    assert.ok(!out.includes('<img'));
    assert.ok(!out.includes('<script'));
    assert.ok(out.includes('&lt;img'));
  });
  test('javascript: links are not linkified; http links get noopener', () => {
    const bad = md.render('[x](javascript:alert(1))');
    assert.ok(!bad.includes('href'));
    const good = md.render('[docs](https://docs.google.com/document/d/abc/edit)');
    assert.match(good, /href="https:\/\/docs\.google\.com\/document\/d\/abc\/edit" target="_blank" rel="noopener noreferrer"/);
  });
  test('attribute injection via link URL is escaped', () => {
    const out = md.render('[a](https://x.com/"onmouseover="alert(1))');
    assert.ok(!/"onmouseover="/.test(out));
  });
  test('code blocks: escaped, highlighted, copy button, unclosed fence while streaming', () => {
    const out = md.render('```cpp\nif (a < b) { return "<x>"; } // done\n```');
    assert.match(out, /class="code-block"/);
    assert.match(out, /<button class="copy"/);
    assert.match(out, /&lt; b/);
    assert.match(out, /tok-kw">if</);
    assert.match(out, /tok-com">\/\/ done/);
    const partial = md.render('Text\n```bash\necho hi');
    assert.match(partial, /<p>Text<\/p><div class="code-block">/);
  });
  test('citations, lists, tables, headings', () => {
    const out = md.render('# Title\n- one [S1]\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    assert.match(out, /<h1>Title<\/h1>/);
    assert.match(out, /<ul><li>one <span class="cite"/);
    assert.match(out, /<table><thead><tr><th>a<\/th>/);
  });
});

describe('Workers AI response parsing', () => {
  test('stream delta shapes; reasoning ignored', () => {
    assert.equal(extractDelta({ response: 'a' }), 'a');
    assert.equal(extractDelta({ choices: [{ delta: { content: 'b' } }] }), 'b');
    assert.equal(extractDelta({ choices: [{ delta: { reasoning_content: 'hidden' } }] }), '');
    assert.equal(extractDelta({ type: 'response.output_text.delta', delta: 'c' }), 'c');
    assert.equal(extractDelta({ type: 'response.reasoning_text.delta', delta: 'hidden' }), '');
  });
  test('non-stream shapes', () => {
    assert.equal(extractText({ response: 'x' }), 'x');
    assert.equal(extractText({ choices: [{ message: { content: 'y' } }] }), 'y');
    assert.equal(extractText({ output: [{ type: 'reasoning', content: [{ text: 'no' }] }, { type: 'message', content: [{ type: 'output_text', text: 'z' }] }] }), 'z');
  });
  test('SSE parser handles split chunks and [DONE]', async () => {
    const enc = new TextEncoder();
    const parts = ['data: {"response":"Hel', 'lo"}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n', '\ndata: [DONE]\n\n'];
    const stream = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } });
    let out = '';
    for await (const d of iterateSse(stream)) out += d;
    assert.equal(out, 'Hello world');
  });
});

describe('chunking & metadata', () => {
  test('code metadata extraction', () => {
    const c = extractCodeMeta('namespace secure.boot;\nint PxeServer::checkMac(const char* mac) {\n  return 0;\n}\nclass DhcpWatcher {};', null);
    assert.match(c.functionName, /PxeServer::checkMac/);
    assert.match(c.className, /PxeServer/);
    assert.match(c.className, /DhcpWatcher/);
    assert.equal(c.module, 'secure.boot');
    assert.equal(c.language, 'cpp');
    assert.match(extractCodeMeta('#!/bin/bash\nsetup_tftp() {\n  echo ok\n}', null).functionName, /setup_tftp/);
  });
  test('file name detection', () => {
    assert.equal(detectFileName('File: src/boot/boot_manager.cpp'), 'src/boot/boot_manager.cpp');
    assert.equal(detectFileName('Edit /etc/dnsmasq.conf then restart'), '/etc/dnsmasq.conf');
    assert.equal(detectFileName('No file here.'), null);
  });
  test('version detection & compatibility', () => {
    assert.equal(detectVersion('AcmeOS 2.x Deployment Handbook'), '2.x');
    assert.equal(detectVersion('Release notes – version: 3.1.4'), '3.1.4');
    assert.equal(detectVersion('Nothing'), null);
    assert.equal(versionsCompatible('2.x', '2.4'), true);
    assert.equal(versionsCompatible('2', '1.x'), false);
  });
  test('chunk ids are stable and content-addressed', async () => {
    const blocks = [{ type: 'heading', level: 1, text: 'PXE' }, { type: 'paragraph', text: 'TFTP serves pxelinux.0' }];
    const opts = { documentId: 'd1', documentName: 'H', documentType: 'pxe', embeddingModel: 'm' };
    const a = await chunkBlocks(blocks, opts);
    const b = await chunkBlocks(blocks, opts);
    assert.equal(a[0].id, b[0].id);
    const c = await chunkBlocks(blocks, { ...opts, embeddingModel: 'other' });
    assert.notEqual(a[0].id, c[0].id, 'changing embedding model forces re-embedding');
    assert.ok(a[0].id.length <= 64, 'fits Vectorize id limit');
  });
  test('long sections split with overlap', async () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} explains a detail of the boot process.`).join(' ');
    const chunks = await chunkBlocks([{ type: 'paragraph', text }], { documentId: 'd', documentName: 'D', documentType: 'handbook', embeddingModel: 'm', chunkSize: 500, chunkOverlap: 80 });
    assert.ok(chunks.length > 3);
    assert.ok(chunks.every((c) => c.content.length <= 600));
    assert.ok(chunks[1].content.startsWith('…'));
  });
  test('code-looking lines', () => {
    assert.equal(looksLikeCode('int main(void) {'), true);
    assert.equal(looksLikeCode('This is a sentence about booting.'), false);
  });
});

describe('config parsing & prompt building', () => {
  test('GOOGLE_DOCUMENT_IDS formats', () => {
    assert.deepEqual(parseDocumentConfig('1AbCdEfGhIjK:source_code, 1ZyXwVuTsRqP'), [
      { id: '1AbCdEfGhIjK', type: 'source_code', name: null }, { id: '1ZyXwVuTsRqP', type: null, name: null }]);
    assert.equal(parseDocumentConfig('[{"id":"1AbCdEfGhIjK","type":"pxe","name":"PXE Guide"}]')[0].name, 'PXE Guide');
    assert.deepEqual(parseDocumentConfig('bad id!,x'), []);
  });
  test('context block separates docs and code and labels sources', () => {
    const out = buildContextBlock([
      { label: 'S1', document_name: 'H', document_type: 'handbook', chunk_type: 'text', content: 'doc text', section: 'A > B' },
      { label: 'S2', document_name: 'C', document_type: 'source_code', chunk_type: 'code', content: '```c\nx\n```', file_name: 'a.c' },
    ]);
    assert.match(out, /<documentation_context>\n<source label="S1"[^>]*section="A › B"/);
    assert.match(out, /<source_code_context>\n<source label="S2"[^>]*file="a\.c"/);
  });
});
