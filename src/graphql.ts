// GraphQL v4 at POST /api/graphql: a schema table (types, fields, resolvers over the in-memory
// store), a validator that names unknown fields, an executor, and Relay-style global ids. Mutations
// reuse the REST handlers so both surfaces apply the same rules.

import { dispatch, ApiError } from './rest.ts';
import { diffFiles, itemByNumber, pullTips, repos, canMerge, findRepo, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Item, type Repo } from './store.ts';
import { commitsBetween } from './store.ts';
import { parseDocument, GraphQLSyntaxError, type Document, type Fragment, type Operation, type Selection, type Value, type FieldSel } from './graphqlParser.ts';

// ---- global ids -----------------------------------------------------------------------------

export function encodeId(type: string, id: number): string {
  return Buffer.from(`${String(type.length).padStart(3, '0')}:${type}${id}`).toString('base64');
}

function decodeId(id: string): { type: string; id: number } | null {
  const m = /^\d{3}:([A-Za-z]+?)(\d+)$/.exec(Buffer.from(id, 'base64').toString('utf8'));
  return m === null ? null : { type: m[1], id: Number(m[2]) };
}

function locateItem(id: string): { repo: Repo; item: Item } | null {
  const decoded = decodeId(id);
  if (decoded === null || (decoded.type !== 'Issue' && decoded.type !== 'PullRequest')) return null;
  for (const repo of repos.values()) {
    const item = repo.items.find((i) => i.id === decoded.id);
    if (item !== undefined && (item.pull !== null) === (decoded.type === 'PullRequest')) return { repo, item };
  }
  return null;
}

function locateRepo(id: string): Repo | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  for (const repo of repos.values()) if (repo.id === decoded.id) return repo;
  return null;
}

// ---- schema table ---------------------------------------------------------------------------

type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Src = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface FieldDef {
  type: string;
  args?: Record<string, string>;
  resolve?: (src: Src, args: Args) => Src;
}

interface TypeDef {
  kind: 'OBJECT' | 'INTERFACE' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'UNION';
  fields?: Record<string, FieldDef>;
  values?: string[];
  implements?: string[];
  possible?: string[];
  inputFields?: Record<string, string>;
}

class GraphQLError extends Error {}

const types: Record<string, TypeDef> = {};

for (const name of ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'HTML', 'GitObjectID', 'GitRefname']) types[name] = { kind: 'SCALAR' };

const enums: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'],
  PatchStatus: ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED'],
};
for (const [name, values] of Object.entries(enums)) types[name] = { kind: 'ENUM', values };

const inputs: Record<string, Record<string, string>> = {
  CreateIssueInput: { repositoryId: 'ID!', title: 'String!', body: 'String', labelIds: '[ID!]', clientMutationId: 'String' },
  UpdateIssueInput: { id: 'ID!', title: 'String', body: 'String', state: 'IssueState', clientMutationId: 'String' },
  CloseIssueInput: { issueId: 'ID!', stateReason: 'IssueStateReason', clientMutationId: 'String' },
  ReopenIssueInput: { issueId: 'ID!', clientMutationId: 'String' },
  CreatePullRequestInput: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', draft: 'Boolean', clientMutationId: 'String' },
  ClosePullRequestInput: { pullRequestId: 'ID!', clientMutationId: 'String' },
  MergePullRequestInput: { pullRequestId: 'ID!', commitHeadline: 'String', commitBody: 'String', mergeMethod: 'PullRequestMergeMethod', expectedHeadOid: 'GitObjectID', clientMutationId: 'String' },
  AddCommentInput: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' },
  IssueOrder: { field: 'IssueOrderField!', direction: 'OrderDirection!' },
  PullRequestOrder: { field: 'PullRequestOrderField!', direction: 'OrderDirection!' },
};
for (const [name, inputFields] of Object.entries(inputs)) types[name] = { kind: 'INPUT_OBJECT', inputFields };

const iso = (value: string | null): string | null => value;

function userObj(): Src {
  return { __type: 'User' };
}

function repoObj(repo: Repo): Src {
  return { __type: 'Repository', repo };
}

function itemObj(repo: Repo, item: Item): Src {
  return { __type: item.pull === null ? 'Issue' : 'PullRequest', repo, item };
}

function connection(name: string, list: Src[], args: Args, map: (entry: Src) => Src): Src {
  const total = list.length;
  let start = 0;
  let end = total;
  if (typeof args.after === 'string') {
    const m = /^cursor:(\d+)$/.exec(Buffer.from(args.after, 'base64').toString('utf8'));
    if (m === null) throw new GraphQLError('invalid cursor');
    start = Math.min(total, Number(m[1]) + 1);
  }
  if (typeof args.before === 'string') {
    const m = /^cursor:(\d+)$/.exec(Buffer.from(args.before, 'base64').toString('utf8'));
    if (m === null) throw new GraphQLError('invalid cursor');
    end = Math.min(total, Number(m[1]));
  }
  if (typeof args.first === 'number') {
    if (args.first < 0) throw new GraphQLError('first must be non-negative');
    end = Math.min(end, start + args.first);
  }
  if (typeof args.last === 'number') start = Math.max(start, end - args.last);
  const cursorOf = (index: number): string => Buffer.from(`cursor:${index}`).toString('base64');
  const slice = list.slice(start, end);
  return {
    __type: name,
    totalCount: total,
    nodes: slice.map(map),
    edges: slice.map((entry, i) => ({ __type: `${name.replace('Connection', 'Edge')}`, cursor: cursorOf(start + i), node: map(entry) })),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: end < total,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(start) : null,
      endCursor: slice.length > 0 ? cursorOf(end - 1) : null,
    },
  };
}

