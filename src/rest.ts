// REST v3 under /api/v3: repositories, contents, refs, branches, commits, labels, issues and pull
// requests. A handler gets a Ctx and returns {status, body, headers}; it throws ApiError for the
// GitHub-shaped failures ({message}), which the server turns into JSON.

import {
  addItem,
  canMerge,
  commitsBetween,
  createRepo,
  deleteRepo,
  diffFiles,
  findRepo,
  flatTreeOfCommit,
  itemByNumber,
  mergePull,
  newCommit,
  nextId,
  now,
  pullTips,
  repos,
  resolveRef,
  treeOfCommit,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Item,
  type Repo,
} from './store.ts';
import { isAncestor, lookupPath, parseTree, putObject, readCommit, walkCommits, type FlatTree } from './gitObjects.ts';

export class ApiError extends Error {
  status: number;
  errors: unknown[] | undefined;
  constructor(status: number, message: string, errors?: unknown[]) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface Ctx {
  method: string;
  url: URL;
  base: string;
  params: Record<string, string>;
  json: () => Record<string, unknown>;
}

type Handler = (ctx: Ctx) => Reply;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = [];
  const source = pattern
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      if (part.startsWith('*')) {
        keys.push(part.slice(1));
        return '(.+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler });
}

/** Match a path (already without the /api/v3 prefix); returns the reply or null when no route fits. */
export function dispatch(method: string, path: string, ctxBase: Omit<Ctx, 'params'>): Reply | null {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.regex.exec(path);
    if (m === null) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((key, i) => {
      try {
        params[key] = decodeURIComponent(m[i + 1]);
      } catch {
        params[key] = m[i + 1];
      }
    });
    return r.handler({ ...ctxBase, params });
  }
  if (pathMatched) throw new ApiError(404, 'Not Found');
  return null;
}

// ---- helpers --------------------------------------------------------------------------------

const notFound = (): ApiError => new ApiError(404, 'Not Found');

function str(value: unknown, field: string, required = false): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) {
    if (required) throw new ApiError(422, 'Validation Failed', [{ resource: 'Request', code: 'missing_field', field }]);
    return '';
  }
  throw new ApiError(422, 'Validation Failed', [{ resource: 'Request', code: 'invalid', field }]);
}

function repoOf(ctx: Ctx): Repo {
  if (ctx.params.owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) throw notFound();
  const repo = findRepo(ctx.params.owner, ctx.params.repo);
  if (repo === null) throw notFound();
  return repo;
}

function paging(url: URL): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  return { page, perPage };
}

function paginate<T>(ctx: Ctx, list: T[]): Reply {
  const { page, perPage } = paging(ctx.url);
  const last = Math.max(1, Math.ceil(list.length / perPage));
  const slice = list.slice((page - 1) * perPage, page * perPage);
  const link = (n: number, rel: string): string => {
    const u = new URL(ctx.url.href);
    u.searchParams.set('page', String(n));
    u.searchParams.set('per_page', String(perPage));
    return `<${ctx.base}${u.pathname}${u.search}>; rel="${rel}"`;
  };
  const rels: string[] = [];
  if (page < last) rels.push(link(page + 1, 'next'), link(last, 'last'));
  if (page > 1) rels.push(link(page - 1, 'prev'), link(1, 'first'));
  return { status: 200, body: slice, headers: rels.length > 0 ? { link: rels.join(', ') } : undefined };
}

