// The MCP endpoint at POST /mcp (Streamable HTTP, JSON replies): JSON-RPC 2.0 with the 2026-07-28
// `server/discover` flow and the older `initialize` handshake. Tools call the same handlers REST
// uses, so an object made over MCP is the object REST reads back.

import { ApiError, dispatch } from './rest.ts';

const SERVER_INFO = { name: 'github-core-forge', version: '1.0.0' };
const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Json>; required: string[] };
  run: (args: Json) => unknown;
}

function call(method: string, path: string, body: Json = {}): unknown {
  try {
    const reply = dispatch(method, path.split('?')[0], {
      method,
      url: new URL(`http://mcp.local/api/v3${path}`),
      base: 'http://mcp.local',
      json: () => body,
    });
    if (reply === null) throw new ToolError('Not Found');
    return reply.body;
  } catch (err) {
    if (err instanceof ApiError) {
      const detail = Array.isArray(err.errors) && err.errors.length > 0 ? ` ${JSON.stringify(err.errors[0])}` : '';
      throw new ToolError(`${err.message}${detail}`);
    }
    throw err;
  }
}

class ToolError extends Error {}

const enc = encodeURIComponent;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const prop = (type: string, description: string, extra: Json = {}): Json => ({ type, description, ...extra });
const repoProps = { owner: prop('string', 'Repository owner (login)'), repo: prop('string', 'Repository name') };
const repoPath = (a: Json): string => `/repos/${enc(str(a.owner))}/${enc(str(a.repo))}`;

const tools: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: prop('string', 'Repository name'), description: prop('string', 'Short description'), private: prop('boolean', 'Whether the repository is private') }, required: ['name'] },
    run: (a) => call('POST', '/user/repos', { name: a.name, description: a.description ?? '', private: a.private === true }),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { ...repoProps }, required: ['owner', 'repo'] },
    run: (a) => call('GET', repoPath(a)),
  },
  {
    name: 'list_repos',
    description: 'List the authenticated user\'s repositories.',
    inputSchema: { type: 'object', properties: { per_page: prop('number', 'Page size'), page: prop('number', 'Page number') }, required: [] },
    run: (a) => call('GET', `/user/repos?per_page=${Number(a.per_page ?? 30)}&page=${Number(a.page ?? 1)}`),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { ...repoProps, title: prop('string', 'Issue title'), body: prop('string', 'Issue body'), labels: prop('array', 'Existing label names', { items: { type: 'string' } }) }, required: ['owner', 'repo', 'title'] },
    run: (a) => call('POST', `${repoPath(a)}/issues`, { title: a.title, body: a.body ?? '', labels: a.labels ?? [] }),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, filtered by state.',
    inputSchema: { type: 'object', properties: { ...repoProps, state: prop('string', 'open, closed or all', { enum: ['open', 'closed', 'all'] }), per_page: prop('number', 'Page size') }, required: ['owner', 'repo'] },
    run: (a) => call('GET', `${repoPath(a)}/issues?state=${enc(str(a.state) || 'open')}&per_page=${Number(a.per_page ?? 100)}`),
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: { type: 'object', properties: { ...repoProps, issue_number: prop('number', 'Issue number') }, required: ['owner', 'repo', 'issue_number'] },
    run: (a) => call('GET', `${repoPath(a)}/issues/${Number(a.issue_number)}`),
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    inputSchema: { type: 'object', properties: { ...repoProps, issue_number: prop('number', 'Issue or pull request number'), body: prop('string', 'Comment text') }, required: ['owner', 'repo', 'issue_number', 'body'] },
    run: (a) => call('POST', `${repoPath(a)}/issues/${Number(a.issue_number)}/comments`, { body: a.body }),
  },
  {
    name: 'update_issue',
    description: 'Update an issue\'s title, body or state.',
    inputSchema: { type: 'object', properties: { ...repoProps, issue_number: prop('number', 'Issue number'), title: prop('string', 'New title'), body: prop('string', 'New body'), state: prop('string', 'open or closed', { enum: ['open', 'closed'] }) }, required: ['owner', 'repo', 'issue_number'] },
    run: (a) => {
      const patch: Json = {};
      for (const key of ['title', 'body', 'state']) if (a[key] !== undefined) patch[key] = a[key];
      return call('PATCH', `${repoPath(a)}/issues/${Number(a.issue_number)}`, patch);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { ...repoProps, title: prop('string', 'Pull request title'), head: prop('string', 'Head branch'), base: prop('string', 'Base branch'), body: prop('string', 'Description'), draft: prop('boolean', 'Open as a draft') }, required: ['owner', 'repo', 'title', 'head', 'base'] },
    run: (a) => call('POST', `${repoPath(a)}/pulls`, { title: a.title, head: a.head, base: a.base, body: a.body ?? '', draft: a.draft === true }),
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by number.',
    inputSchema: { type: 'object', properties: { ...repoProps, pull_number: prop('number', 'Pull request number') }, required: ['owner', 'repo', 'pull_number'] },
    run: (a) => call('GET', `${repoPath(a)}/pulls/${Number(a.pull_number)}`),
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: { type: 'object', properties: { ...repoProps, state: prop('string', 'open, closed or all', { enum: ['open', 'closed', 'all'] }) }, required: ['owner', 'repo'] },
    run: (a) => call('GET', `${repoPath(a)}/pulls?state=${enc(str(a.state) || 'open')}&per_page=100`),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (merge, squash or rebase).',
    inputSchema: { type: 'object', properties: { ...repoProps, pull_number: prop('number', 'Pull request number'), merge_method: prop('string', 'merge, squash or rebase', { enum: ['merge', 'squash', 'rebase'] }), commit_title: prop('string', 'Merge commit title') }, required: ['owner', 'repo', 'pull_number'] },
    run: (a) => {
      const body: Json = { merge_method: str(a.merge_method) || 'squash' };
      if (a.commit_title !== undefined) body.commit_title = a.commit_title;
      return call('PUT', `${repoPath(a)}/pulls/${Number(a.pull_number)}/merge`, body);
    },
  },
  {
    name: 'list_branches',
    description: 'List the branches of a repository.',
    inputSchema: { type: 'object', properties: { ...repoProps }, required: ['owner', 'repo'] },
    run: (a) => call('GET', `${repoPath(a)}/branches`),
  },
  {
    name: 'list_commits',
    description: 'List commits on a branch (default branch when sha is omitted).',
    inputSchema: { type: 'object', properties: { ...repoProps, sha: prop('string', 'Branch name or commit sha') }, required: ['owner', 'repo'] },
    run: (a) => call('GET', `${repoPath(a)}/commits${a.sha === undefined ? '' : `?sha=${enc(str(a.sha))}`}`),
  },
  {
    name: 'get_file_contents',
    description: 'Read a file or list a directory at a ref.',
    inputSchema: { type: 'object', properties: { ...repoProps, path: prop('string', 'Path in the repository'), ref: prop('string', 'Branch, tag or commit') }, required: ['owner', 'repo', 'path'] },
    run: (a) => call('GET', `${repoPath(a)}/contents/${str(a.path).split('/').map(enc).join('/')}${a.ref === undefined ? '' : `?ref=${enc(str(a.ref))}`}`),
  },
  {
    name: 'create_or_update_file',
    description: 'Create or update a file with a commit (content is plain text).',
    inputSchema: { type: 'object', properties: { ...repoProps, path: prop('string', 'Path in the repository'), content: prop('string', 'File content'), message: prop('string', 'Commit message'), branch: prop('string', 'Branch'), sha: prop('string', 'Blob sha when updating') }, required: ['owner', 'repo', 'path', 'content', 'message'] },
    run: (a) => {
      const body: Json = { message: a.message, content: Buffer.from(str(a.content), 'utf8').toString('base64') };
      if (a.branch !== undefined) body.branch = a.branch;
      if (a.sha !== undefined) body.sha = a.sha;
      return call('PUT', `${repoPath(a)}/contents/${str(a.path).split('/').map(enc).join('/')}`, body);
    },
  },
];