function orderItems(list: Item[], orderBy: Args | undefined, fallbackDesc: boolean): Item[] {
  const field = orderBy?.field ?? 'CREATED_AT';
  const desc = orderBy === undefined || orderBy === null ? fallbackDesc : orderBy.direction === 'DESC';
  const key = (item: Item): number | string => (field === 'COMMENTS' ? item.comments.length : field === 'UPDATED_AT' ? item.updatedAt : item.number);
  return [...list].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const cmp = x < y ? -1 : x > y ? 1 : a.number - b.number;
    return desc ? -cmp : cmp;
  });
}

function rest(method: string, path: string, body: Record<string, unknown>): Src {
  try {
    const reply = dispatch(method, path, { method, url: new URL(`http://graphql.local/api/v3${path}`), base: 'http://graphql.local', json: () => body });
    if (reply === null) throw new GraphQLError('Not Found');
    return reply.body;
  } catch (err) {
    if (err instanceof ApiError) {
      const detail = Array.isArray(err.errors) && err.errors.length > 0 ? ` ${JSON.stringify(err.errors[0])}` : '';
      throw new GraphQLError(`${err.message}${detail}`);
    }
    throw err;
  }
}

const repoPath = (repo: Repo): string => `/repos/${repo.owner}/${repo.name}`;

function mustRepo(id: unknown): Repo {
  const repo = typeof id === 'string' ? locateRepo(id) : null;
  if (repo === null) throw new GraphQLError(`Could not resolve to a Repository with the id '${String(id)}'.`);
  return repo;
}

function mustItem(id: unknown, kind: 'Issue' | 'PullRequest'): { repo: Repo; item: Item } {
  const found = typeof id === 'string' ? locateItem(id) : null;
  if (found === null || (found.item.pull !== null) !== (kind === 'PullRequest')) throw new GraphQLError(`Could not resolve to ${kind === 'Issue' ? 'an Issue' : 'a PullRequest'} with the id '${String(id)}'.`);
  return found;
}

function defineObject(name: string, fields: Record<string, FieldDef>, implementsList: string[] = []): void {
  types[name] = { kind: 'OBJECT', fields, implements: implementsList };
}

