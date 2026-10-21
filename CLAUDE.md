# CLAUDE.md

Security takes **absolute precedence**. This repository meters usage for Mozilla entitlements and handles relying-party credentials and user identifiers.

## 1) Scope & Writes

- Operate strictly under the repository root; normalize paths; do not follow symlinks outside the repo.
- **Writes allowed** to working tree; always present a diff for review **before** any staging/commit.
- Do not modify files adjacent to the requested change; mention issues found but do not fix them.
- **Ask first** for any command (build/test/install, DB ops, git, services). Do **not** run `git add/commit/push/rebase` unless explicitly told to.

## 2) Non-Negotiables

- **Secrets:** never read/print/summarize/transmit secret files/values; use placeholders (`YOUR_API_KEY_HERE`). The committed root `dev.env` holds local-only defaults; real values belong in `dev.local.env` (gitignored, do not read).
- **External network:** only with explicit approval to a trusted/documented endpoint.
- **Pipelines & contracts:** flag breaking API/contract changes, including the metering HTTP API, the Pub/Sub wire event, and the webhook payload and signature.
- **Published migrations:** **NEVER edit** existing ClickHouse migration files under `libs/metering/migrations/clickhouse/`. Add a new forward migration and bump `target-patch.json`. See that directory's README for the schema constraints.

## 3) Do-not-touch paths (no read, no write)

_Note:_ This list must mirror `.gitignore`. If there is a discrepancy, `.gitignore` is the source of truth.

- **Secrets:** `dev.local.env`, `.env`, `.env.local`, `.env.*.local`, `**/*.env` (except `dev.env`), `secrets.json`, `secret*`, `**/*.gpg`, `.keys`
- **Dependencies:** `**/node_modules/`
- **Generated / Artifacts / Runtime / Cache:**
  `**/dist/**`, `**/.nx/cache/**`, `**/.nx/workspace-data/**`, `**/.eslintcache`, `**/*.tsbuildinfo`,
  `**/(coverage|artifacts|logs|tmp)/**`, `**/*.log*`, `**/version.json`, `_dev/firebase/.cache`, `_dev/firebase/.config`
- **Generated, read-only:** `libs/shared/cms/src/__generated__/**`. Regenerate with `nx run shared-cms:codegen`; never hand-edit.
- **System/Editor:** `.DS_Store`, `Thumbs.db`, swap files, `.idea/`

> If a path matches both allowed and disallowed rules, **Disallowed wins**.

## 4) Repository Layout

Nx monorepo, pnpm, NestJS. Every app is built with webpack into `dist/apps/<app>` and shipped in one production image.

- **Apps (`apps/*`):**
  - `api`: HTTP API on port 3037. Usage ingest and query, usage grants, heartbeat and version endpoints, Swagger.
  - `metering-subscriber`: Pub/Sub consumer on port 3038 that dedupes events in Redis and writes them to ClickHouse. Only serves heartbeat endpoints over HTTP.
  - `metering-sweep`: one-shot job that checks meter thresholds and dispatches webhooks, then exits. Runs as a CronJob in production.

- **Libraries (`libs/*`):**
  - `libs/metering`: all metering domain logic, controllers, ClickHouse client, and ClickHouse migrations.
  - `libs/shared/cms`: Strapi GraphQL client with memory and Firestore caching, and the meter configuration query.
  - `libs/shared/*`: StatsD, Firestore, type-cacheable adapters, base errors, Sentry setup, and NestJS API helpers.

- **Conventions:**
  - **Imports:** use `@entitlements/<path>` aliases from `tsconfig.base.json` (e.g., `@entitlements/shared/error`); avoid deep relative imports across library boundaries.
  - **Layering:** controller → service → manager → repository/client. Business logic lives in services and managers; controllers stay thin.
  - **Tests:** co-located `*.spec.ts`. Integration tests are `*.in.spec.ts` and need local infrastructure.
  - **Config:** `nest-typed-config` classes validated with `class-validator`, loaded from env vars with `__` as the nesting separator (e.g., `METERING_CONFIG__CLICKHOUSE__URL`). Apps never read env files; Docker Compose injects `dev.env` and `dev.local.env`. Don't add root `.env` files: Nx loads them into every task. Each app declares its own `RootConfig` in `apps/<app>/src/config`.

### Preferred targets & anti-duplication

- **Prefer `libs/*` over app-local code** for reusable logic. Apps should only wire modules, config, and entry points.
- **Avoid partial refactors:** when moving logic, complete the path (call sites, tests, docs).
- **No duplication:** before adding code, search the repo for existing helpers/types; reuse or consolidate.

