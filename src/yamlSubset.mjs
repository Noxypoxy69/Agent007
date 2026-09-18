/**
 * A deliberately small YAML subset: nested mappings, sequences, scalars.
 *
 * WHY NOT A YAML LIBRARY. This file decides which agent may write which path.
 * A dependency that resolves anchors, merge keys, or `y` as boolean true is a
 * dependency that can silently change an ownership rule during an `npm update`.
 * The existing parser in lanes.mjs made the same call for the flat format and
 * said why: "a silently misparsed ownership rule is worse than no rule at all."
 * This widens the grammar to nested records without widening that risk.
 *
 * WHAT IS SUPPORTED
 *   key: value            scalar
 *   key:                  nested mapping or sequence on following lines
 *   - item                sequence of scalars
 *   - key: value          sequence of mappings
 *   "quoted"  'quoted'    quoting, kept verbatim after the quotes come off
 *   # comment             whole-line and trailing
 *   true/false            booleans, exactly those spellings
 *   123                   integers
 *   null / ~              null
 *
 * WHAT IS REJECTED, LOUDLY
 *   &anchors *aliases <<merge   multi-doc ---   |block  >folded
 *   [flow, seq]   {flow: map}   tabs for indent   duplicate keys
 *   inconsistent indentation
 *
 * Rejection beats interpretation everywhere. Every throw names the line, since
 * the operator editing this file is usually not the person who wrote it.
 */

const SCALAR_KEY = /^([A-Za-z0-9_.\-/]+):\s*(.*)$/;

export function parseYamlSubset(text) {
  const lines = [];
  const raw = String(text).split(/\r?\n/);

  for (let i = 0; i < raw.length; i++) {
    const n = i + 1;
    let line = raw[i];

    if (/^\t/.test(line) || /^ *\t/.test(line)) {
      throw new Error(`yaml: tab used for indentation (line ${n}). Use spaces.`);
    }
    if (/^---\s*$/.test(line) || /^\.\.\.\s*$/.test(line)) {
      throw new Error(`yaml: multi-document markers are not supported (line ${n})`);
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Strip trailing comments, but never inside quotes.
    line = stripTrailingComment(line);
    if (!line.trim()) continue;

    if (/(^|\s)[&*]\w/.test(line) || line.includes('<<:')) {
      throw new Error(`yaml: anchors, aliases and merge keys are not supported (line ${n})`);
    }
    if (/:\s*[|>]\s*$/.test(line)) {
      throw new Error(`yaml: block scalars are not supported (line ${n})`);
    }

    const indent = line.length - line.replace(/^ */, '').length;
    lines.push({ n, indent, text: line.trim() });
  }

  const [value, consumed] = parseBlock(lines, 0, lines.length ? lines[0].indent : 0);
  if (consumed < lines.length) {
    throw new Error(`yaml: inconsistent indentation at line ${lines[consumed].n}`);
  }
  return value;
}

function stripTrailingComment(line) {
  let out = '', quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += c;
  }
  return out.replace(/\s+$/, '');
}

/** Parse every line at `indent`, returning [value, indexAfter]. */
function parseBlock(lines, start, indent) {
  if (start >= lines.length) return [null, start];
  return lines[start].text.startsWith('- ') || lines[start].text === '-'
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

function parseMapping(lines, start, indent) {
  const map = {};
  let i = start;

  while (i < lines.length) {
    const { n, indent: ind, text } = lines[i];
    if (ind < indent) break;
    if (ind > indent) throw new Error(`yaml: unexpected indentation at line ${n}`);
    if (text.startsWith('- ')) throw new Error(`yaml: sequence item where a key was expected (line ${n})`);

    const m = text.match(SCALAR_KEY);
    if (!m) throw new Error(`yaml: expected "key: value" at line ${n}: ${text}`);
    const [, key, rest] = m;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new Error(`yaml: duplicate key "${key}" (line ${n})`);
    }

    if (rest.trim()) {
      map[key] = scalar(rest.trim(), n);
      i += 1;
      continue;
    }

    // Value is whatever is nested beneath, if anything.
    const next = lines[i + 1];
    if (!next || next.indent <= ind) { map[key] = null; i += 1; continue; }
    const [value, after] = parseBlock(lines, i + 1, next.indent);
    map[key] = value;
    i = after;
  }
  return [map, i];
}

function parseSequence(lines, start, indent) {
  const list = [];
  let i = start;

  while (i < lines.length) {
    const { n, indent: ind, text } = lines[i];
    if (ind < indent) break;
    if (ind > indent) throw new Error(`yaml: unexpected indentation at line ${n}`);
    if (!text.startsWith('- ') && text !== '-') break;

    const body = text === '-' ? '' : text.slice(2).trim();

    // "- key: value" opens a mapping whose remaining keys are indented further.
    const asKey = body.match(SCALAR_KEY);
    if (asKey) {
      const itemIndent = ind + 2;
      const synthetic = [{ n, indent: itemIndent, text: body }];
      let j = i + 1;
      while (j < lines.length && lines[j].indent >= itemIndent) { synthetic.push(lines[j]); j += 1; }
      const [value, after] = parseMapping(synthetic, 0, itemIndent);
      if (after !== synthetic.length) throw new Error(`yaml: could not parse list item at line ${n}`);
      list.push(value);
      i = j;
      continue;
    }

    if (!body) throw new Error(`yaml: empty list item at line ${n}`);
    list.push(scalar(body, n));
    i += 1;
  }
  return [list, i];
}

function scalar(s, n) {
  // `[]` and `{}` are allowed as the EMPTY collection and nothing more. They
  // carry no items, so there is nothing to misparse, and they are the natural
  // way to write "this lane grants no capabilities" -- rejecting them only
  // pushes authors to omit the key, which reads as an oversight rather than a
  // decision. Any non-empty flow form is still refused.
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s.startsWith('[') || s.startsWith('{')) {
    throw new Error(`yaml: flow collections are not supported (line ${n})`);
  }
  const q = s.match(/^"(.*)"$/) || s.match(/^'(.*)'$/);
  if (q) return q[1];
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^(yes|no|on|off|y|n)$/i.test(s)) {
    // YAML 1.1 reads these as booleans and YAML 1.2 as strings, so the same
    // file means two things depending on the reader. Refuse rather than pick.
    throw new Error(
      `yaml: ambiguous boolean "${s}" (line ${n}). Write true or false, or quote it ("${s}") for the string.`,
    );
  }
  return s;
}