types.Node = { kind: 'INTERFACE', fields: { id: { type: 'ID!' } }, possible: ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User'] };
types.Actor = { kind: 'INTERFACE', fields: { login: { type: 'String!' }, url: { type: 'URI!' } }, possible: ['User'] };
types.RepositoryOwner = { kind: 'INTERFACE', fields: { login: { type: 'String!' }, id: { type: 'ID!' } }, possible: ['User'] };

defineObject(
  'User',
  {
    id: { type: 'ID!', resolve: () => encodeId('User', VIEWER_ID) },
    databaseId: { type: 'Int', resolve: () => VIEWER_ID },
    login: { type: 'String!', resolve: () => VIEWER_LOGIN },
    name: { type: 'String', resolve: () => VIEWER_NAME },
    url: { type: 'URI!', resolve: () => `http://localhost/${VIEWER_LOGIN}` },
    avatarUrl: { type: 'URI!', resolve: () => `http://localhost/avatars/${VIEWER_ID}` },
  },
  ['Node', 'Actor', 'RepositoryOwner'],
);

defineObject('PageInfo', {
  hasNextPage: { type: 'Boolean!' },
  hasPreviousPage: { type: 'Boolean!' },
  startCursor: { type: 'String' },
  endCursor: { type: 'String' },
});

defineObject('Ref', {
  name: { type: 'String!' },
  prefix: { type: 'String!', resolve: () => 'refs/heads/' },
  target: { type: 'GitObject', resolve: (s) => ({ __type: 'Commit', oid: s.oid }) },
});
defineObject('Commit', { oid: { type: 'GitObjectID!' }, id: { type: 'ID!', resolve: (s) => encodeId('Commit', parseInt(String(s.oid).slice(0, 8), 16)) } });
types.GitObject = { kind: 'INTERFACE', fields: { oid: { type: 'GitObjectID!' } }, possible: ['Commit'] };

defineObject('Label', { id: { type: 'ID!' }, name: { type: 'String!' }, color: { type: 'String!' } });
defineObject('LabelConnection', { nodes: { type: '[Label]' }, totalCount: { type: 'Int!' } });
defineObject('IssueCommentConnection', { totalCount: { type: 'Int!' }, nodes: { type: '[IssueComment]' } });

defineObject(
  'IssueComment',
  {
    id: { type: 'ID!', resolve: (s) => encodeId('IssueComment', s.comment.id) },
    databaseId: { type: 'Int', resolve: (s) => s.comment.id },
    body: { type: 'String!', resolve: (s) => s.comment.body },
    author: { type: 'Actor', resolve: () => userObj() },
    createdAt: { type: 'DateTime!', resolve: (s) => s.comment.createdAt },
    url: { type: 'URI!', resolve: (s) => `http://localhost/${s.repo.owner}/${s.repo.name}/issues/${s.item.number}#issuecomment-${s.comment.id}` },
  },
  ['Node'],
);
defineObject('IssueCommentEdge', { node: { type: 'IssueComment' }, cursor: { type: 'String!' } });

function labelsOf(s: Src): Src {
  const nodes = (s.item as Item).labels.map((name) => {
    const label = (s.repo as Repo).labels.get(name.toLowerCase());
    return { __type: 'Label', id: encodeId('Label', label?.id ?? 0), name, color: label?.color ?? 'ededed' };
  });
  return { __type: 'LabelConnection', nodes, totalCount: nodes.length };
}

const commonItemFields: Record<string, FieldDef> = {
  databaseId: { type: 'Int', resolve: (s) => s.item.id },
  number: { type: 'Int!', resolve: (s) => s.item.number },
  title: { type: 'String!', resolve: (s) => s.item.title },
  body: { type: 'String!', resolve: (s) => s.item.body },
  bodyText: { type: 'String!', resolve: (s) => s.item.body },
  author: { type: 'Actor', resolve: () => userObj() },
  labels: { type: 'LabelConnection', args: { first: 'Int' }, resolve: labelsOf },
  comments: {
    type: 'IssueCommentConnection!',
    args: { first: 'Int', after: 'String' },
    resolve: (s, a) => ({ ...connection('IssueCommentConnection', s.item.comments, a, (comment: Item['comments'][number]) => ({ __type: 'IssueComment', repo: s.repo, item: s.item, comment })) }),
  },
  createdAt: { type: 'DateTime!', resolve: (s) => s.item.createdAt },
  updatedAt: { type: 'DateTime!', resolve: (s) => s.item.updatedAt },
  closedAt: { type: 'DateTime', resolve: (s) => iso(s.item.closedAt) },
  closed: { type: 'Boolean!', resolve: (s) => s.item.state === 'closed' },
  url: { type: 'URI!', resolve: (s) => `http://localhost/${s.repo.owner}/${s.repo.name}/${s.item.pull === null ? 'issues' : 'pull'}/${s.item.number}` },
  repository: { type: 'Repository!', resolve: (s) => repoObj(s.repo) },
};

defineObject(
  'Issue',
  {
    ...commonItemFields,
    id: { type: 'ID!', resolve: (s) => encodeId('Issue', s.item.id) },
    state: { type: 'IssueState!', resolve: (s) => (s.item.state === 'open' ? 'OPEN' : 'CLOSED') },
    stateReason: { type: 'IssueStateReason', resolve: (s) => (s.item.stateReason === null ? null : String(s.item.stateReason).toUpperCase()) },
  },
  ['Node'],
);

function pullTipsOf(s: Src): { head: string; base: string } {
  return pullTips(s.repo, s.item.pull, s.item.state === 'open');
}

defineObject('PullRequestChangedFile', {
  path: { type: 'String!' },
  additions: { type: 'Int!' },
  deletions: { type: 'Int!' },
  changeType: { type: 'PatchStatus!' },
});
defineObject('PullRequestChangedFileConnection', {
  nodes: { type: '[PullRequestChangedFile]' },
  edges: { type: '[PullRequestChangedFileEdge]' },
  totalCount: { type: 'Int!' },
  pageInfo: { type: 'PageInfo!' },
});
defineObject('PullRequestChangedFileEdge', { node: { type: 'PullRequestChangedFile' }, cursor: { type: 'String!' } });
defineObject('CommitConnection', { totalCount: { type: 'Int!' } });

defineObject(
  'PullRequest',
  {
    ...commonItemFields,
    id: { type: 'ID!', resolve: (s) => encodeId('PullRequest', s.item.id) },
    state: { type: 'PullRequestState!', resolve: (s) => (s.item.pull.merged ? 'MERGED' : s.item.state === 'open' ? 'OPEN' : 'CLOSED') },
    merged: { type: 'Boolean!', resolve: (s) => s.item.pull.merged },
    mergedAt: { type: 'DateTime', resolve: (s) => s.item.pull.mergedAt },
    isDraft: { type: 'Boolean!', resolve: (s) => s.item.pull.draft },
    mergeable: {
      type: 'MergeableState!',
      resolve: (s) => {
        if (s.item.state !== 'open') return 'UNKNOWN';
        const tips = pullTipsOf(s);
        return canMerge(s.repo, tips.base, tips.head) ? 'MERGEABLE' : 'CONFLICTING';
      },
    },
    headRefName: { type: 'String!', resolve: (s) => s.item.pull.headRef },
    baseRefName: { type: 'String!', resolve: (s) => s.item.pull.baseRef },
    headRefOid: { type: 'GitObjectID!', resolve: (s) => pullTipsOf(s).head },
    baseRefOid: { type: 'GitObjectID!', resolve: (s) => pullTipsOf(s).base },
    mergeCommit: { type: 'Commit', resolve: (s) => (s.item.pull.mergeSha === null ? null : { __type: 'Commit', oid: s.item.pull.mergeSha }) },
    commits: { type: 'CommitConnection!', args: { first: 'Int' }, resolve: (s) => ({ __type: 'CommitConnection', totalCount: commitsBetween(s.repo, pullTipsOf(s).base, pullTipsOf(s).head).length }) },
    files: {
      type: 'PullRequestChangedFileConnection',
      args: { first: 'Int', after: 'String' },
      resolve: (s, a) => {
        const tips = pullTipsOf(s);
        const files = diffFiles(s.repo, tips.base, tips.head);
        return connection('PullRequestChangedFileConnection', files, a, (f: ReturnType<typeof diffFiles>[number]) => ({
          __type: 'PullRequestChangedFile',
          path: f.filename,
          additions: f.additions,
          deletions: f.deletions,
          changeType: f.status === 'removed' ? 'DELETED' : f.status.toUpperCase(),
        }));
      },
    },
  },
  ['Node'],
);

defineObject('IssueEdge', { node: { type: 'Issue' }, cursor: { type: 'String!' } });
defineObject('IssueConnection', { nodes: { type: '[Issue]' }, edges: { type: '[IssueEdge]' }, totalCount: { type: 'Int!' }, pageInfo: { type: 'PageInfo!' } });
defineObject('PullRequestEdge', { node: { type: 'PullRequest' }, cursor: { type: 'String!' } });
defineObject('PullRequestConnection', { nodes: { type: '[PullRequest]' }, edges: { type: '[PullRequestEdge]' }, totalCount: { type: 'Int!' }, pageInfo: { type: 'PageInfo!' } });

defineObject(
  'Repository',
  {
    id: { type: 'ID!', resolve: (s) => encodeId('Repository', s.repo.id) },
    databaseId: { type: 'Int', resolve: (s) => s.repo.id },
    name: { type: 'String!', resolve: (s) => s.repo.name },
    nameWithOwner: { type: 'String!', resolve: (s) => `${s.repo.owner}/${s.repo.name}` },
    description: { type: 'String', resolve: (s) => (s.repo.description === '' ? null : s.repo.description) },
    isPrivate: { type: 'Boolean!', resolve: (s) => s.repo.isPrivate },
    url: { type: 'URI!', resolve: (s) => `http://localhost/${s.repo.owner}/${s.repo.name}` },
    createdAt: { type: 'DateTime!', resolve: (s) => s.repo.createdAt },
    updatedAt: { type: 'DateTime!', resolve: (s) => s.repo.updatedAt },
    owner: { type: 'RepositoryOwner!', resolve: () => userObj() },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (s) => {
        const oid = s.repo.refs.get(`refs/heads/${s.repo.defaultBranch}`);
        return oid === undefined ? null : { __type: 'Ref', name: s.repo.defaultBranch, oid };
      },
    },
    viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean!', resolve: () => true },
    issue: {
      type: 'Issue',
      args: { number: 'Int!' },
      resolve: (s, a) => {
        const item = itemByNumber(s.repo, a.number);
        return item === null || item.pull !== null ? null : itemObj(s.repo, item);
      },
    },
    issues: {
      type: 'IssueConnection!',
      args: { first: 'Int', last: 'Int', after: 'String', before: 'String', states: '[IssueState!]', orderBy: 'IssueOrder', labels: '[String!]' },
      resolve: (s, a) => {
        const states: string[] | null = Array.isArray(a.states) ? a.states : null;
        const labels: string[] = Array.isArray(a.labels) ? a.labels : [];
        const list = (s.repo as Repo).items.filter(
          (item) => item.pull === null && (states === null || states.includes(item.state === 'open' ? 'OPEN' : 'CLOSED')) && labels.every((l) => item.labels.includes(l)),
        );
        return connection('IssueConnection', orderItems(list, a.orderBy, false), a, (item: Item) => itemObj(s.repo, item));
      },
    },
    pullRequest: {
      type: 'PullRequest',
      args: { number: 'Int!' },
      resolve: (s, a) => {
        const item = itemByNumber(s.repo, a.number);
        return item === null || item.pull === null ? null : itemObj(s.repo, item);
      },
    },
    pullRequests: {
      type: 'PullRequestConnection!',
      args: { first: 'Int', last: 'Int', after: 'String', before: 'String', states: '[PullRequestState!]', orderBy: 'PullRequestOrder', headRefName: 'String', baseRefName: 'String' },
      resolve: (s, a) => {
        const states: string[] | null = Array.isArray(a.states) ? a.states : null;
        const list = (s.repo as Repo).items.filter((item) => {
          if (item.pull === null) return false;
          const state = item.pull.merged ? 'MERGED' : item.state === 'open' ? 'OPEN' : 'CLOSED';
          return (states === null || states.includes(state)) && (a.headRefName === undefined || item.pull.headRef === a.headRefName) && (a.baseRefName === undefined || item.pull.baseRef === a.baseRefName);
        });
        return connection('PullRequestConnection', orderItems(list, a.orderBy, true), a, (item: Item) => itemObj(s.repo, item));
      },
    },
  },
  ['Node'],
);