function userJson(base: string): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: `U_${VIEWER_ID}`,
    avatar_url: `${base}/avatars/${VIEWER_ID}`,
    url: `${base}/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `${base}/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: Repo, base: string): Record<string, unknown> {
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(base),
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: api,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    git_url: `${base}/${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
    has_issues: true,
    has_wiki: false,
    open_issues_count: repo.items.filter((i) => i.state === 'open').length,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

const b64 = (data: Buffer): string => data.toString('base64');

function commitJson(repo: Repo, sha: string, base: string): Record<string, unknown> {
  const commit = readCommit(repo.objects, sha);
  if (commit === null) throw notFound();
  const when = (t: number): string => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const url = `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`;
  return {
    sha,
    node_id: `C_${sha}`,
    url,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    commit: {
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      author: { name: commit.author.name, email: commit.author.email, date: when(commit.author.time) },
      committer: { name: commit.committer.name, email: commit.committer.email, date: when(commit.committer.time) },
      message: commit.message,
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: userJson(base),
    committer: userJson(base),
    parents: commit.parents.map((parent) => ({ sha: parent, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}

function labelJson(repo: Repo, name: string, base: string): Record<string, unknown> {
  const label = repo.labels.get(name.toLowerCase());
  return {
    id: label?.id ?? 0,
    node_id: `L_${label?.id ?? 0}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name: label?.name ?? name,
    color: label?.color ?? 'ededed',
    default: false,
    description: label?.description ?? null,
  };
}

function issueJson(repo: Repo, item: Item, base: string): Record<string, unknown> {
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const out: Record<string, unknown> = {
    id: item.id,
    node_id: `I_${item.id}`,
    url: `${api}/issues/${item.number}`,
    repository_url: api,
    html_url: `${base}/${repo.owner}/${repo.name}/${item.pull === null ? 'issues' : 'pull'}/${item.number}`,
    number: item.number,
    title: item.title,
    user: userJson(base),
    labels: item.labels.map((name) => labelJson(repo, name, base)),
    state: item.state,
    state_reason: item.stateReason,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: item.comments.length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.closedAt,
    author_association: 'OWNER',
    body: item.body,
  };
  if (item.pull !== null) out.pull_request = { url: `${api}/pulls/${item.number}`, html_url: `${base}/${repo.owner}/${repo.name}/pull/${item.number}` };
  return out;
}

function pullJson(repo: Repo, item: Item, base: string): Record<string, unknown> {
  const pull = item.pull;
  if (pull === null) throw notFound();
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const open = item.state === 'open';
  const tips = pullTips(repo, pull, open);
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(base),
    repo: repoJson(repo, base),
  });
  let mergeable: boolean | null = null;
  if (open) mergeable = canMerge(repo, tips.base, tips.head);
  return {
    id: item.id,
    node_id: `PR_${item.id}`,
    url: `${api}/pulls/${item.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${item.number}`,
    number: item.number,
    state: item.state,
    locked: false,
    title: item.title,
    user: userJson(base),
    body: item.body,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    labels: item.labels.map((name) => labelJson(repo, name, base)),
    draft: pull.draft,
    head: side(pull.headRef, tips.head),
    base: side(pull.baseRef, tips.base),
    author_association: 'OWNER',
    merged: pull.merged,
    mergeable,
    mergeable_state: open ? (mergeable ? 'clean' : 'dirty') : 'unknown',
    comments: item.comments.length,
    commits: commitsBetween(repo, tips.base, tips.head).length,
    additions: diffFiles(repo, tips.base, tips.head).reduce((n, f) => n + f.additions, 0),
    deletions: diffFiles(repo, tips.base, tips.head).reduce((n, f) => n + f.deletions, 0),
    changed_files: diffFiles(repo, tips.base, tips.head).length,
  };
}

// ---- root, meta, repositories ---------------------------------------------------------------

