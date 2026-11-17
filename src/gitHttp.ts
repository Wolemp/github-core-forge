// Git smart HTTP at /{owner}/{repo}.git: the info/refs advertisements (upload-pack v2 and v0,
// receive-pack v0), upload-pack (v2 ls-refs and fetch with shallow/deepen, v0 want/have),
// and receive-pack (command list + pack, per-ref fast-forward checks, report-status).

import { gunzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAncestor, parseCommit, parseTree, readCommit, type ObjectStore } from './gitObjects.ts';
import { PackError, readPack, writePack } from './pack.ts';
import { VIEWER_LOGIN, findRepo, now, type Repo } from './store.ts';

const ZERO = '0'.repeat(40);
const AGENT = 'agent=github-core-forge/1.0';
const FLUSH = Buffer.from('0000');
const DELIM = Buffer.from('0001');

export function pkt(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}

interface Packet {
  kind: 'data' | 'flush' | 'delim';
  data: Buffer;
}

/** Read pkt-lines from `start` until `stopAfterFlush` flushes (or the end); returns the offset after them. */
function readPackets(buf: Buffer, start: number, stopAfterFlush: number): { packets: Packet[]; end: number } {
  const packets: Packet[] = [];
  let pos = start;
  let flushes = 0;
  while (pos + 4 <= buf.length) {
    const hex = buf.toString('latin1', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      pos += 4;
      flushes += 1;
      if (flushes >= stopAfterFlush) break;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('bad pkt-line');
    packets.push({ kind: 'data', data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, end: pos };
}

const text = (packet: Packet): string => packet.data.toString('utf8').replace(/\n$/, '');

function sideband(band: number, data: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let at = 0; at < data.length; at += 65515) out.push(pkt(Buffer.concat([Buffer.from([band]), data.subarray(at, at + 65515)])));
  return Buffer.concat(out);
}

function send(res: ServerResponse, status: number, type: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache, max-age=0, must-revalidate', pragma: 'no-cache' });
  res.end(body);
}

function plain(res: ServerResponse, status: number, message: string): void {
  send(res, status, 'text/plain; charset=utf-8', Buffer.from(`${message}\n`));
}

// ---- refs -----------------------------------------------------------------------------------

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const headRef = (repo: Repo): string => `refs/heads/${repo.defaultBranch}`;

/** The commit an annotated tag points at, or null for a plain ref. */
function peel(store: ObjectStore, sha: string): string | null {
  let current = sha;
  let peeled = false;
  for (let i = 0; i < 10; i += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag') break;
    const m = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    if (m === null) break;
    current = m[1];
    peeled = true;
  }
  return peeled ? current : null;
}

function advertiseV2(): Buffer {
  return Buffer.concat([pkt('version 2\n'), pkt(`${AGENT}\n`), pkt('ls-refs=unborn\n'), pkt('fetch=shallow wait-for-done\n'), pkt('server-option\n'), pkt('object-format=sha1\n'), FLUSH]);
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const upload = service === 'git-upload-pack';
  const caps = upload
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag object-format=sha1 symref=HEAD:${headRef(repo)} ${AGENT}`
    : `report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta object-format=sha1 ${AGENT}`;
  const lines: string[] = [];
  const head = repo.refs.get(headRef(repo));
  if (upload && head !== undefined) lines.push(`${head} HEAD`);
  for (const [ref, sha] of sortedRefs(repo)) {
    lines.push(`${sha} ${ref}`);
    const peeled = upload ? peel(repo.objects, sha) : null;
    if (peeled !== null) lines.push(`${peeled} ${ref}^{}`);
  }
  if (lines.length === 0) lines.push(`${ZERO} capabilities^{}`);
  lines.forEach((line, i) => parts.push(pkt(i === 0 ? `${line}\0${caps}\n` : `${line}\n`)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function lsRefs(repo: Repo, args: string[]): Buffer {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const target = headRef(repo);
  if (keep('HEAD')) {
    const head = repo.refs.get(target);
    if (head !== undefined) parts.push(pkt(`${head} HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`));
    else if (wantUnborn) parts.push(pkt(`unborn HEAD${wantSymrefs ? ` symref-target:${target}` : ''}\n`));
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    if (!keep(ref)) continue;
    const peeled = wantPeel ? peel(repo.objects, sha) : null;
    parts.push(pkt(`${sha} ${ref}${peeled !== null ? ` peeled:${peeled}` : ''}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---- object closure -------------------------------------------------------------------------

interface ClosureOptions {
  /** Follow commit parents (false: send just the named commits with their trees). */
  parents: boolean;
  /** Commits whose parents are not followed (the client's shallow boundary). */
  stop: Set<string>;
}

/** Every object reachable from `roots`, skipping ids already in `seen` (which is extended). */
function closure(store: ObjectStore, roots: Iterable<string>, seen: Set<string>, options: ClosureOptions): string[] {
  const out: string[] = [];
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const object = store.get(sha);
    if (object === undefined) continue;
    seen.add(sha);
    out.push(sha);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (options.parents && !options.stop.has(sha)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push(entry.sha);
    } else if (object.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (m !== null) stack.push(m[1]);
    }
  }
  return out;
}

function commitOf(store: ObjectStore, sha: string): string | null {
  const peeled = peel(store, sha) ?? sha;
  return readCommit(store, peeled) === null ? null : peeled;
}

interface FetchPlan {
  ids: string[];
  newShallow: string[];
  unshallow: string[];
  haveKnown: string[];
}

function planFetch(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null): FetchPlan {
  const store = repo.objects;
  const stop = new Set(clientShallow);
  const haveKnown = haves.filter((h) => store.has(h));
  const exclude = new Set<string>();
  closure(store, haveKnown, exclude, { parents: true, stop });
  if (depth === null) {
    const ids = closure(store, wants, exclude, { parents: true, stop: new Set() });
    return { ids, newShallow: [], unshallow: [], haveKnown };
  }
  const included = new Set<string>();
  const newShallow = new Set<string>();
  let level = wants.map((w) => commitOf(store, w)).filter((c): c is string => c !== null);
  for (let current = 1; level.length > 0; current += 1) {
    const next: string[] = [];
    for (const sha of level) {
      if (included.has(sha)) continue;
      included.add(sha);
      const commit = readCommit(store, sha);
      if (commit === null) continue;
      if (current >= depth && commit.parents.length > 0) newShallow.add(sha);
      else next.push(...commit.parents);
    }
    level = next;
  }
  const unshallow = clientShallow.filter((s) => included.has(s) && !newShallow.has(s));
  const ids = closure(store, [...included, ...wants.filter((w) => store.get(w)?.type === 'tag')], exclude, { parents: false, stop: new Set() });
  return { ids, newShallow: [...newShallow], unshallow, haveKnown };
}

// ---- upload-pack ----------------------------------------------------------------------------

function uploadV2(repo: Repo, packets: Packet[]): Buffer {
  const first = packets.find((p) => p.kind === 'data');
  const command = first === undefined ? '' : text(first).replace(/^command=/, '');
  const delim = packets.findIndex((p) => p.kind === 'delim');
  const args = (delim < 0 ? [] : packets.slice(delim + 1)).filter((p) => p.kind === 'data').map(text);
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command !== 'fetch') return Buffer.concat([pkt(`ERR unknown command ${command}\n`), FLUSH]);

  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Math.max(1, Number(arg.slice(7)) || 1);
    else if (arg === 'done') done = true;
  }
  for (const want of wants) {
    if (!repo.objects.has(want)) return Buffer.concat([pkt(`ERR upload-pack: not our ref ${want}\n`), FLUSH]);
  }
  const plan = planFetch(repo, wants, haves, clientShallow, depth);
  const parts: Buffer[] = [];
  if (!done) {
    parts.push(pkt('acknowledgments\n'));
    if (plan.haveKnown.length === 0) parts.push(pkt('NAK\n'));
    for (const have of plan.haveKnown) parts.push(pkt(`ACK ${have}\n`));
    if (plan.haveKnown.length === 0) {
      parts.push(FLUSH);
      return Buffer.concat(parts);
    }
    parts.push(pkt('ready\n'), DELIM);
  }
  if (depth !== null) {
    parts.push(pkt('shallow-info\n'));
    for (const sha of plan.newShallow) parts.push(pkt(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'), sideband(1, writePack(repo.objects, plan.ids)), FLUSH);
  return Buffer.concat(parts);
}

/**
 * v0 upload-pack over stateless HTTP. A request without `done` is a negotiation round: it answers the
 * shallow list (when deepening) and the acknowledgments for the haves. The request with `done` answers
 * ACK/NAK and the side-band pack.
 */
function uploadV0(repo: Repo, packets: Packet[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = text(packet);
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Math.max(1, Number(line.slice(7)) || 1);
    else if (line === 'done') done = true;
  }
  if (wants.length === 0) return FLUSH;
  const plan = planFetch(repo, wants, haves, clientShallow, depth);
  const parts: Buffer[] = [];
  // Stateless HTTP resends the shallow list in every response that answers a deepen request.
  if (depth !== null) {
    for (const sha of plan.newShallow) parts.push(pkt(`shallow ${sha}` + String.fromCharCode(10)));
    for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}` + String.fromCharCode(10)));
    parts.push(FLUSH);
  }
  if (!done) {
    if (haves.length > 0) {
      for (const have of plan.haveKnown) parts.push(pkt(`ACK ${have} common\n`));
      if (plan.haveKnown.length > 0) parts.push(pkt(`ACK ${plan.haveKnown[plan.haveKnown.length - 1]} ready\n`));
      parts.push(pkt('NAK\n'));
    }
    return Buffer.concat(parts);
  }
  if (plan.haveKnown.length === 0) parts.push(pkt('NAK\n'));
  else parts.push(pkt(`ACK ${plan.haveKnown[plan.haveKnown.length - 1]}\n`));
  parts.push(sideband(1, writePack(repo.objects, plan.ids)), FLUSH);
  return Buffer.concat(parts);
}

// ---- receive-pack ---------------------------------------------------------------------------

function receive(repo: Repo, body: Buffer): Buffer {
  let parsed: { packets: Packet[]; end: number };
  try {
    parsed = readPackets(body, 0, 1);
  } catch {
    return Buffer.concat([pkt('ERR malformed request\n'), FLUSH]);
  }
  const commands: { old: string; next: string; ref: string }[] = [];
  let useSideband = false;
  for (const packet of parsed.packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8');
    const nul = line.indexOf('\0');
    const main = (nul < 0 ? line : line.slice(0, nul)).replace(/\n$/, '');
    if (nul >= 0 && line.slice(nul + 1).split(/\s+/).includes('side-band-64k')) useSideband = true;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(main);
    if (m !== null) commands.push({ old: m[1], next: m[2], ref: m[3] });
  }
  const report: string[] = [];
  let unpack = 'ok';
  const needsPack = commands.some((c) => c.next !== ZERO);
  const pack = body.subarray(parsed.end);
  if (needsPack || pack.length > 0) {
    try {
      if (pack.length === 0) throw new PackError('missing pack');
      readPack(pack, repo.objects);
    } catch (err) {
      unpack = err instanceof PackError ? err.message : 'unpack failed';
    }
  }
  const results: string[] = [];
  if (unpack !== 'ok') {
    for (const c of commands) results.push(`ng ${c.ref} unpacker error`);
  } else {
    // Apply sequentially; a refused ref leaves the others to apply.
    for (const c of commands) results.push(applyCommand(repo, c));
  }
  report.push(`unpack ${unpack}\n`, ...results.map((r) => `${r}\n`));
  const inner = Buffer.concat([...report.map((line) => pkt(line)), FLUSH]);
  return useSideband ? Buffer.concat([sideband(1, inner), FLUSH]) : inner;
}

function applyCommand(repo: Repo, c: { old: string; next: string; ref: string }): string {
  if (!c.ref.startsWith('refs/') || /[\s~^:?*[\\]|\.\.|\/\/|\.lock$/.test(c.ref)) return `ng ${c.ref} funny refname`;
  const current = repo.refs.get(c.ref) ?? null;
  if (c.next === ZERO) {
    if (current === null) return `ng ${c.ref} reference does not exist`;
    if (c.ref === headRef(repo)) return `ng ${c.ref} deletion of the current branch prohibited`;
    if (c.old !== ZERO && c.old !== current) return `ng ${c.ref} stale info`;
    repo.refs.delete(c.ref);
    repo.updatedAt = now();
    return `ok ${c.ref}`;
  }
  const object = repo.objects.get(c.next);
  if (object === undefined) return `ng ${c.ref} missing necessary objects`;
  if (c.ref.startsWith('refs/heads/') && object.type !== 'commit') return `ng ${c.ref} bad object type`;
  if (current === null) {
    if (c.old !== ZERO) return `ng ${c.ref} stale info`;
  } else {
    if (c.old !== current) return `ng ${c.ref} stale info`;
    if (current !== c.next && !isAncestor(repo.objects, current, c.next)) return `ng ${c.ref} non-fast-forward`;
  }
  repo.refs.set(c.ref, c.next);
  repo.updatedAt = now();
  return `ok ${c.ref}`;
}

// ---- entry point ----------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const GIT_PATH = /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function isGitPath(path: string): boolean {
  return GIT_PATH.test(path);
}

/** Serve one smart-HTTP request. `authorized` was checked by the caller (401 otherwise). */
export async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const m = GIT_PATH.exec(url.pathname);
  if (m === null) return plain(res, 404, 'Not Found');
  let owner = m[1];
  let name = m[2];
  try {
    owner = decodeURIComponent(owner);
    name = decodeURIComponent(name);
  } catch {
    return plain(res, 404, 'Not Found');
  }
  const repo = owner.toLowerCase() === VIEWER_LOGIN.toLowerCase() ? findRepo(owner, name) : null;
  if (repo === null) {
    if (req.method === 'POST') await readBody(req).catch(() => undefined);
    return plain(res, 404, 'Repository not found');
  }
  const endpoint = m[3];
  const protocol = String(req.headers['git-protocol'] ?? '');
  if (endpoint === 'info/refs') {
    if (req.method !== 'GET') return plain(res, 405, 'Method Not Allowed');
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return plain(res, 403, 'Smart HTTP service required');
    const v2 = service === 'git-upload-pack' && protocol.split(':').includes('version=2');
    const body = v2 ? advertiseV2() : advertiseV0(repo, service);
    return send(res, 200, `application/x-${service}-advertisement`, body);
  }
  if (req.method !== 'POST') return plain(res, 405, 'Method Not Allowed');
  let raw = await readBody(req);
  if (String(req.headers['content-encoding'] ?? '').toLowerCase() === 'gzip') {
    try {
      raw = gunzipSync(raw);
    } catch {
      return plain(res, 400, 'bad gzip body');
    }
  }
  try {
    if (endpoint === 'git-upload-pack') {
      const v2 = protocol.split(':').includes('version=2');
      const packets = readPackets(raw, 0, v2 ? 1 : Infinity).packets;
      return send(res, 200, 'application/x-git-upload-pack-result', v2 ? uploadV2(repo, packets) : uploadV0(repo, packets));
    }
    return send(res, 200, 'application/x-git-receive-pack-result', receive(repo, raw));
  } catch {
    return send(res, 200, `application/x-${endpoint}-result`, Buffer.concat([pkt('ERR bad request\n'), FLUSH]));
  }
}