// -- introspection types (their fields are real schema fields, so queries over them validate) ----

function namedTypeObj(name: string): Src {
  const def = types[name];
  return { __type: '__Type', name, def };
}

function typeRef(ref: string): Src {
  if (ref.endsWith('!')) return { __type: '__Type', kind: 'NON_NULL', name: null, ofType: typeRef(ref.slice(0, -1)) };
  if (ref.startsWith('[')) return { __type: '__Type', kind: 'LIST', name: null, ofType: typeRef(ref.slice(1, -1)) };
  return namedTypeObj(ref);
}

function fieldObjs(fields: Record<string, FieldDef>): Src[] {
  return Object.entries(fields).map(([name, def]) => ({
    __type: '__Field',
    name,
    isDeprecated: false,
    args: Object.entries(def.args ?? {}).map(([argName, argType]) => ({ __type: '__InputValue', name: argName, type: typeRef(argType), defaultValue: null })),
    type: typeRef(def.type),
  }));
}

defineObject('__Type', {
  kind: { type: 'String!', resolve: (s) => s.kind ?? s.def?.kind },
  name: { type: 'String', resolve: (s) => s.name ?? null },
  description: { type: 'String', resolve: () => null },
  fields: {
    type: '[__Field!]',
    args: { includeDeprecated: 'Boolean' },
    resolve: (s) => (s.def !== undefined && (s.def.kind === 'OBJECT' || s.def.kind === 'INTERFACE') && s.def.fields !== undefined ? fieldObjs(s.def.fields) : null),
  },
  enumValues: {
    type: '[__EnumValue!]',
    args: { includeDeprecated: 'Boolean' },
    resolve: (s) => (s.def?.kind === 'ENUM' ? (s.def.values as string[]).map((name) => ({ __type: '__EnumValue', name, isDeprecated: false })) : null),
  },
  inputFields: {
    type: '[__InputValue!]',
    resolve: (s) => (s.def?.kind === 'INPUT_OBJECT' ? Object.entries(s.def.inputFields as Record<string, string>).map(([name, type]) => ({ __type: '__InputValue', name, type: typeRef(type), defaultValue: null })) : null),
  },
  interfaces: { type: '[__Type!]', resolve: (s) => (s.def?.kind === 'OBJECT' ? (s.def.implements as string[]).map(namedTypeObj) : null) },
  possibleTypes: { type: '[__Type!]', resolve: (s) => (s.def?.kind === 'INTERFACE' || s.def?.kind === 'UNION' ? (s.def.possible as string[]).map(namedTypeObj) : null) },
  ofType: { type: '__Type', resolve: (s) => s.ofType ?? null },
});
defineObject('__Field', {
  name: { type: 'String!' },
  description: { type: 'String', resolve: () => null },
  args: { type: '[__InputValue!]!' },
  type: { type: '__Type!' },
  isDeprecated: { type: 'Boolean!' },
  deprecationReason: { type: 'String', resolve: () => null },
});
defineObject('__InputValue', { name: { type: 'String!' }, description: { type: 'String', resolve: () => null }, type: { type: '__Type!' }, defaultValue: { type: 'String' } });
defineObject('__EnumValue', { name: { type: 'String!' }, description: { type: 'String', resolve: () => null }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String', resolve: () => null } });
defineObject('__Schema', {
  types: { type: '[__Type!]!', resolve: () => Object.keys(types).map(namedTypeObj) },
  queryType: { type: '__Type!', resolve: () => namedTypeObj('Query') },
  mutationType: { type: '__Type', resolve: () => namedTypeObj('Mutation') },
  subscriptionType: { type: '__Type', resolve: () => null },
  directives: { type: '[__InputValue!]!', resolve: () => [] },
});

// -- mutation payloads --------------------------------------------------------------------------

defineObject('CreateIssuePayload', { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } });
defineObject('UpdateIssuePayload', { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } });
defineObject('CloseIssuePayload', { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } });
defineObject('ReopenIssuePayload', { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } });
defineObject('CreatePullRequestPayload', { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } });
defineObject('ClosePullRequestPayload', { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } });
defineObject('MergePullRequestPayload', { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } });
defineObject('AddCommentPayload', {
  commentEdge: { type: 'IssueCommentEdge' },
  subject: { type: 'Node' },
  clientMutationId: { type: 'String' },
});

