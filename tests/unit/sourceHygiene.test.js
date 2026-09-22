const fs = require('fs');
const path = require('path');

/**
 * A regex escape that passes through a JSON-decoding layer collapses into the
 * control character it names: "\b" becomes a literal U+0008 BACKSPACE. The
 * result is still valid JavaScript, so `node --check` passes, and every editor,
 * diff and JSON.stringify renders the byte back as an innocent-looking "\b".
 * Only the raw bytes give it away.
 *
 * It happened once already: the WORD_MATCH regex in itemCategory.js shipped
 * matching a backspace instead of a word boundary, so "Coca Cola" and "Ice Tea"
 * were filed as "other" and silently lost the cold-drink weather signal, and
 * the classifier's own tests stayed green because every case they covered also
 * matched a plain substring. This is the durable guard. The CI workflow runs
 * the same check with grep over every tracked source file.
 */
const SRC_ROOT = path.resolve(__dirname, '../../src');

// Every byte below 0x20 except tab, line feed and carriage return.
const CONTROL_BYTE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

const findControlBytes = (file) => {
  // latin1 maps one byte to one character, so the offsets are byte offsets and
  // multi-byte UTF-8 sequences can never be mistaken for a control byte.
  const source = fs.readFileSync(file, 'latin1');
  const found = [];
  for (const match of source.matchAll(CONTROL_BYTE)) {
    const hex = match[0].charCodeAt(0).toString(16).padStart(2, '0');
    found.push(`${path.relative(SRC_ROOT, file)}:${lineOf(source, match.index)} 0x${hex}`);
  }
  return found;
};

describe('source hygiene', () => {
  const files = walk(SRC_ROOT);

  it('walks the source tree it is meant to guard', () => {
    expect(files).toContain(path.join(SRC_ROOT, 'utils', 'itemCategory.js'));
    expect(files).toContain(path.join(SRC_ROOT, 'services', 'forecast.service.js'));
  });

  it('contains no raw control characters in any src/**/*.js file', () => {
    expect(files.flatMap(findControlBytes)).toEqual([]);
  });

  it('would catch the collapsed escape that shipped in itemCategory.js', () => {
    // Built from escapes and String.raw rather than typed, because the same
    // collapse can happen to a test file on its way through a tool.
    const collapsed = String.fromCharCode(8);
    const broken = `const WORD_MATCH = /${collapsed}(cola|ice|shake)${collapsed}/;`;
    const intact = String.raw`const WORD_MATCH = /\b(cola|ice|shake)\b/;`;
    expect([...broken.matchAll(CONTROL_BYTE)]).toHaveLength(2);
    expect([...intact.matchAll(CONTROL_BYTE)]).toHaveLength(0);
    expect(intact).toContain(String.fromCharCode(92) + 'b(cola');
  });
});
