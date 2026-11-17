// Git's object model: blobs, trees and commits as raw bytes keyed by their sha-1, plus the
// encode/parse helpers the REST contents API, the merge code and (later) the pack code share.
// Nothing here knows about HTTP; an ObjectStore is a Map from hex id to {type, data}.

import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export type ObjectStore = Map<string, GitObject>;

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface Person {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export interface Commit {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}

export const EMPTY_TREE = '4b825dc642cb9fe8c1f77ff0aeb9af2e8a3b5ee2';

export function hashObject(type: ObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

/** Store an object and return its id (a no-op when it is already there). */
export function putObject(store: ObjectStore, type: ObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!store.has(sha)) store.set(sha, { type, data });
  return sha;
}

// Tree entries sort by name with a trailing '/' on directories, byte-wise.
function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = entries.map((entry) => ({ entry, key: treeSortKey(entry) })).sort((a, b) => Buffer.compare(a.key, b.key));
  const parts: Buffer[] = [];
  for (const { entry } of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0, space);
    if (space < 0 || nul < 0) break;
    entries.push({
      mode: data.toString('latin1', pos, space),
      name: data.toString('utf8', space + 1, nul),
      sha: data.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return entries;
}

function personLine(label: string, p: Person): string {
  return `${label} ${p.name} <${p.email}> ${p.time} ${p.tz}`;
}

export function encodeCommit(commit: Commit): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(personLine('author', commit.author), personLine('committer', commit.committer), '', commit.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

function parsePerson(rest: string): Person {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(rest);
  if (m === null) return { name: rest, email: '', time: 0, tz: '+0000' };
  return { name: m[1], email: m[2], time: Number(m[3]), tz: m[4] };
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const commit: Commit = { tree: '', parents: [], author: parsePerson(''), committer: parsePerson(''), message };
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const rest = line.slice(space + 1);
    if (key === 'tree') commit.tree = rest;
    else if (key === 'parent') commit.parents.push(rest);
    else if (key === 'author') commit.author = parsePerson(rest);
    else if (key === 'committer') commit.committer = parsePerson(rest);
  }
  return commit;
}

/** A flat file listing of a tree: path -> {mode, sha}. Directories are not listed. */
export type FlatTree = Map<string, { mode: string; sha: string }>;

export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', out: FlatTree = new Map()): FlatTree {
  const object = store.get(treeSha);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, out);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return out;
}

interface DirNode {
  files: Map<string, { mode: string; sha: string }>;
  dirs: Map<string, DirNode>;
}

/** Write a flat listing back as nested trees and return the root tree id. */
export function buildTree(store: ObjectStore, flat: FlatTree): string {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, file] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], file);
  }
  const write = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, sha: file.sha });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: write(dir) });
    return putObject(store, 'tree', encodeTree(entries));
  };
  return write(root);
}

/** Look one path up in a tree: a file entry, a directory (tree sha) or null. */
export function lookupPath(store: ObjectStore, treeSha: string, path: string): { mode: string; sha: string } | null {
  let sha = treeSha;
  let mode = '40000';
  if (path === '') return { mode, sha };
  for (const part of path.split('/')) {
    const object = store.get(sha);
    if (object === undefined || object.type !== 'tree') return null;
    const found = parseTree(object.data).find((entry) => entry.name === part);
    if (found === undefined) return null;
    sha = found.sha;
    mode = found.mode;
  }
  return { mode, sha };
}

export function readCommit(store: ObjectStore, sha: string): Commit | null {
  const object = store.get(sha);
  return object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
}

/** Every commit reachable from `tips`, newest committer time first (ties by discovery order). */
export function walkCommits(store: ObjectStore, tips: readonly string[], limit = Infinity): string[] {
  const seen = new Set<string>();
  const queue: { sha: string; time: number; order: number }[] = [];
  let order = 0;
  const push = (sha: string): void => {
    if (seen.has(sha)) return;
    const commit = readCommit(store, sha);
    if (commit === null) return;
    seen.add(sha);
    queue.push({ sha, time: commit.committer.time, order: order++ });
  };
  for (const tip of tips) push(tip);
  const result: string[] = [];
  while (queue.length > 0 && result.length < limit) {
    let best = 0;
    for (let i = 1; i < queue.length; i += 1) {
      if (queue[i].time > queue[best].time || (queue[i].time === queue[best].time && queue[i].order < queue[best].order)) best = i;
    }
    const [item] = queue.splice(best, 1);
    result.push(item.sha);
    const commit = readCommit(store, item.sha);
    if (commit !== null) for (const parent of commit.parents) push(parent);
  }
  return result;
}

export function ancestorsOf(store: ObjectStore, sha: string): Set<string> {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) continue;
    const commit = readCommit(store, next);
    if (commit === null) continue;
    seen.add(next);
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `descendant` or reachable from it. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (next === ancestor) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    const commit = readCommit(store, next);
    if (commit !== null) for (const parent of commit.parents) stack.push(parent);
  }
  return false;
}

/** A best common ancestor of two commits (the nearest one by walk order), or null for unrelated histories. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ofA = ancestorsOf(store, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    if (ofA.has(next)) return next;
    const commit = readCommit(store, next);
    if (commit !== null) for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/** Three-way merge of flat trees; null on a conflict (a path both sides changed differently). */
export function mergeTrees(base: FlatTree, ours: FlatTree, theirs: FlatTree): FlatTree | null {
  const result: FlatTree = new Map();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (x: { sha: string; mode: string } | undefined, y: { sha: string; mode: string } | undefined): boolean =>
    x === undefined || y === undefined ? x === y : x.sha === y.sha && x.mode === y.mode;
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let pick: { sha: string; mode: string } | undefined;
    if (same(o, t)) pick = o;
    else if (same(b, o)) pick = t;
    else if (same(b, t)) pick = o;
    else return null;
    if (pick !== undefined) result.set(path, pick);
  }
  return result;
}