function fresh(repo: Repo, number: number): Src {
  const item = itemByNumber(repo, number) as Item;
  return itemObj(repo, item);
}

defineObject('Mutation', {
  createIssue: {
    type: 'CreateIssuePayload',
    args: { input: 'CreateIssueInput!' },
    resolve: (_s, a) => {
      const repo = mustRepo(a.input.repositoryId);
      const created = rest('POST', `${repoPath(repo)}/issues`, { title: a.input.title, body: a.input.body ?? '' });
      return { __type: 'CreateIssuePayload', issue: fresh(repo, created.number), clientMutationId: a.input.clientMutationId ?? null };
    },
  },
  updateIssue: {
    type: 'UpdateIssuePayload',
    args: { input: 'UpdateIssueInput!' },
    resolve: (_s, a) => {
      const { repo, item } = mustItem(a.input.id, 'Issue');
      const body: Record<string, unknown> = {};
      if (a.input.title !== undefined) body.title = a.input.title;
      if (a.input.body !== undefined) body.body = a.input.body;
      if (a.input.state !== undefined) body.state = String(a.input.state).toLowerCase();
      rest('PATCH', `${repoPath(repo)}/issues/${item.number}`, body);
      return { __type: 'UpdateIssuePayload', issue: fresh(repo, item.number), clientMutationId: a.input.clientMutationId ?? null };
    },
  },
  closeIssue: {
    type: 'CloseIssuePayload',
    args: { input: 'CloseIssueInput!' },
    resolve: (_s, a) => {
      const { repo, item } = mustItem(a.input.issueId, 'Issue');
      rest('PATCH', `${repoPath(repo)}/issues/${item.number}`, { state: 'closed', state_reason: String(a.input.stateReason ?? 'COMPLETED').toLowerCase() });
      return { __type: 'CloseIssuePayload', issue: fresh(repo, item.number), clientMutationId: a.input.clientMutationId ?? null };
    },
  },
  reopenIssue: {
    type: 'ReopenIssuePayload',
    args: { input: 'ReopenIssueInput!' },
    resolve: (_s, a) => {
      const { repo, item } = mustItem(a.input.issueId, 'Issue');
      rest('PATCH', `${repoPath(repo)}/issues/${item.number}`, { state: 'open' });
      return { __type: 'ReopenIssuePayload', issue: fresh(repo, item.number), clientMutationId: a.input.clientMutationId ?? null };
    },
  },
  createPullRequest: {
    type: 'CreatePullRequestPayload',
    args: { input: 'CreatePullRequestInput!' },
    resolve: (_s, a) => {
      const repo = mustRepo(a.input.repositoryId);
      const created = rest('POST', `${repoPath(repo)}/pulls`, { title: a.input.title, body: a.input.body ?? '', head: a.input.headRefName, base: a.input.baseRefName, draft: a.input.draft === true });
      return { __type: 'CreatePullRequestPayload', pullRequest: fresh(repo, created.number), clientMutationId: a.input.clientMutationId ?? null };
    },
  },
  closePullRequest: {
    type: 'ClosePullRequestPayload',
    args: { input: 'ClosePullRequestInput!' },
    resolve: (_s, a) => {
      const { repo, item } = mustItem(a.input.pullRequestId, 'PullRequest');
      rest('PATCH', `${repoPath(repo)}/pulls/${item.number}`, { state: 'closed' });
      return { __type: 'ClosePullRequestPayload', pullRequest: fresh(repo, item.number), clientMutationId: a.input.clientMutationId ?? null };
    },
  },
  mergePullRequest: {
    type: 'MergePullRequestPayload',
    args: { input: 'MergePullRequestInput!' },
    resolve: (_s, a) => {
      const { repo, item } = mustItem(a.input.pullRequestId, 'PullRequest');
      const body: Record<string, unknown> = { merge_method: String(a.input.mergeMethod ?? 'MERGE').toLowerCase() };
      if (a.input.commitHeadline !== undefined) body.commit_title = a.input.commitHeadline;
      if (a.input.commitBody !== undefined) body.commit_message = a.input.commitBody;
      if (a.input.expectedHeadOid !== undefined) body.sha = a.input.expectedHeadOid;
      rest('PUT', `${repoPath(repo)}/pulls/${item.number}/merge`, body);
      return { __type: 'MergePullRequestPayload', pullRequest: fresh(repo, item.number), clientMutationId: a.input.clientMutationId ?? null };
    },
  },
  addComment: {
    type: 'AddCommentPayload',
    args: { input: 'AddCommentInput!' },
    resolve: (_s, a) => {
      const decoded = typeof a.input.subjectId === 'string' ? decodeId(a.input.subjectId) : null;
      const found = locateItem(String(a.input.subjectId));
      if (found === null || decoded === null) throw new GraphQLError(`Could not resolve to a node with the global id of '${String(a.input.subjectId)}'.`);
      const created = rest('POST', `${repoPath(found.repo)}/issues/${found.item.number}/comments`, { body: a.input.body });
      const comment = found.item.comments.find((c) => c.id === created.id) as Item['comments'][number];
      const node = { __type: 'IssueComment', repo: found.repo, item: found.item, comment };
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'IssueCommentEdge', node, cursor: Buffer.from(`cursor:${found.item.comments.length - 1}`).toString('base64') },
        subject: itemObj(found.repo, found.item),
        clientMutationId: a.input.clientMutationId ?? null,
      };
    },
  },
});