route('GET', '', (ctx) => ({
  status: 200,
  body: { current_user_url: `${ctx.base}/api/v3/user`, rate_limit_url: `${ctx.base}/api/v3/rate_limit` },
  headers: { 'x-oauth-scopes': 'repo, read:org' },
}));
route('GET', '/', (ctx) => ({ status: 200, body: { current_user_url: `${ctx.base}/api/v3/user` }, headers: { 'x-oauth-scopes': 'repo, read:org' } }));
route('GET', '/meta', () => ({ status: 200, body: { verifiable_password_authentication: false, installed_version: '3.14.0', hooks: [], web: [], api: [], git: [] } }));
route('GET', '/rate_limit', () => ({ status: 200, body: { resources: { core: { limit: 5000, remaining: 5000, reset: 0, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 0, used: 0 } } }));
route('GET', '/user', (ctx) => ({ status: 200, body: { ...userJson(ctx.base), name: 'ada iversen', email: VIEWER_EMAIL } }));
route('GET', '/users/:login', (ctx) => {
  if (ctx.params.login.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) throw notFound();
  return { status: 200, body: userJson(ctx.base) };
});

route('GET', '/user/repos', (ctx) => {
  const mine = [...repos.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return paginate(
    ctx,
    mine.map((repo) => repoJson(repo, ctx.base)),
  );
});

route('POST', '/user/repos', (ctx) => {
  const body = ctx.json();
  const name = str(body.name, 'name', true);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') {
    throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }]);
  }
  if (findRepo(VIEWER_LOGIN, name) !== null) {
    throw new ApiError(422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
  }
  const repo = createRepo(name, str(body.description, 'description'), body.private === true);
  return { status: 201, body: repoJson(repo, ctx.base), headers: { location: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}` } };
});

route('GET', '/repos/:owner/:repo', (ctx) => ({ status: 200, body: repoJson(repoOf(ctx), ctx.base) }));

route('PATCH', '/repos/:owner/:repo', (ctx) => {
  const repo = repoOf(ctx);
  const body = ctx.json();
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
  repo.updatedAt = now();
  return { status: 200, body: repoJson(repo, ctx.base) };
});

route('DELETE', '/repos/:owner/:repo', (ctx) => {
  deleteRepo(repoOf(ctx));
  return { status: 204, body: null };
});

// ---- refs, branches, commits ----------------------------------------------------------------

function refJson(repo: Repo, ref: string, sha: string, base: string): Record<string, unknown> {
  return {
    ref,
    node_id: `REF_${ref}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`,
    object: { type: 'commit', sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
  };
}

route('POST', '/repos/:owner/:repo/git/refs', (ctx) => {
  const repo = repoOf(ctx);
  const body = ctx.json();
  const ref = str(body.ref, 'ref', true);
  const sha = str(body.sha, 'sha', true).toLowerCase();
  if (!ref.startsWith('refs/')) throw new ApiError(422, 'Reference update failed', [{ resource: 'Reference', code: 'invalid', field: 'ref' }]);
  if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
  if (readCommit(repo.objects, sha) === null) throw new ApiError(422, 'Object does not exist');
  repo.refs.set(ref, sha);
  if (repo.defaultBranch === '' || (repo.refs.size === 1 && ref.startsWith('refs/heads/'))) repo.defaultBranch = ref.slice('refs/heads/'.length);
  return { status: 201, body: refJson(repo, ref, sha, ctx.base) };
});

route('GET', '/repos/:owner/:repo/git/ref/*ref', (ctx) => {
  const repo = repoOf(ctx);
  const ref = `refs/${ctx.params.ref}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) throw notFound();
  return { status: 200, body: refJson(repo, ref, sha, ctx.base) };
});

route('GET', '/repos/:owner/:repo/git/matching-refs/*ref', (ctx) => {
  const repo = repoOf(ctx);
  const prefix = `refs/${ctx.params.ref}`;
  const out = [...repo.refs].filter(([ref]) => ref.startsWith(prefix)).map(([ref, sha]) => refJson(repo, ref, sha, ctx.base));
  return { status: 200, body: out };
});

route('PATCH', '/repos/:owner/:repo/git/refs/*ref', (ctx) => {
  const repo = repoOf(ctx);
  const ref = `refs/${ctx.params.ref}`;
  const current = repo.refs.get(ref);
  if (current === undefined) throw notFound();
  const body = ctx.json();
  const sha = str(body.sha, 'sha', true).toLowerCase();
  if (readCommit(repo.objects, sha) === null) throw new ApiError(422, 'Object does not exist');
  if (body.force !== true && !isFastForward(repo, current, sha)) throw new ApiError(422, 'Update is not a fast forward');
  repo.refs.set(ref, sha);
  return { status: 200, body: refJson(repo, ref, sha, ctx.base) };
});

