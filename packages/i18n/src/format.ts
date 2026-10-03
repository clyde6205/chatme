/**
 * Minimal ICU MessageFormat subset, enough for product copy and small enough
 * to ship in the startup bundle:
 *
 *   {name}                                  interpolation
 *   {count, plural, one {# item} other {# items}}   plural (CLDR categories, plus =N exact matches)
 *
 * `#` inside a plural branch is replaced by the locale-formatted number.
 * Values are inserted as plain text; rendering layers must not treat output as HTML.
 */

export type MessageValues = Record<string, string | number>;

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'arg'; name: string }
  | { kind: 'plural'; name: string; branches: Map<string, Node[]> }
  | { kind: 'hash' };

export class MessageSyntaxError extends Error {}

export function parseMessage(source: string): Node[] {
  let pos = 0;

  function parseNodes(inPlural: boolean): Node[] {
    const nodes: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) nodes.push({ kind: 'text', value: text });
      text = '';
    };
    while (pos < source.length) {
      const ch = source[pos]!;
      if (ch === '{') {
        flush();
        pos++;
        nodes.push(parseArgument());
      } else if (ch === '}') {
        if (!inPlural) throw new MessageSyntaxError(`Unexpected "}" at ${pos} in "${source}"`);
        break;
      } else if (ch === '#' && inPlural) {
        flush();
        pos++;
        nodes.push({ kind: 'hash' });
      } else {
        text += ch;
        pos++;
      }
    }
    flush();
    return nodes;
  }

  function readUntil(stops: string): string {
    const start = pos;
    while (pos < source.length && !stops.includes(source[pos]!)) pos++;
    return source.slice(start, pos).trim();
  }

  function parseArgument(): Node {
    const name = readUntil(',}');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new MessageSyntaxError(`Invalid argument name "${name}" in "${source}"`);
    }
    if (source[pos] === '}') {
      pos++;
      return { kind: 'arg', name };
    }
    pos++; // ','
    const type = readUntil(',');
    if (type !== 'plural') throw new MessageSyntaxError(`Unsupported argument type "${type}" in "${source}"`);
    pos++; // ','
    const branches = new Map<string, Node[]>();
    for (;;) {
      while (source[pos] === ' ' || source[pos] === '\n') pos++;
      if (source[pos] === '}') {
        pos++;
        break;
      }
      const key = readUntil('{');
      if (!key) throw new MessageSyntaxError(`Missing plural selector in "${source}"`);
      if (source[pos] !== '{') throw new MessageSyntaxError(`Unterminated plural in "${source}"`);
      pos++;
      branches.set(key, parseNodes(true));
      if (source[pos] !== '}') throw new MessageSyntaxError(`Unterminated plural branch in "${source}"`);
      pos++;
    }
    if (!branches.has('other')) throw new MessageSyntaxError(`Plural without "other" in "${source}"`);
    return { kind: 'plural', name, branches };
  }

  const nodes = parseNodes(false);
  if (pos !== source.length) throw new MessageSyntaxError(`Trailing input in "${source}"`);
  return nodes;
}

/** Argument names and plural selectors used by a message; the validator compares these across locales. */
export function describeMessage(source: string): { args: Set<string>; plurals: Map<string, Set<string>> } {
  const args = new Set<string>();
  const plurals = new Map<string, Set<string>>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.kind === 'arg') args.add(n.name);
      if (n.kind === 'plural') {
        args.add(n.name);
        plurals.set(n.name, new Set(n.branches.keys()));
        for (const b of n.branches.values()) walk(b);
      }
    }
  };
  walk(parseMessage(source));
  return { args, plurals };
}

const cache = new Map<string, Node[]>();

export function formatMessage(locale: string, source: string, values: MessageValues = {}): string {
  let nodes = cache.get(source);
  if (!nodes) {
    nodes = parseMessage(source);
    cache.set(source, nodes);
  }
  const numberFormat = new Intl.NumberFormat(locale);
  const pluralRules = new Intl.PluralRules(locale);

  const render = (list: Node[], hashValue: number | undefined): string =>
    list
      .map((n) => {
        switch (n.kind) {
          case 'text':
            return n.value;
          case 'hash':
            return hashValue === undefined ? '#' : numberFormat.format(hashValue);
          case 'arg': {
            const v = values[n.name];
            if (v === undefined) return `{${n.name}}`;
            return typeof v === 'number' ? numberFormat.format(v) : v;
          }
          case 'plural': {
            const raw = values[n.name];
            const count = typeof raw === 'number' ? raw : Number(raw);
            const exact = n.branches.get(`=${count}`);
            const branch = exact ?? n.branches.get(pluralRules.select(count)) ?? n.branches.get('other')!;
            return render(branch, count);
          }
        }
      })
      .join('');

  return render(nodes, undefined);
}