defineObject('SearchResultItemConnection', { issueCount: { type: 'Int!' }, nodes: { type: '[Node]' } });

defineObject('Query', {
  viewer: { type: 'User!', resolve: () => userObj() },
  repository: {
    type: 'Repository',
    args: { owner: 'String!', name: 'String!', followRenames: 'Boolean' },
    resolve: (_s, a) => {
      if (typeof a.owner !== 'string' || typeof a.name !== 'string' || a.owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) return null;
      const repo = findRepo(a.owner, a.name);
      return repo === null ? null : repoObj(repo);
    },
  },
  node: {
    type: 'Node',
    args: { id: 'ID!' },
    resolve: (_s, a) => {
      const id = String(a.id);
      const decoded = decodeId(id);
      if (decoded === null) return null;
      if (decoded.type === 'Repository') {
        const repo = locateRepo(id);
        return repo === null ? null : repoObj(repo);
      }
      if (decoded.type === 'User') return decoded.id === VIEWER_ID ? userObj() : null;
      const found = locateItem(id);
      return found === null ? null : itemObj(found.repo, found.item);
    },
  },
  search: {
    type: 'SearchResultItemConnection!',
    args: { query: 'String!', type: 'SearchType!', first: 'Int', after: 'String' },
    resolve: (_s, a) => {
      const needle = String(a.query).toLowerCase();
      const hits: Src[] = [];
      for (const repo of repos.values()) for (const item of repo.items) if (item.title.toLowerCase().includes(needle) || item.body.toLowerCase().includes(needle)) hits.push(itemObj(repo, item));
      return { __type: 'SearchResultItemConnection', issueCount: hits.length, nodes: hits.slice(0, typeof a.first === 'number' ? a.first : 30) };
    },
  },
  __type: { type: '__Type', args: { name: 'String!' }, resolve: (_s, a) => (types[a.name] === undefined ? null : namedTypeObj(a.name)) },
  __schema: { type: '__Schema!', resolve: () => ({ __type: '__Schema' }) },
});