route('DELETE', '/repos/:owner/:repo/git/refs/*ref', (ctx) => {
  const repo = repoOf(ctx);
  if (!repo.refs.delete(`refs/${ctx.params.ref}`)) throw new ApiError(422, 'Reference does not exist');
  return { status: 204, body: null };
});

function isFastForward(repo: Repo, from: string, to: string): boolean {
  return isAncestor(repo.objects, from, to);
}

route('GET', '/repos/:owner/:repo/branches', (ctx) => {
  const repo = repoOf(ctx);
  const out = [...repo.refs]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha, url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return paginate(ctx, out);
});

route('GET', '/repos/:owner/:repo/branches/*branch', (ctx) => {
  const repo = repoOf(ctx);
  const sha = repo.refs.get(`refs/heads/${ctx.params.branch}`);
  if (sha === undefined) throw new ApiError(404, 'Branch not found');
  return { status: 200, body: { name: ctx.params.branch, commit: commitJson(repo, sha, ctx.base), protected: false } };
});

route('GET', '/repos/:owner/:repo/commits', (ctx) => {
  const repo = repoOf(ctx);
  if (repo.refs.size === 0) throw new ApiError(409, 'Git Repository is empty.');
  const name = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, name);
  if (tip === null) throw new ApiError(404, 'Not Found');
  const { page, perPage } = paging(ctx.url);
  const all = walkCommits(repo.objects, [tip], page * perPage + 1);
  const pathFilter = ctx.url.searchParams.get('path');
  const list = pathFilter === null ? all : all.filter((sha) => touches(repo, sha, pathFilter));
  const slice = list.slice((page - 1) * perPage, page * perPage).map((sha) => commitJson(repo, sha, ctx.base));
  return { status: 200, body: slice };
});

function touches(repo: Repo, sha: string, path: string): boolean {
  const commit = readCommit(repo.objects, sha);
  if (commit === null) return false;
  const here = lookupPath(repo.objects, commit.tree, path)?.sha;
  if (commit.parents.length === 0) return here !== undefined;
  return commit.parents.some((parent) => {
    const tree = treeOfCommit(repo, parent);
    return (tree === null ? undefined : lookupPath(repo.objects, tree, path)?.sha) !== here;
  });
}

route('GET', '/repos/:owner/:repo/commits/:ref', (ctx) => {
  const repo = repoOf(ctx);
  const sha = resolveRef(repo, ctx.params.ref);
  if (sha === null || readCommit(repo.objects, sha) === null) throw new ApiError(422, `No commit found for SHA: ${ctx.params.ref}`);
  return { status: 200, body: commitJson(repo, sha, ctx.base) };
});

// ---- contents -------------------------------------------------------------------------------

function entryJson(repo: Repo, path: string, mode: string, sha: string, base: string, withContent: boolean, ref: string): Record<string, unknown> {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const api = `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`;
  const isDir = mode === '40000';
  const out: Record<string, unknown> = {
    type: isDir ? 'dir' : 'file',
    name,
    path,
    sha,
    size: isDir ? 0 : (repo.objects.get(sha)?.data.length ?? 0),
    url: `${api}?ref=${encodeURIComponent(ref)}`,
    html_url: `${base}/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
    git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${sha}`,
    download_url: isDir ? null : `${base}/${repo.owner}/${repo.name}/raw/${ref}/${path}`,
  };
  if (withContent) {
    out.encoding = 'base64';
    out.content = b64(repo.objects.get(sha)?.data ?? Buffer.alloc(0));
  }
  return out;
}