## 5) How to Run

_Note:_ For authoritative targets, check each project's **`project.json`**.

- **Install:** `pnpm install`
- **Everything (Docker):** `./dev.sh up`. Builds the dev image, starts ClickHouse, Redis, and the Firebase emulators (Firestore and Pub/Sub), runs ClickHouse migrations, then starts all three apps with watch-mode rebuilds.
- **Infrastructure only (for integration tests):** `./dev.sh infra`
- **Logs / status:** `./dev.sh logs-apps`, `./dev.sh logs-infra`, `./dev.sh ps`. Run `./dev.sh` with no arguments for every command.
- **Strapi:** not part of the compose stack. Point `STRAPI_CLIENT_CONFIG__GRAPHQL_API_URI` and `STRAPI_CLIENT_CONFIG__API_KEY` at a Strapi instance in `dev.local.env`.
- **Nx:** `nx build <app>`, `nx lint <project>`, `nx typecheck <project>`, `nx test-unit <project>`, `nx test-integration metering`, `nx serve <app>`
- **Single test file:** `pnpm jest -c <project>/jest.config.ts <path/to/file.spec.ts>`
- **ClickHouse migrations:** `./dev.sh migrate`, or `nx run metering:migrate-clickhouse` against the env-configured server.
- **Production image:** `docker build -f Dockerfile.production .`. The image has no default command; deployments run `node dist/apps/<app>/main.js`.

> When asked, show the exact minimal command block you intend to run; wait for approval.

## 6) Commits & Pull Requests

Keep commits and PRs short and to the point. No superfluous detail.

**Commits:** subject is `type(scope): lowercase imperative summary`, ≤72 chars. A small change gets only the subject. A larger change adds one bullet each under `Because:` and `This commit:`, plus `Closes ENT-N` when there is a ticket.

```
feat(metering): add usage grants

Because:

- We want to raise a subject's limit without changing the meter

This commit:

- Adds endpoints to create, list, and delete usage grants

Closes ENT-37
```

```
fix(deps): add @opentelemetry/semantic-conventions as a runtime dep
```

**Pull requests:** the title follows the commit subject format. The body follows `.github/PULL_REQUEST_TEMPLATE.md`, with one or two bullets per section. Open PRs as drafts. Leave the checklist boxes unchecked for the author to tick.

**Releases:** every merge to `main` tags a release from the commit types. `feat` bumps minor, `!` or `BREAKING CHANGE` bumps major, and every other type bumps patch. Patch an older release from an `N.N.x` branch cut from its latest tag.

See section 8 for phrasing.

## 7) Testing Guidelines

> Detailed test rules auto-load from `.claude/rules/testing/base.md` for any `*.spec.ts`.

**Shift-left is a golden goal.** Prefer testing business logic at the lowest layer that exercises it. This repo has two layers, cheapest to costliest: unit (`nx test-unit`) and integration (`nx test-integration`, against real ClickHouse and Redis). Controllers should be thin shells; their tests cover wiring (auth, request/response shape, error mapping), not business branches. When a controller has more than ~3 tests differing only in input shape, that's the signal to extract the rule into a pure function and unit-test it directly. Shifting left is not required for every change — but always strive for it, and flag the opportunities to improve.

## 8) Conciseness & Writing Style

**Be concise.** Applies to commit messages, PR bodies, Jira tickets, and code comments.

- **Cut items before compressing sentences.** Shorten by dropping a point or folding two together; tightening a point worth keeping is fine, but don't squeeze every point into a semicolon-spliced fragment. What survives should read like a person wrote it.
- **One claim per bullet.** In commit messages, PR bodies and tickets, state what changed. Give the reason only when it isn't inferable and lives nowhere else.
- **Comments state what is true, not what changed.** They're read cold, with no diff — so "used to", "no longer" and "we decided in review" belong in the commit's `Because:` section instead. Detailed rules auto-load from `.claude/rules/code-comments.md` when you touch JavaScript/TypeScript.
- **Meta-commentary must save the reader work.** Out-of-scope notes and rejected alternatives earn their place when a reviewer would otherwise ask; narrating the diff's boundaries doesn't.
- **Ticket refs in code only where the history is the answer.** Put the why in the comment. An `ENT-123` pointer fits when the code reads as complex or non-standard and the explanation outgrows a comment — a workaround, an external constraint. Not in test names. Leave existing refs alone.
- **Paths earn their place.** Name a file when it saves the reader a search. Skip it when the diff or a reference section already points there.
