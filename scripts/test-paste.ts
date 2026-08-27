/**
 * PasteFilter — the stream that stops a multi-line paste from being submitted
 * one line at a time.
 *
 *   node scripts/test-paste.ts
 */
import { PasteFilter, expandPastes, pasteMarker } from '../src/ui/paste.ts';

const ESC = '\u001b';
const START = `${ESC}[200~`;
const END = `${ESC}[201~`;

let failures = 0;

function assert(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  if (!pass) failures++;
  process.stdout.write(
    `${pass ? 'ok  ' : 'FAIL'} ${name}${pass ? '' : `\n       got      ${a}\n       expected ${e}`}\n`
  );
}

/** Feed chunks through the filter; return what passed through and what was caught. */
function feed(chunks: string[]): { through: string; pastes: string[] } {
  const pastes: string[] = [];
  const filter = new PasteFilter({ onPaste: (t) => pastes.push(t) });
  let through = '';
  filter.on('data', (d: Buffer) => {
    through += d.toString('utf8');
  });
  for (const chunk of chunks) filter.write(chunk);
  return { through, pastes };
}

process.stdout.write('\nPasteFilter\n\n');

// Typing goes straight through, one keystroke per event.
{
  const { through, pastes } = feed(['h', 'i', '\r']);
  assert('typing passes through untouched', through, 'hi\r');
  assert('typing is not treated as a paste', pastes, []);
}

// A bracketed paste is captured whole and never reaches readline.
{
  const { through, pastes } = feed([`${START}line one\nline two\nline three${END}`]);
  assert('bracketed paste is withheld from the line', through, '');
  assert('bracketed paste is captured whole', pastes, ['line one\nline two\nline three']);
}

// Terminals split large pastes across reads, including mid-marker.
{
  const { through, pastes } = feed([
    `${ESC}[20`,
    '0~alpha\nbeta',
    `\ngamma${ESC}[2`,
    '01~',
  ]);
  assert('markers split across chunks still work', pastes, ['alpha\nbeta\ngamma']);
  assert('nothing leaks through on a split paste', through, '');
}

// Typing before and after a paste is preserved in order.
{
  const { through, pastes } = feed(['f', 'i', 'x', ':', `${START}a\nb${END}`, '!']);
  assert('typing around a paste still flows', through, 'fix:!');
  assert('the paste is captured separately', pastes, ['a\nb']);
}

// CRLF pastes are normalised.
{
  const { pastes } = feed([`${START}one\r\ntwo${END}`]);
  assert('CRLF is normalised to LF', pastes, ['one\ntwo']);
}

// Fallback for terminals with no bracketed paste: a block arriving at once.
{
  const { through, pastes } = feed(['first line\nsecond line\nthird']);
  assert('a newline-laden chunk is treated as a paste', pastes, [
    'first line\nsecond line\nthird',
  ]);
  assert('and does not reach readline', through, '');
}

// A lone Enter must stay a submit, not become a paste.
{
  const { through, pastes } = feed(['\r']);
  assert('a bare Enter still submits', through, '\r');
  assert('a bare Enter is not a paste', pastes, []);
}

process.stdout.write('\nexpandPastes\n\n');

{
  const marker = pasteMarker(1, 3);
  assert(
    'the placeholder is replaced in place',
    expandPastes(`explain ${marker} please`, ['a\nb\nc']),
    'explain a\nb\nc please'
  );
}
{
  assert(
    'two pastes land in the right order',
    expandPastes(`${pasteMarker(1, 2)} then ${pasteMarker(2, 2)}`, ['x\ny', 'p\nq']),
    'x\ny then p\nq'
  );
}
{
  assert(
    'a deleted placeholder does not lose the paste',
    expandPastes('just this', ['kept\ntext']),
    'just this\nkept\ntext'
  );
}
{
  assert('no pastes means no change', expandPastes('plain text', []), 'plain text');
}

process.stdout.write(failures ? `\n${failures} failing\n` : '\nall passing\n');
process.exitCode = failures ? 1 : 0;