function getContents(ctx: Ctx): Reply {
  const repo = repoOf(ctx);
  const path = (ctx.params.path ?? '').replace(/^\/+|\/+$/g, '');
  const ref = ctx.url.searchParams.get('ref') ?? repo.defaultBranch;
  const commitSha = resolveRef(repo, ref);
  if (commitSha === null) throw notFound();
  const tree = treeOfCommit(repo, commitSha);
  const found = tree === null ? null : lookupPath(repo.objects, tree, path);
  if (found === null) throw notFound();
  if (found.mode === '40000') {
    const dir = repo.objects.get(found.sha);
    const entries = dir === undefined ? [] : parseTree(dir.data);
    return {
      status: 200,
      body: entries.map((entry) => entryJson(repo, path === '' ? entry.name : `${path}/${entry.name}`, entry.mode, entry.sha, ctx.base, false, ref)),
    };
  }
  return { status: 200, body: entryJson(repo, path, found.mode, found.sha, ctx.base, true, ref) };
}
route('GET', '/repos/:owner/:repo/contents', getContents);
route('GET', '/repos/:owner/:repo/contents/*path', getContents);

function cleanPath(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) throw new ApiError(422, 'Invalid path');
  return parts.join('/');
}

/** Resolve the branch a contents write targets; an unborn repository accepts any branch name. */
function writeTarget(repo: Repo, body: Record<string, unknown>): { branch: string; tip: string | null } {
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  if (tip === null && repo.refs.size > 0) throw new ApiError(404, 'Branch not found');
  return { branch, tip };
}

function commitResult(repo: Repo, commitSha: string, content: Record<string, unknown> | null, base: string): Record<string, unknown> {
  const commit = commitJson(repo, commitSha, base);
  return {
    content,
    commit: {
      sha: commitSha,
      node_id: commit.node_id,
      url: (commit.commit as Record<string, unknown>).url,
      html_url: commit.html_url,
      author: (commit.commit as Record<string, unknown>).author,
      committer: (commit.commit as Record<string, unknown>).committer,
      tree: (commit.commit as Record<string, unknown>).tree,
      message: (commit.commit as Record<string, unknown>).message,
      parents: commit.parents,
    },
  };
}

route('PUT', '/repos/:owner/:repo/contents/*path', (ctx) => {
  const repo = repoOf(ctx);
  const path = cleanPath(ctx.params.path);
  const body = ctx.json();
  const message = str(body.message, 'message', true);
  const encoded = str(body.content, 'content', true);
  if (!/^[A-Za-z0-9+/=\r\n]*$/.test(encoded)) throw new ApiError(422, 'content is not valid Base64');
  const data = Buffer.from(encoded, 'base64');
  const target = writeTarget(repo, body);
  const flat: FlatTree = target.tip === null ? new Map() : new Map(flatTreeOfCommit(repo, target.tip));
  const existing = flat.get(path);
  const given = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
  if (existing !== undefined) {
    if (given === null) throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    if (given !== existing.sha) throw new ApiError(409, `${path} does not match ${given}`);
  } else if (given !== null) {
    throw new ApiError(409, `${path} does not match ${given}`);
  } else {
    for (const other of flat.keys()) {
      if (other.startsWith(`${path}/`) || path.startsWith(`${other}/`)) throw new ApiError(422, 'Invalid request: path conflicts with an existing file or directory');
    }
  }
  const blob = putObject(repo.objects, 'blob', data);
  flat.set(path, { mode: existing?.mode ?? '100644', sha: blob });
  const sha = newCommit(repo, flat, target.tip === null ? [] : [target.tip], message);
  repo.refs.set(`refs/heads/${target.branch}`, sha);
  repo.updatedAt = now();
  const content = entryJson(repo, path, '100644', blob, ctx.base, false, target.branch);
  content.encoding = 'base64';
  return { status: existing === undefined ? 201 : 200, body: commitResult(repo, sha, content, ctx.base) };
});

