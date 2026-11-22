// Fast drop-in for makefun-site 1.0.0: run(input) returns byte-for-byte what
// makefun-site 1.0.0's build returns, faster. Written from the README and the
// reference code's behaviour, reimplemented in one module: templates are
// compiled to JavaScript functions, Markdown renders directly off the shared
// lines array, and repeated slugs/dates/cards are cached.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const INCLUDE_DEPTH = 8;

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const slugCache = new Map();
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  // ASCII-only text is unchanged by NFKD and holds no combining marks.
  const plain = /^[\x00-\x7f]*$/.test(text) ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  if (slugCache.size < 8192) slugCache.set(text, slug);
  return slug;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();
function longDate(date) {
  let hit = dateCache.get(date);
  if (hit === undefined) {
    const [y, m, d] = date.split('-');
    hit = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    dateCache.set(date, hit);
  }
  return hit;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Parses front matter over the source's lines; returns { data, bodyStart }
// or { error }. `lines` is the whole source split on "\n".
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK.test(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

function listBlock(lines, i, to, isOrdered, first, env, blocks) {
  const marker = isOrdered ? ORDERED : BULLET;
  const start = isOrdered ? Number(first[1]) : 1;
  const items = [];
  while (i < to) {
    const m = marker.exec(lines[i]);
    if (m !== null) {
      items.push([trimST(isOrdered ? m[2] : m[1])]);
      i++;
    } else if (CONTINUED.test(lines[i])) {
      items[items.length - 1].push(trimST(lines[i]));
      i++;
    } else break;
  }
  const tag = isOrdered ? 'ol' : 'ul';
  const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
  let list = `${open}\n`;
  for (let q = 0; q < items.length; q++) list += `<li>${inline(items[q].join('\n'), env)}</li>\n`;
  blocks.push(`${list}</${tag}>`);
  return i;
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function isSpecial(c) {
  return c === '\\' || c === '`' || c === '*' || c === '[';
}

// Inline rendering: the next special character is found with one regex
// scan, the plain chunk before it escaped in one call, then the construct
// handled. Inputs with no markdown special at all take the escape-only
// fast path. SPEC_G is shared: every path resets its lastIndex after a
// recursive inline call, so nesting is safe.
const INLINE_SPEC = /[\\`*[]/;
const SPEC_G = /[\\`*[]/g;
function inline(s, env) {
  if (!INLINE_SPEC.test(s)) return escapeHtml(s);
  let out = '';
  let i = 0;
  const n = s.length;
  SPEC_G.lastIndex = 0;
  let m;
  while ((m = SPEC_G.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out += escapeHtml(s.slice(i, j));
    i = j;
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      out += escapeHtml(s[i + 1]);
      i += 2;
      SPEC_G.lastIndex = i;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
      SPEC_G.lastIndex = i;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
        SPEC_G.lastIndex = i;
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        out += `<em>${inline(s.slice(i + 1, k), env)}</em>`;
        i = k + 1;
      } else {
        out += '*';
        i++;
      }
      SPEC_G.lastIndex = i;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = mm + 1;
        SPEC_G.lastIndex = i;
        continue;
      }
      out += '[';
      i++;
      SPEC_G.lastIndex = i;
      continue;
    }
    out += escapeHtml(c);
    i++;
    SPEC_G.lastIndex = i;
  }
  if (i < n) out += escapeHtml(s.slice(i));
  return out;
}

// Renders lines[from..to) as Markdown: { html, toc, excerpt }.
function renderMarkdown(lines, from, to, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = from;
  while (i < to) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (!BLANK.test(line)) {
        const body = [trimST(line)];
        i++;
        while (i < to && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
        const html = inline(body.join('\n'), env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
      } else i++;
      continue;
    }
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < to && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        let code = '';
        for (let q = 0; q < body.length; q++) code += `${escapeHtml(body[q])}\n`;
        blocks.push(`<pre><code${cls}>${code}</code></pre>`);
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        i = listBlock(lines, i, to, false, bullet, env, blocks);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < to && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      const inner = [];
      for (let q = 0; q < body.length; q++) {
        const t = trimST(body[q]);
        if (t !== '') inner.push(t);
      }
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(inner.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        i = listBlock(lines, i, to, true, ordered, env, blocks);
        continue;
      }
    }
    const body = [trimST(line)];
    i++;
    while (i < to && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (let q = 0; q < blocks.length; q++) html += `${blocks[q]}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// Words in lines[from..to): runs of non-whitespace. The joiner "\n" is
// whitespace, so matching the joined body equals /\S+/g on the body string.
const WORDS_RE = /\S+/g;
function wordsOfLines(lines, from, to) {
  const m = lines.slice(from, to).join('\n').match(WORDS_RE);
  return m === null ? 0 : m.length;
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template code generation ---------------------------------------------
// A compiled template is fn(s0, o, d, F, __e, __t, __y, __p, __m, __c): s0 is
// the scope chain (a null-prototype object per render, child scopes via
// Object.create, so a name resolves from the innermost loop that binds it,
// else the top scope), o collects output strings, d is the include depth,
// F the compiled table, __m the memoizer and __c its per-build cache.
//
// Free names: the first segments a template reads (its own nodes plus its
// transitive includes), minus names its own fors bind. A template whose free
// names are only site/tags/recent renders the same for the whole case; one
// whose free names add exactly one loop-bound name renders the same for that
// element. Both are memoized at their include sites (keyed by element
// identity and render depth); anything else, and any template reading
// `loop`, renders normally.

// Own free names of `nodes` (first segments not bound by a for inside it)
// plus the templates it directly includes.
function ownFree(nodes, bound, out, includes) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if' || n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    }
    if (n.kind === 'for') {
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      ownFree(n.body, b2, out, includes);
    } else if (n.kind === 'if') {
      ownFree(n.then, bound, out, includes);
      if (n.else !== null) ownFree(n.else, bound, out, includes);
    } else if (n.kind === 'include') {
      includes.add(n.name);
    }
  }
}

// Least fixpoint of free names over the include graph (cycles included).
function freeNamesOf(parsed) {
  const free = new Map();
  for (const name of parsed.keys()) free.set(name, new Set());
  for (let round = 0; round < 64; round++) {
    let changed = false;
    for (const [name, nodes] of parsed) {
      const out = new Set();
      const includes = new Set();
      ownFree(nodes, new Set(), out, includes);
      for (const inc of includes) {
        const f = free.get(inc);
        if (f !== undefined) for (const x of f) out.add(x);
      }
      const cur = free.get(name);
      for (const x of out) {
        if (!cur.has(x)) {
          cur.add(x);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return free;
}

const CONSTANT_NAMES = new Set(['site', 'tags', 'recent']);
const MEMO_CONST = {};
// Memoized render of template `idx` at depth `depth` for element `elem`:
// the result depends only on (template, depth, element, case constants).
function memoRender(cache, elem, idx, depth, scope, F) {
  let byId = cache.get(elem);
  if (byId === undefined) {
    byId = new Map();
    cache.set(elem, byId);
  }
  const id = idx * 16 + depth;
  let hit = byId.get(id);
  if (hit === undefined) {
    const o2 = [];
    F[idx](scope, o2, depth, F, escapeHtml, textOf, truthy, ownStep, memoRender, cache, MEMO_CONST);
    hit = o2.join('');
    byId.set(id, hit);
  }
  return hit;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Own-property step of a path, or undefined.
function ownStep(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

// Emits statements resolving `path` from scope variable `sv` into `_v`.
function genLookup(code, path, sv) {
  code.push(`_v=${sv}.${path[0]};`);
  for (let k = 1; k < path.length; k++) code.push(`_v=__p(_v,${JSON.stringify(path[k])});`);
}

// `bound` is the stack of {name, sv} the current point's fors bind.
function genNodes(code, nodes, depth, ctx, bound) {
  const sv = `s${depth}`;
  for (const n of nodes) {
    if (n.kind === 'text') {
      code.push(`o.push(${JSON.stringify(n.text)});`);
    } else if (n.kind === 'var' || n.kind === 'raw') {
      genLookup(code, n.path, sv);
      code.push(n.kind === 'var' ? 'o.push(__e(__t(_v)));' : 'o.push(__t(_v));');
    } else if (n.kind === 'if') {
      genLookup(code, n.path, sv);
      code.push(`if(__y(_v)===${!n.not}){`);
      genNodes(code, n.then, depth, ctx, bound);
      if (n.else !== null) {
        code.push('}else{');
        genNodes(code, n.else, depth, ctx, bound);
      }
      code.push('}');
    } else if (n.kind === 'for') {
      genLookup(code, n.path, sv);
      const d1 = depth + 1;
      code.push(`if(Array.isArray(_v)){const __xs${d1}=_v;for(let __k${d1}=0;__k${d1}<__xs${d1}.length;__k${d1}++){const s${d1}=Object.create(${sv});`);
      if (n.name === '__proto__') code.push(`Object.defineProperty(s${d1},${JSON.stringify(n.name)},{value:__xs${d1}[__k${d1}],enumerable:true,writable:true,configurable:true});`);
      else code.push(`s${d1}.${n.name}=__xs${d1}[__k${d1}];`);
      code.push(`s${d1}.loop={index:__k${d1}+1,first:__k${d1}===0,last:__k${d1}===__xs${d1}.length-1,length:__xs${d1}.length};`);
      bound.push({ name: n.name, sv: `s${d1}` });
      genNodes(code, n.body, d1, ctx, bound);
      bound.pop();
      code.push('}}');
    } else if (n.kind === 'include') {
      const idx = ctx.indexOfTemplate(n.name);
      if (idx === undefined) continue;
      const free = ctx.freeNames.get(n.name);
      let memo = null;
      if (free !== undefined) {
        const nonConst = [...free].filter((x) => !CONSTANT_NAMES.has(x));
        if (nonConst.length === 0) memo = '__K';
        else if (nonConst.length === 1 && nonConst[0] !== 'loop') {
          const b = bound.findLast((e) => e.name === nonConst[0]);
          if (b !== undefined) memo = `${sv}.${nonConst[0]}`;
        }
      }
      if (memo === null) code.push(`if(d<${INCLUDE_DEPTH})F[${idx}](${sv},o,d+1,F,__e,__t,__y,__p,__m,__c,__K);`);
      else code.push(`if(d<${INCLUDE_DEPTH})o.push(__m(__c,${memo},${idx},d+1,${sv},F));`);
    }
  }
}

function compileTemplate(nodes, ctx) {
  const code = ['let _v;'];
  genNodes(code, nodes, 0, ctx, []);
  // Helpers are free variables of the generated function, passed at call time.
  return new Function('s0', 'o', 'd', 'F', '__e', '__t', '__y', '__p', '__m', '__c', '__K', code.join(''));
}

// ---------------------------------------------------------------- build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function run(input) {
  // Templates: parse in code-unit order of name; a bad one is reported, left out.
  const names = Object.keys(input.templates).sort(byCodeUnits);
  const report = [];
  const parsed = new Map();
  for (const name of names) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const tNames = [...parsed.keys()];
  const tIndex = new Map(tNames.map((n, i) => [n, i]));
  const ctx = { indexOfTemplate: (m) => tIndex.get(m), freeNames: freeNamesOf(parsed) };
  const F = tNames.map((n) => compileTemplate(parsed.get(n), ctx));
  const templates = new Map(tNames.map((n, i) => [n, i]));
  const memoCache = new Map();

  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. Sources, sorted by path; .md sources split once, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter and the refusal checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: slugs unique in their directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.lines, s.bodyStart, s.lines.length, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOfLines(s.lines, s.bodyStart, s.lines.length);
  }

  // 5. Collections: posts newest first, then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, cached per source (pageOf reuses the same card).
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of kept) cards.set(s, cardOf(s));
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  // 7. Layouts.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const idx = templates.get(name);
    if (idx === undefined) return null;
    const scope = Object.create(null);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    for (const k of Object.keys(vars)) scope[k] = vars[k];
    const o = [];
    F[idx](scope, o, 0, F, escapeHtml, textOf, truthy, ownStep, memoRender, memoCache, MEMO_CONST);
    return o.join('');
  };
  for (const s of kept) {
    const page = { ...cards.get(s), slug: s.slug, content: s.html, toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })), newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
