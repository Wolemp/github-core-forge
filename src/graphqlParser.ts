// A GraphQL document parser: operations, fragments, selections, arguments and values. It covers what
// gh, github-mcp-server and the introspection probes send; syntax it does not know is a parse error.

export type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

export interface FieldSel {
  type: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  directives: DirectiveNode[];
  selections: Selection[];
}

export interface FragmentSpread {
  type: 'spread';
  name: string;
  directives: DirectiveNode[];
}

export interface InlineFragment {
  type: 'inline';
  typeCondition: string | null;
  directives: DirectiveNode[];
  selections: Selection[];
}

export type Selection = FieldSel | FragmentSpread | InlineFragment;

export interface DirectiveNode {
  name: string;
  args: Record<string, Value>;
}

export interface VariableDef {
  name: string;
  type: string;
  defaultValue: Value | null;
}

export interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDef[];
  selections: Selection[];
}

export interface Fragment {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

export class GraphQLSyntaxError extends Error {}

interface Token {
  kind: 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
    } else if (c === '#') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1;
    } else if (c === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
    } else if ('!$&()[]{}:=@|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
    } else if (c === '-' || /[0-9]/.test(c)) {
      const m = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (m === null) throw new GraphQLSyntaxError(`Unexpected character "${c}"`);
      tokens.push({ kind: m[1] !== undefined || m[2] !== undefined ? 'float' : 'int', value: m[0] });
      i += m[0].length;
    } else if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GraphQLSyntaxError('Unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end).trim() });
        i = end + 3;
      } else {
        let j = i + 1;
        let out = '';
        for (;;) {
          if (j >= source.length || source[j] === '\n') throw new GraphQLSyntaxError('Unterminated string');
          const d = source[j];
          if (d === '"') break;
          if (d === '\\') {
            const e = source[j + 1];
            if (e === 'u') {
              out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
              j += 6;
              continue;
            }
            const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
            out += map[e] ?? e;
            j += 2;
            continue;
          }
          out += d;
          j += 1;
        }
        tokens.push({ kind: 'string', value: out });
        i = j + 1;
      }
    } else {
      throw new GraphQLSyntaxError(`Unexpected character "${c}"`);
    }
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

export function parseDocument(source: string): Document {
  const tokens = lex(source);
  let pos = 0;
  const peek = (): Token => tokens[pos];
  const next = (): Token => tokens[pos++];
  const isPunct = (v: string): boolean => peek().kind === 'punct' && peek().value === v;
  const expectPunct = (v: string): void => {
    if (!isPunct(v)) throw new GraphQLSyntaxError(`Expected "${v}", found "${peek().value || '<EOF>'}"`);
    pos += 1;
  };
  const expectName = (): string => {
    const t = next();
    if (t.kind !== 'name') throw new GraphQLSyntaxError(`Expected Name, found "${t.value || '<EOF>'}"`);
    return t.value;
  };

  const parseValue = (isConst: boolean): Value => {
    const t = peek();
    if (t.kind === 'punct' && t.value === '$') {
      if (isConst) throw new GraphQLSyntaxError('Unexpected variable in a constant value');
      pos += 1;
      return { kind: 'var', name: expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      pos += 1;
      const values: Value[] = [];
      while (!isPunct(']')) values.push(parseValue(isConst));
      pos += 1;
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      pos += 1;
      const fields: Record<string, Value> = {};
      while (!isPunct('}')) {
        const key = expectName();
        expectPunct(':');
        fields[key] = parseValue(isConst);
      }
      pos += 1;
      return { kind: 'object', fields };
    }
    pos += 1;
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new GraphQLSyntaxError(`Unexpected "${t.value || '<EOF>'}"`);
  };

  const parseArgs = (): Record<string, Value> => {
    const args: Record<string, Value> = {};
    if (!isPunct('(')) return args;
    pos += 1;
    while (!isPunct(')')) {
      const key = expectName();
      expectPunct(':');
      args[key] = parseValue(false);
    }
    pos += 1;
    return args;
  };

  const parseDirectives = (): DirectiveNode[] => {
    const out: DirectiveNode[] = [];
    while (isPunct('@')) {
      pos += 1;
      out.push({ name: expectName(), args: parseArgs() });
    }
    return out;
  };

  const parseSelectionSet = (): Selection[] => {
    expectPunct('{');
    const out: Selection[] = [];
    while (!isPunct('}')) {
      if (peek().kind === 'eof') throw new GraphQLSyntaxError('Expected "}", found <EOF>');
      if (isPunct('...')) {
        pos += 1;
        if (peek().kind === 'name' && peek().value !== 'on') {
          const name = expectName();
          out.push({ type: 'spread', name, directives: parseDirectives() });
        } else {
          let typeCondition: string | null = null;
          if (peek().kind === 'name' && peek().value === 'on') {
            pos += 1;
            typeCondition = expectName();
          }
          const directives = parseDirectives();
          out.push({ type: 'inline', typeCondition, directives, selections: parseSelectionSet() });
        }
      } else {
        let name = expectName();
        let alias: string | null = null;
        if (isPunct(':')) {
          pos += 1;
          alias = name;
          name = expectName();
        }
        const args = parseArgs();
        const directives = parseDirectives();
        const selections = isPunct('{') ? parseSelectionSet() : [];
        out.push({ type: 'field', alias, name, args, directives, selections });
      }
    }
    pos += 1;
    return out;
  };

  const parseType = (): string => {
    let text: string;
    if (isPunct('[')) {
      pos += 1;
      text = `[${parseType()}]`;
      expectPunct(']');
    } else {
      text = expectName();
    }
    if (isPunct('!')) {
      pos += 1;
      text += '!';
    }
    return text;
  };

  const doc: Document = { operations: [], fragments: new Map() };
  while (peek().kind !== 'eof') {
    if (isPunct('{')) {
      doc.operations.push({ kind: 'query', name: null, variables: [], selections: parseSelectionSet() });
      continue;
    }
    const keyword = expectName();
    if (keyword === 'fragment') {
      const name = expectName();
      if (expectName() !== 'on') throw new GraphQLSyntaxError('Expected "on"');
      const typeCondition = expectName();
      parseDirectives();
      doc.fragments.set(name, { name, typeCondition, selections: parseSelectionSet() });
    } else if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
      let name: string | null = null;
      if (peek().kind === 'name') name = expectName();
      const variables: VariableDef[] = [];
      if (isPunct('(')) {
        pos += 1;
        while (!isPunct(')')) {
          expectPunct('$');
          const varName = expectName();
          expectPunct(':');
          const type = parseType();
          let defaultValue: Value | null = null;
          if (isPunct('=')) {
            pos += 1;
            defaultValue = parseValue(true);
          }
          parseDirectives();
          variables.push({ name: varName, type, defaultValue });
        }
        pos += 1;
      }
      parseDirectives();
      doc.operations.push({ kind: keyword, name, variables, selections: parseSelectionSet() });
    } else {
      throw new GraphQLSyntaxError(`Unexpected Name "${keyword}"`);
    }
  }
  if (doc.operations.length === 0) throw new GraphQLSyntaxError('Unexpected <EOF>');
  return doc;
}