route('DELETE', '/repos/:owner/:repo/contents/*path', (ctx) => {
  const repo = repoOf(ctx);
  const path = cleanPath(ctx.params.path);
  const body = ctx.json();
  const message = str(body.message, 'message', true);
  const target = writeTarget(repo, body);
  if (target.tip === null) throw notFound();
  const flat = new Map(flatTreeOfCommit(repo, target.tip));
  const existing = flat.get(path);
  if (existing === undefined) throw notFound();
  const given = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
  if (given === null) throw new ApiError(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
  if (given !== existing.sha) throw new ApiError(409, `${path} does not match ${given}`);
  flat.delete(path);
  const sha = newCommit(repo, flat, [target.tip], message);
  repo.refs.set(`refs/heads/${target.branch}`, sha);
  repo.updatedAt = now();
  return { status: 200, body: commitResult(repo, sha, null, ctx.base) };
});

// ---- labels and issues ----------------------------------------------------------------------

route('POST', '/repos/:owner/:repo/labels', (ctx) => {
  const repo = repoOf(ctx);
  const body = ctx.json();
  const name = str(body.name, 'name', true);
  if (name === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
  if (repo.labels.has(name.toLowerCase())) throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
  repo.labels.set(name.toLowerCase(), { id: nextId(), name, color: str(body.color, 'color') || 'ededed', description: str(body.description, 'description') });
  return { status: 201, body: labelJson(repo, name, ctx.base) };
});

route('GET', '/repos/:owner/:repo/labels', (ctx) => {
  const repo = repoOf(ctx);
  return paginate(
    ctx,
    [...repo.labels.values()].map((label) => labelJson(repo, label.name, ctx.base)),
  );
});

function labelNames(repo: Repo, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
  const out: string[] = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string' ? (entry as { name: string }).name : '';
    const label = repo.labels.get(name.toLowerCase());
    if (name === '' || label === undefined) throw new ApiError(422, 'Validation Failed', [{ resource: 'Label', code: 'invalid', field: 'name', value: name }]);
    if (!out.includes(label.name)) out.push(label.name);
  }
  return out;
}

function itemOf(ctx: Ctx, repo: Repo): Item {
  const item = itemByNumber(repo, Number(ctx.params.number));
  if (item === null) throw notFound();
  return item;
}

route('POST', '/repos/:owner/:repo/issues', (ctx) => {
  const repo = repoOf(ctx);
  const body = ctx.json();
  const title = str(body.title, 'title', true);
  if (title.trim() === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'missing_field', field: 'title' }]);
  const labels = labelNames(repo, body.labels);
  const item = addItem(repo, title, str(body.body, 'body'), labels, null);
  return { status: 201, body: issueJson(repo, item, ctx.base), headers: { location: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${item.number}` } };
});

route('GET', '/repos/:owner/:repo/issues', (ctx) => {
  const repo = repoOf(ctx);
  const q = ctx.url.searchParams;
  const state = q.get('state') ?? 'open';
  const labels = (q.get('labels') ?? '').split(',').filter((l) => l !== '');
  const sort = q.get('sort') ?? 'created';
  const asc = (q.get('direction') ?? 'desc') === 'asc';
  let list = repo.items.filter((item) => (state === 'all' || item.state === state) && labels.every((l) => item.labels.some((x) => x.toLowerCase() === l.toLowerCase())));
  const key = (item: Item): number => (sort === 'comments' ? item.comments.length : item.number);
  list = [...list].sort((a, b) => (sort === 'updated' ? (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number) : key(a) - key(b)) * (asc ? 1 : -1));
  return paginate(
    ctx,
    list.map((item) => issueJson(repo, item, ctx.base)),
  );
});

route('GET', '/repos/:owner/:repo/issues/:number', (ctx) => {
  const repo = repoOf(ctx);
  return { status: 200, body: issueJson(repo, itemOf(ctx, repo), ctx.base) };
});

route('PATCH', '/repos/:owner/:repo/issues/:number', (ctx) => {
  const repo = repoOf(ctx);
  const item = itemOf(ctx, repo);
  const body = ctx.json();
  if (body.title !== undefined) item.title = str(body.title, 'title');
  if (body.body !== undefined) item.body = str(body.body, 'body');
  if (body.labels !== undefined) item.labels = labelNames(repo, body.labels);
  if (body.state !== undefined) {
    if (body.state !== 'open' && body.state !== 'closed') throw new ApiError(422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'state' }]);
    if (item.state !== body.state) {
      item.state = body.state;
      item.closedAt = body.state === 'closed' ? now() : null;
      item.stateReason = body.state === 'closed' ? (typeof body.state_reason === 'string' ? body.state_reason : 'completed') : 'reopened';
    }
  }
  item.updatedAt = now();
  return { status: 200, body: issueJson(repo, item, ctx.base) };
});

function commentJson(repo: Repo, item: Item, comment: Item['comments'][number], base: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`,
    issue_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${item.number}`,
    user: userJson(base),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
    body: comment.body,
  };
}

route('POST', '/repos/:owner/:repo/issues/:number/comments', (ctx) => {
  const repo = repoOf(ctx);
  const item = itemOf(ctx, repo);
  const text = str(ctx.json().body, 'body', true);
  if (text === '') throw new ApiError(422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
  const stamp = now();
  const comment = { id: nextId(), body: text, createdAt: stamp, updatedAt: stamp };
  item.comments.push(comment);
  item.updatedAt = stamp;
  return { status: 201, body: commentJson(repo, item, comment, ctx.base) };
});

route('GET', '/repos/:owner/:repo/issues/:number/comments', (ctx) => {
  const repo = repoOf(ctx);
  const item = itemOf(ctx, repo);
  return paginate(
    ctx,
    item.comments.map((comment) => commentJson(repo, item, comment, ctx.base)),
  );
});

// ---- pull requests --------------------------------------------------------------------------

function branchTip(repo: Repo, name: string, field: string): string {
  const ref = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  const tip = repo.refs.get(`refs/heads/${ref}`);
  if (tip === undefined) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field }]);
  return tip;
}

route('POST', '/repos/:owner/:repo/pulls', (ctx) => {
  const repo = repoOf(ctx);
  const body = ctx.json();
  const title = str(body.title, 'title', true);
  const headRaw = str(body.head, 'head', true);
  const baseRaw = str(body.base, 'base', true);
  const headTip = branchTip(repo, headRaw, 'head');
  const baseTip = branchTip(repo, baseRaw, 'base');
  const headRef = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
  const baseRef = baseRaw.includes(':') ? baseRaw.slice(baseRaw.indexOf(':') + 1) : baseRaw;
  if (commitsBetween(repo, baseTip, headTip).length === 0) {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${baseRef} and ${headRef}` }]);
  }
  const existing = repo.items.find((i) => i.pull !== null && i.state === 'open' && i.pull.headRef === headRef && i.pull.baseRef === baseRef);
  if (existing !== undefined) {
    throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${repo.owner}:${headRef}.` }]);
  }
  const item = addItem(repo, title, str(body.body, 'body'), [], {
    headRef,
    baseRef,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergedAt: null,
    mergeSha: null,
    draft: body.draft === true,
  });
  return { status: 201, body: pullJson(repo, item, ctx.base), headers: { location: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${item.number}` } };
});

