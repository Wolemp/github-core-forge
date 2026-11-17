// The forge's state: repositories (a git object store + refs each) with their labels, issues and
// pull requests. One process, all in memory. The git-level operations the REST layer needs
// (commit a file, squash merge, diff) live here; HTTP shapes live in rest.ts.

import {
  buildTree,
  flattenTree,
  encodeCommit,
  isAncestor,
  lookupPath,
  mergeBase,
  mergeTrees,
  putObject,
  readCommit,
  type FlatTree,
  type ObjectStore,
  type Person,
} from './gitObjects.ts';

/** The login the bearer token belongs to: the seeded viewer of the suite (override with MAKEFUN_VIEWER_LOGIN). */
export const VIEWER_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullState {
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  draft: boolean;
}

export interface Item {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pull: PullState | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: ObjectStore;
  /** full ref name -> commit id */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  items: Item[];
}

export const repos = new Map<string, Repo>();
let nextRepoId = 1_000_000;
let nextGlobalId = 5_000;

export function nextId(): number {
  nextGlobalId += 1;
  return nextGlobalId;
}

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function findRepo(owner: string, name: string): Repo | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

export function createRepo(name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo {
  const stamp = now();
  nextRepoId += 1;
  const repo: Repo = {
    id: nextRepoId,
    owner: VIEWER_LOGIN,
    name,
    description,
    isPrivate,
    defaultBranch,
    createdAt: stamp,
    updatedAt: stamp,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    items: [],
  };
  repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

export function person(): Person {
  return { name: VIEWER_NAME, email: VIEWER_EMAIL, time: Math.floor(Date.now() / 1000), tz: '+0000' };
}

/** Resolve a branch name, tag name, full ref or (abbreviated-free) 40-hex commit id to a commit id. */
export function resolveRef(repo: Repo, name: string): string | null {
  if (name.startsWith('refs/')) return repo.refs.get(name) ?? null;
  const heads = repo.refs.get(`refs/heads/${name}`);
  if (heads !== undefined) return heads;
  const tags = repo.refs.get(`refs/tags/${name}`);
  if (tags !== undefined) return tags;
  if (/^[0-9a-f]{40}$/i.test(name) && repo.objects.has(name.toLowerCase())) return name.toLowerCase();
  return null;
}

export function treeOfCommit(repo: Repo, commitSha: string): string | null {
  const commit = readCommit(repo.objects, commitSha);
  return commit === null ? null : commit.tree;
}

export function flatTreeOfCommit(repo: Repo, commitSha: string | null): FlatTree {
  if (commitSha === null) return new Map();
  const tree = treeOfCommit(repo, commitSha);
  return tree === null ? new Map() : flattenTree(repo.objects, tree);
}

export function newCommit(repo: Repo, flat: FlatTree, parents: string[], message: string): string {
  const tree = buildTree(repo.objects, flat);
  const who = person();
  return putObject(repo.objects, 'commit', encodeCommit({ tree, parents, author: who, committer: who, message }));
}

export function fileAt(repo: Repo, commitSha: string, path: string): { mode: string; sha: string } | null {
  const tree = treeOfCommit(repo, commitSha);
  return tree === null ? null : lookupPath(repo.objects, tree, path);
}

// ---- pull requests --------------------------------------------------------------------------

export function itemByNumber(repo: Repo, number: number): Item | null {
  return Number.isInteger(number) && number >= 1 ? (repo.items[number - 1] ?? null) : null;
}

export function addItem(repo: Repo, title: string, body: string, labels: string[], pull: PullState | null): Item {
  const stamp = now();
  const item: Item = {
    id: nextId(),
    number: repo.items.length + 1,
    title,
    body,
    state: 'open',
    stateReason: null,
    labels,
    comments: [],
    createdAt: stamp,
    updatedAt: stamp,
    closedAt: null,
    pull,
  };
  repo.items.push(item);
  return item;
}

/** The tips a pull request currently compares: live branch tips while open, the recorded ones once closed. */
export function pullTips(repo: Repo, pull: PullState, open: boolean): { head: string; base: string } {
  if (!open) return { head: pull.headSha, base: pull.baseSha };
  return { head: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha, base: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha };
}

export interface MergeResult {
  tree: FlatTree;
  base: string | null;
}

/** Three-way merge of head into base; tree is null on a conflict. */
export function tryMerge(repo: Repo, baseSha: string, headSha: string): { tree: FlatTree | null; mergeBase: string | null } {
  const mb = mergeBase(repo.objects, baseSha, headSha);
  const tree = mergeTrees(flatTreeOfCommit(repo, mb), flatTreeOfCommit(repo, baseSha), flatTreeOfCommit(repo, headSha));
  return { tree, mergeBase: mb };
}

export function canMerge(repo: Repo, baseSha: string, headSha: string): boolean {
  return tryMerge(repo, baseSha, headSha).tree !== null;
}

/** Squash (one parent) or true merge (two parents) of the pull; null on a conflict. */
export function mergePull(repo: Repo, item: Item, method: string, title: string, message: string): string | null {
  const pull = item.pull as PullState;
  const tips = pullTips(repo, pull, true);
  const { tree } = tryMerge(repo, tips.base, tips.head);
  if (tree === null) return null;
  const parents = method === 'merge' ? [tips.base, tips.head] : [tips.base];
  const text = message === '' ? title : `${title}\n\n${message}`;
  const sha = newCommit(repo, tree, parents, text);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const stamp = now();
  pull.merged = true;
  pull.mergedAt = stamp;
  pull.mergeSha = sha;
  pull.headSha = tips.head;
  pull.baseSha = tips.base;
  item.state = 'closed';
  item.closedAt = stamp;
  item.updatedAt = stamp;
  repo.updatedAt = stamp;
  return sha;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  sha: string;
  patch: string | undefined;
}

function lines(repo: Repo, sha: string | undefined): string[] {
  if (sha === undefined) return [];
  const object = repo.objects.get(sha);
  if (object === undefined) return [];
  const text = object.data.toString('utf8');
  if (text === '') return [];
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

/** Added/removed line counts: lines are matched through an LCS (capped; beyond the cap whole-file counts). */
function lineDelta(before: string[], after: string[]): { additions: number; deletions: number } {
  if (before.length === 0) return { additions: after.length, deletions: 0 };
  if (after.length === 0) return { additions: 0, deletions: before.length };
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endA = before.length;
  let endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const a = before.slice(start, endA);
  const b = after.slice(start, endB);
  if (a.length * b.length > 4_000_000) return { additions: b.length, deletions: a.length };
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  const common = prev[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** The file-level diff from the merge base of the pull to its head. */
export function diffFiles(repo: Repo, baseSha: string, headSha: string): FileChange[] {
  const mb = mergeBase(repo.objects, baseSha, headSha);
  const before = flatTreeOfCommit(repo, mb);
  const after = flatTreeOfCommit(repo, headSha);
  const out: FileChange[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const b = before.get(path);
    const a = after.get(path);
    if (b !== undefined && a !== undefined && b.sha === a.sha) continue;
    const status = b === undefined ? 'added' : a === undefined ? 'removed' : 'modified';
    const delta = lineDelta(lines(repo, b?.sha), lines(repo, a?.sha));
    out.push({ filename: path, status, additions: delta.additions, deletions: delta.deletions, sha: (a ?? b)?.sha ?? '', patch: undefined });
  }
  return out;
}

export function commitsBetween(repo: Repo, baseSha: string, headSha: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [headSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha) || isAncestor(repo.objects, sha, baseSha)) continue;
    seen.add(sha);
    out.push(sha);
    const commit = readCommit(repo.objects, sha);
    if (commit !== null) for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}