const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
// One fixed rendering: tools/list answers with the same bytes every time.
const toolList = tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function valid(value: unknown, type: string): boolean {
  if (type === 'array') return Array.isArray(value);
  if (type === 'number') return typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
  return typeof value === type;
}

function callTool(id: unknown, params: Json): Json {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = toolByName.get(name);
  if (tool === undefined) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
  const raw = params.arguments;
  const args: Json = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Json) : {};
  const problems: string[] = [];
  for (const key of tool.inputSchema.required) if (args[key] === undefined || args[key] === null || args[key] === '') problems.push(`missing required argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const spec = tool.inputSchema.properties[key];
    if (spec !== undefined && value !== null && !valid(value, String(spec.type))) problems.push(`argument ${key} must be of type ${String(spec.type)}`);
  }
  const reply = (text: string, isError: boolean): Json => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });
  if (problems.length > 0) return reply(`Invalid arguments for ${name}: ${problems.join('; ')}`, true);
  try {
    return reply(JSON.stringify(tool.run(args)), false);
  } catch (err) {
    if (err instanceof ToolError) return reply(err.message, true);
    return reply('Internal error', true);
  }
}

function handleOne(message: unknown, authorized: boolean): { reply: Json | null; unauthorized?: true } {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return { reply: rpcError(null, INVALID_REQUEST, 'Invalid Request') };
  const request = message as Json;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params: Json = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params) ? (request.params as Json) : {};
  if (method === '') return { reply: rpcError(id, INVALID_REQUEST, 'Invalid Request') };
  if (id === undefined) return { reply: null }; // a notification
  const capabilities = { tools: { listChanged: false } };
  switch (method) {
    case 'server/discover':
      return {
        reply: {
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            supportedVersions: REVISIONS,
            capabilities,
            serverInfo: SERVER_INFO,
            instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over the tools listed.',
            _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          },
        },
      };
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = REVISIONS.includes(asked) && asked !== REVISIONS[0] ? asked : '2025-11-25';
      return { reply: { jsonrpc: '2.0', id, result: { protocolVersion: chosen, capabilities, serverInfo: SERVER_INFO, instructions: 'A GitHub-compatible forge.' } } };
    }
    case 'ping':
      return { reply: { jsonrpc: '2.0', id, result: {} } };
    case 'tools/list':
      return { reply: { jsonrpc: '2.0', id, result: { tools: toolList } } };
    case 'tools/call':
      if (!authorized) return { reply: null, unauthorized: true };
      return { reply: callTool(id, params) };
    default:
      return { reply: rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`) };
  }
}

export interface McpResult {
  status: number;
  body: unknown;
}

/** Handle one POST /mcp body; `authorized` says the request carried a good bearer token. */
export function handleMcp(raw: Buffer, authorized: boolean): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, PARSE_ERROR, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const replies: Json[] = [];
    for (const entry of parsed) {
      const one = handleOne(entry, authorized);
      if (one.unauthorized === true) return { status: 401, body: { message: 'Requires authentication' } };
      if (one.reply !== null) replies.push(one.reply);
    }
    return replies.length === 0 ? { status: 202, body: null } : { status: 200, body: replies };
  }
  const one = handleOne(parsed, authorized);
  if (one.unauthorized === true) return { status: 401, body: { message: 'Requires authentication' } };
  return one.reply === null ? { status: 202, body: null } : { status: 200, body: one.reply };
}