route('GET', '/repos/:owner/:repo/pulls', (ctx) => {
  const repo = repoOf(ctx);
  const q = ctx.url.searchParams;
  const state = q.get('state') ?? 'open';
  const head = q.get('head');
  const baseFilter = q.get('base');
  const asc = (q.get('direction') ?? 'desc') === 'asc';
  const list = repo.items
    .filter((item) => item.pull !== null && (state === 'all' || item.state === state))
    .filter((item) => head === null || `${repo.owner}:${(item.pull as { headRef: string }).headRef}` === head || (item.pull as { headRef: string }).headRef === head)
    .filter((item) => baseFilter === null || (item.pull as { baseRef: string }).baseRef === baseFilter)
    .sort((a, b) => (a.number - b.number) * (asc ? 1 : -1));
  return paginate(
    ctx,
    list.map((item) => pullJson(repo, item, ctx.base)),
  );
});

function pullOf(ctx: Ctx, repo: Repo): Item {
  const item = itemOf(ctx, repo);
  if (item.pull === null) throw notFound();
  return item;
}

route('GET', '/repos/:owner/:repo/pulls/:number', (ctx) => {
  const repo = repoOf(ctx);
  return { status: 200, body: pullJson(repo, pullOf(ctx, repo), ctx.base) };
});