// ---- execution ------------------------------------------------------------------------------

interface GqlError {
  message: string;
  path?: (string | number)[];
}

interface Run {
  doc: Document;
  vars: Record<string, unknown>;
  errors: GqlError[];
}

const baseName = (type: string): string => type.replace(/[[\]!]/g, '');

function valueOf(value: Value, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return vars[value.name];
    case 'null':
      return null;
    case 'list':
      return value.values.map((v) => valueOf(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value.fields)) {
        const resolved = valueOf(v, vars);
        if (resolved !== undefined) out[k] = resolved;
      }
      return out;
    }
    default:
      return value.value;
  }
}

function skipped(selection: Selection, vars: Record<string, unknown>): boolean {
  for (const directive of selection.directives) {
    const flag = directive.args.if === undefined ? undefined : valueOf(directive.args.if, vars);
    if (directive.name === 'skip' && flag === true) return true;
    if (directive.name === 'include' && flag === false) return true;
  }
  return false;
}

function typeMatches(concrete: string, condition: string | null): boolean {
  if (condition === null || condition === concrete) return true;
  const def = types[condition];
  if (def === undefined) return false;
  if (def.kind === 'INTERFACE' || def.kind === 'UNION') return (def.possible ?? []).includes(concrete);
  return (types[concrete]?.implements ?? []).includes(condition);
}

function validate(typeName: string, selections: Selection[], doc: Document, errors: GqlError[], seen: Set<string>): void {
  for (const sel of selections) {
    if (sel.type === 'field') {
      if (sel.name === '__typename') continue;
      const field = types[typeName]?.fields?.[sel.name];
      if (field === undefined) {
        errors.push({ message: `Field '${sel.name}' doesn't exist on type '${typeName}'` });
        continue;
      }
      const inner = baseName(field.type);
      const def = types[inner];
      if (sel.selections.length > 0 && def !== undefined && (def.kind === 'OBJECT' || def.kind === 'INTERFACE')) validate(inner, sel.selections, doc, errors, seen);
      else if (sel.selections.length === 0 && def !== undefined && (def.kind === 'OBJECT' || def.kind === 'INTERFACE')) {
        errors.push({ message: `Field must have selections (field '${sel.name}' returns ${field.type} but has no selections)` });
      }
    } else if (sel.type === 'inline') {
      validate(sel.typeCondition ?? typeName, sel.selections, doc, errors, seen);
    } else {
      const fragment = doc.fragments.get(sel.name);
      if (fragment === undefined) errors.push({ message: `Fragment ${sel.name} was used, but not defined` });
      else if (!seen.has(`${typeName}:${sel.name}`)) {
        seen.add(`${typeName}:${sel.name}`);
        validate(fragment.typeCondition, fragment.selections, doc, errors, seen);
      }
    }
  }
}

