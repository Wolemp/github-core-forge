# github-core-forge

A GitHub-compatible git forge in one Node 22 process with no dependencies: it keeps repositories in
memory, speaks git over smart HTTP, and serves GitHub's REST v3, GraphQL v4 and an MCP endpoint over
the same data. Built for [github-core-clone-01](https://make.fun/bounty/github-core-clone-01).

```sh
node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL; see main.ts for the lifecycle
```

`main.ts` is the harness lifecycle (bind an ephemeral port, register it, poll `/done`, exit 0).
Everything else is `app.ts` and `src/`:

| file | what it does |
| --- | --- |
| `app.ts` | the HTTP server: routing, bearer auth, JSON errors, request ids |
| `src/gitObjects.ts` | blobs, trees, commits as raw bytes keyed by sha-1; merge base, three-way tree merge |
| `src/pack.ts` | packfile reader (OFS/REF deltas, thin packs, checksum) and writer (objects deflated once, cached) |
| `src/gitHttp.ts` | `/{owner}/{repo}.git`: upload-pack v2 (`ls-refs`, `fetch` with shallow/deepen) and v0, receive-pack v0 with per-ref fast-forward checks and side-band-64k report-status |
| `src/store.ts` | repositories, refs, labels, issues, pull requests; squash/merge-commit merge; file diffs |
| `src/rest.ts` | REST v3: repos, contents, refs, branches, commits, labels, issues, comments, pulls |
| `src/graphqlParser.ts`, `src/graphql.ts` | a GraphQL parser, a schema table with introspection, an executor, Relay global ids, cursor pagination; mutations call the REST handlers |
| `src/mcp.ts` | JSON-RPC 2.0 over `POST /mcp`: `server/discover`, `initialize`, `tools/list`, `tools/call` (16 tools) |

## Decisions worth knowing

- **One source of truth.** A contents `PUT` makes a real blob, tree and commit, so a file written over
  REST is what `git clone` fetches, and a branch pushed with git is what a pull request opens from.
  GraphQL mutations and MCP tools call the REST handlers, so the three surfaces share validation.
- **A repository belongs to the token's login.** The suite's token names the seeded viewer; the same
  name under any other owner is a 404, never a 403. Override the login with `MAKEFUN_VIEWER_LOGIN`.
- **Merging is a three-way tree merge** from the nearest common ancestor. A path both sides changed
  differently is a conflict (405); squash gives one parent, merge gives two.
- **Packs are written once.** Each object is deflated the first time it is sent and the bytes are kept,
  so a hot clone is a concatenation and a checksum.
- **Deterministic behaviour.** Nothing in a response depends on timing or randomness beyond commit
  timestamps, so a replayed trial reaches the same pass/fail results.

## Check it

The conformance suite ships with the kit (`sdk/run.ts`). Start the server on a port and point the suite
at it; a fresh server per run, because the suite creates its repositories through the API.

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8099 --token <token> --perf
```

It is also usable with a real `git` binary: `git clone`, `--depth 1`, push, fast-forward fetch and a
refused non-fast-forward push were exercised against it by hand.

MIT licensed.