route('PATCH', '/repos/:owner/:repo/pulls/:number', (ctx) => {
  const repo = repoOf(ctx);
  const item = pullOf(ctx, repo);
  const body = ctx.json();
  if (body.title !== undefined) item.title = str(body.title, 'title');
  if (body.body !== undefined) item.body = str(body.body, 'body');
  if (body.state !== undefined && item.pull !== null && !item.pull.merged) {
    if (body.state !== 'open' && body.state !== 'closed') throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'state' }]);
    if (item.state !== body.state) {
      if (body.state === 'closed') {
        const tips = pullTips(repo, item.pull, true);
        item.pull.headSha = tips.head;
        item.pull.baseSha = tips.base;
      }
      item.state = body.state;
      item.closedAt = body.state === 'closed' ? now() : null;
    }
  }
  item.updatedAt = now();
  return { status: 200, body: pullJson(repo, item, ctx.base) };
});

route('GET', '/repos/:owner/:repo/pulls/:number/files', (ctx) => {
  const repo = repoOf(ctx);
  const item = pullOf(ctx, repo);
  const tips = pullTips(repo, item.pull as NonNullable<Item['pull']>, item.state === 'open');
  const files = diffFiles(repo, tips.base, tips.head).map((f) => ({
    sha: f.sha,
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.additions + f.deletions,
    blob_url: `${ctx.base}/${repo.owner}/${repo.name}/blob/${tips.head}/${f.filename}`,
    raw_url: `${ctx.base}/${repo.owner}/${repo.name}/raw/${tips.head}/${f.filename}`,
    contents_url: `${ctx.base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${f.filename}?ref=${tips.head}`,
  }));
  return paginate(ctx, files);
});

route('GET', '/repos/:owner/:repo/pulls/:number/commits', (ctx) => {
  const repo = repoOf(ctx);
  const item = pullOf(ctx, repo);
  const tips = pullTips(repo, item.pull as NonNullable<Item['pull']>, item.state === 'open');
  const shas = commitsBetween(repo, tips.base, tips.head);
  const ordered = walkCommits(repo.objects, [tips.head]).filter((sha) => shas.includes(sha)).reverse();
  return paginate(
    ctx,
    ordered.map((sha) => commitJson(repo, sha, ctx.base)),
  );
});

route('GET', '/repos/:owner/:repo/pulls/:number/merge', (ctx) => {
  const repo = repoOf(ctx);
  const item = pullOf(ctx, repo);
  if (!(item.pull as NonNullable<Item['pull']>).merged) throw notFound();
  return { status: 204, body: null };
});

route('PUT', '/repos/:owner/:repo/pulls/:number/merge', (ctx) => {
  const repo = repoOf(ctx);
  const item = pullOf(ctx, repo);
  const pull = item.pull as NonNullable<Item['pull']>;
  const body = ctx.json();
  if (item.state !== 'open' || pull.merged) throw new ApiError(405, 'Pull Request is not mergeable');
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new ApiError(422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'merge_method' }]);
  if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== pullTips(repo, pull, true).head) {
    throw new ApiError(409, 'Head branch was modified. Review and try the merge again.');
  }
  const title = typeof body.commit_title === 'string' && body.commit_title !== '' ? body.commit_title : `${item.title} (#${item.number})`;
  const message = typeof body.commit_message === 'string' ? body.commit_message : '';
  const sha = mergePull(repo, item, method, title, message);
  if (sha === null) throw new ApiError(405, 'Pull Request is not mergeable');
  return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
});