function collect(concrete: string, selections: Selection[], run: Run, out: Map<string, FieldSel[]>): void {
  for (const sel of selections) {
    if (skipped(sel, run.vars)) continue;
    if (sel.type === 'field') {
      const key = sel.alias ?? sel.name;
      const list = out.get(key);
      if (list === undefined) out.set(key, [sel]);
      else list.push(sel);
    } else if (sel.type === 'inline') {
      if (typeMatches(concrete, sel.typeCondition)) collect(concrete, sel.selections, run, out);
    } else {
      const fragment: Fragment | undefined = run.doc.fragments.get(sel.name);
      if (fragment !== undefined && typeMatches(concrete, fragment.typeCondition)) collect(concrete, fragment.selections, run, out);
    }
  }
}

function executeSelections(typeName: string, src: Src, selections: Selection[], run: Run, path: (string | number)[]): Record<string, unknown> {
  const concrete: string = src !== null && typeof src === 'object' && typeof src.__type === 'string' ? src.__type : typeName;
  const groups = new Map<string, FieldSel[]>();
  collect(concrete, selections, run, groups);
  const result: Record<string, unknown> = {};
  for (const [key, fields] of groups) {
    const first = fields[0];
    const fieldPath = [...path, key];
    if (first.name === '__typename') {
      result[key] = concrete;
      continue;
    }
    const def = types[concrete]?.fields?.[first.name];
    if (def === undefined) {
      result[key] = null;
      continue;
    }
    const args: Args = {};
    for (const [name, value] of Object.entries(first.args)) {
      const resolved = valueOf(value, run.vars);
      if (resolved !== undefined) args[name] = resolved;
    }
    try {
      const raw: Src = def.resolve !== undefined ? def.resolve(src, args) : src?.[first.name];
      const merged = fields.flatMap((f) => f.selections);
      result[key] = complete(def.type, raw, merged, run, fieldPath);
    } catch (err) {
      run.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      result[key] = null;
    }
  }
  return result;
}

function complete(type: string, value: Src, selections: Selection[], run: Run, path: (string | number)[]): unknown {
  if (type.endsWith('!')) {
    if (value === null || value === undefined) throw new GraphQLError(`Cannot return null for non-nullable field ${path.join('.')}`);
    return complete(type.slice(0, -1), value, selections, run, path);
  }
  if (value === null || value === undefined) return null;
  if (type.startsWith('[')) {
    const inner = type.slice(1, -1);
    return (value as Src[]).map((item, i) => {
      try {
        return complete(inner, item, selections, run, [...path, i]);
      } catch (err) {
        run.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, i] });
        return null;
      }
    });
  }
  const def = types[type];
  if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') return value;
  return executeSelections(type, value, selections, run, path);
}

function runOperation(doc: Document, op: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const def of op.variables) {
    let value = variables[def.name];
    if (value === undefined && def.defaultValue !== null) value = valueOf(def.defaultValue, {});
    if (value === undefined && def.type.endsWith('!')) return { errors: [{ message: `Variable $${def.name} of type ${def.type} was provided invalid value` }] };
    if (value !== undefined) vars[def.name] = value;
  }
  const root = op.kind === 'mutation' ? 'Mutation' : 'Query';
  if (op.kind === 'subscription') return { errors: [{ message: 'Subscriptions are not supported' }] };
  const problems: GqlError[] = [];
  validate(root, op.selections, doc, problems, new Set());
  if (problems.length > 0) return { errors: problems };
  const run: Run = { doc, vars, errors: [] };
  const data = executeSelections(root, null, op.selections, run, []);
  return run.errors.length > 0 ? { data, errors: run.errors } : { data };
}

function runRequest(request: unknown): Record<string, unknown> {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return { errors: [{ message: 'Invalid GraphQL request' }] };
  const body = request as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof body.query !== 'string' || body.query.trim() === '') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  let doc: Document;
  try {
    doc = parseDocument(body.query);
  } catch (err) {
    if (err instanceof GraphQLSyntaxError) return { errors: [{ message: `Parse error: ${err.message}` }] };
    throw err;
  }
  const variables = typeof body.variables === 'object' && body.variables !== null && !Array.isArray(body.variables) ? (body.variables as Record<string, unknown>) : {};
  let op: Operation | undefined;
  if (typeof body.operationName === 'string' && body.operationName !== '') op = doc.operations.find((o) => o.name === body.operationName);
  else if (doc.operations.length === 1) op = doc.operations[0];
  else return { errors: [{ message: 'An operation name is required when the document holds several operations' }] };
  if (op === undefined) return { errors: [{ message: `Unknown operation named "${String(body.operationName)}"` }] };
  return runOperation(doc, op, variables);
}

/** Run one request body (a request object, or an array of them for batching). */
export function executeGraphQL(body: unknown): unknown {
  return Array.isArray(body) ? body.map(runRequest) : runRequest(body);
}
