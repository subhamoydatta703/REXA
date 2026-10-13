# Contributing to REXA

Thank you for your interest in contributing to REXA. REXA is an autonomous agent harness combining multi-agent orchestration, web research, verified code editing, Docker sandboxing, and dual-layer safety guardrails.

Contributions of all kinds are welcome: feature implementations, performance optimizations, documentation improvements, security enhancements, and bug fixes.

---

## Code of Conduct

All contributors and participants agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md). Please maintain a welcoming, respectful, and collaborative environment across issues, discussions, and pull requests.

---

## Getting started

### Prerequisites
- [Bun](https://bun.sh) version 1.1 or higher
- [Node.js](https://nodejs.org/) version 18 or higher
- ripgrep (`rg`) on the host PATH for repository discovery, search, and verification snapshots
- [Docker Desktop](https://www.docker.com/) for sandboxed command execution
- A Google Gemini API key for running live agent sessions
- A REXA CLI account token for normal interactive startup; use `rexa login` for setup
- Optional: a Tavily API key for provider search/extraction. Search falls back to DuckDuckGo when Tavily is absent or fails.
- Optional: a Bright Data account API token with LinkedIn Profiles scraper access for live profile extraction. Mocked web tests do not require it.

### Local development setup

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/subhamoydatta703/REXA.git
   cd REXA
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Verify TypeScript compilation:
   ```bash
   bun run typecheck
   ```

4. Launch the development CLI:
   ```bash
   bun run rexa
   ```

---

## Architecture overview for contributors

Before submitting pull requests, familiarize yourself with REXA's core subsystems:

- **Orchestration layer (`src/orchestration/`)**:
  - `Orchestrator.ts`: Manages input validation, status updates, and execution dispatching.
  - `Supervisor.ts` & `SupervisorPrompt.ts`: Classifies user requests into `DIRECT`, `CODE_ONLY`, `RESEARCH_ONLY`, or `RESEARCH_AND_CODE` routing paths.
- **Agent layer (`src/agent/`)**:
  - `ResearchAgent.ts`: Read-only external researcher using `search` and `read_url`; returns information directly or supplies research data for coding tasks.
  - `Agent.ts`: Core coding agent executing up to 60-step task loops with autonomous tool plan reflection before execution.
  - `DebuggingAgent.ts`: Inspects source, creates/reuses tests, and investigates/repairs recorded failures within a shared step budget. It submits checks; the application runs them.
  - `AgentMode.ts`: Manages `plan` (read-only, design-focused) and `act` (autonomous tool execution) modes.
- **Tooling suite (`src/tools/`)**:
  - `ToolRegistry.ts` & `ToolDispatcher.ts`: Register tool schemas and enforce mode, argument validation, and permissions. Startup registers repository, editing, process, Git, web, and memory tools; do not assume a fixed count of nine.
  - `RepositoryTools.ts` & `Workspace.ts`: Provide ignore-aware discovery, numbered reads with whole-file hashes, code search, and file-tool path restrictions.
  - `SafeEditor.ts`, `CheckpointStore.ts` & `StaleEditRecovery.ts`: Validate edits, checkpoint eligible text changes, detect outdated contents, and enforce fresh-read/retry limits. Multi-file writes are not an OS-atomic transaction.
  - `executeTools.ts`, `ExecutionManager.ts` & `ProcessManager.ts`: Run permission-controlled Docker commands and manage background processes, cancellation, and timeouts. `CommandPolicy.ts` handles Git operation/clone checks; the executable-name schema is not a command allowlist.
  - `sandbox-supervisor.ts`: Runs with Bun inside Linux and manages command process groups and descendant cleanup. Python remains available as a container tool.
  - `GitTools.ts`: Runs `/app` Git operations on the host; clones and `/workspace` operations use Docker. Host hooks/helpers and external Git effects are outside text-checkpoint undo.
  - `SearchTool.ts`: Discovers sources with Tavily or DuckDuckGo; search snippets are not page contents.
  - `ReadUrlTool.ts` & `web/`: Read exact URLs with DNS-pinned HTTP, content extraction, and a Node/Chromium fallback. Browser requests use the same bounded transport.
  - `web/LinkedInReader.ts`: Routes personal LinkedIn `/in/` URLs through Bright Data's LinkedIn Profiles scraper. Submits one collection per read, polls progress, checks the returned profile URL, and provides available fields with retrieval time. It uses a fixed API origin with redirects disabled and bounded responses and timeouts.
  - `MemoryTools.ts`: Calls authenticated cloud save/search endpoints for explicit preferences. This client does not establish the server's database or search algorithm.
- **Verification (`src/verification/`)**:
  - `VerificationWorkflow.ts`: Coordinates preparation, checks, repair decisions, and completion/blocking.
  - `VerificationRunner.ts`: Discovers optional baselines, executes checks through the dispatcher, captures real output/exit codes, and observes workspace stability.
  - `VerificationResults.ts`: Defines validated evidence/submissions and generates reports. Keep the folder to these three files; the debugging agent belongs in `src/agent/`.
- **Guardrails & safety (`src/guardrails/`)**:
  - `input/InputGuardrails.ts` and `output/OutputGuardrails.ts`: Combine local checks and model-backed classification. Model checks can fail or miss issues; do not describe them as guaranteed prevention.
  - `types/SecretScanner.ts`: Uses recognized-secret patterns and Shannon entropy checks (default threshold 4.5); redaction is pattern-based and does not guarantee removal of every secret.
- **Terminal UI (`src/cli/`)**:
  - `AgentCLI.ts` & `AgentUI.ts`: Manages raw terminal input, multi-line composing, mode switching (`Tab`), streaming markdown, and error translation.
  - `LocalCommands.ts`: Handles sessions, compaction, diffs, undo, permission display, and owned processes. Provider/model/reasoning commands are planned, not present.
  - `OptionalApiSetup.ts`: Explains optional Tavily/Bright Data setup, accepts only uppercase Y/N, and opens masked key input after Y.

See [DEVELOPMENT.md](./DEVELOPMENT.md) for lifecycle rules, readability conventions, and the [current provider boundary](./DEVELOPMENT.md#current-provider-boundary-and-planned-cosmos-work). Current runtime provider support is Gemini. Phase 1 adds shared messages/tool-call IDs and a capability catalog; OpenAI/Anthropic adapters and Cosmos selection controls remain future implementation work.

Put provider-specific code under `src/providers/gemini/`, `openai/`, or `claude/`; keep shared settings and catalog code in `src/providers/`. Shared agent and session messages must not import an SDK's message types. Preserve call IDs and provider-native signatures, and cover repeated tool names and older transcripts when changing the protocol. Catalog entries need official capability sources and review dates; do not infer effort support or account access from a model name alone.

Phase 2 provides provider-aware key storage and `rexa config set-provider-key`, `set-provider`, and `show-provider`. Test setup with isolated homes and mocked vaults so tests cannot alter developer credentials. Cover environment precedence, old config migration, independent vault failures, cancelled prompts, rejected saves, and exact-value redaction in logs/transcripts/reports. Runtime adapters and slash-command selection still belong to later phases.

When reviewing configuration changes, distinguish a successful credential save from a successful preference save and from a successful API request. They are separate outcomes. Keep command help and the README explicit about runtime support. A configuration-only OpenAI/Claude selection must not accidentally start Gemini or prompt for its key. See [provider storage and setup sequence](./DEVELOPMENT.md#provider-preference-storage-and-setup-sequence) for the persisted shape and ordering requirements.

---

## Contribution standards

### Strict TypeScript compliance
The project enforces strict TypeScript checking. Prefer concrete types or validated `unknown`, avoid new unchecked casts, and handle nullability explicitly. The existing shared tool execution boundary uses dynamic argument/result types; this is not evidence that every file is free of `any`:

```bash
bun run typecheck
```

### Verification and tests

For code changes, run type checking and the relevant regression suites. Core fixtures include repository tools, planning, permissions, safe editing, sessions, optional setup, and debugging/verification. Docker tests exercise actual container commands; browser tests need Chromium. Most model responses and external providers in the regression suites are fixtures, not live services.

```bash
bun run test:core
bun run test:web
bun run test:docker
bun run test:web:browser
```

Install the browser runtime when needed with `bunx playwright install --with-deps chromium --only-shell`. Docker tests require a running daemon and host ripgrep. CI currently runs type/core/web/browser checks on Linux and Windows using Bun `1.4.2`, with a separate Linux Docker job. The workflow explicitly installs host ripgrep; its presence inside Docker alone is insufficient.

For web-only changes, the fixture suite can be run separately:

```bash
bun run test:web
```

The suite includes `tests/web/linkedin.test.ts`, which injects mock HTTP responses, credentials, and time. It covers profile routing and URL matching, async collection polling, missing or incorrect credential types, timeouts, provider errors, response size limits, and credential redaction. These checks do not call Bright Data or consume credits.

For a live manual check, follow the [LinkedIn profile extraction setup](README.md#linkedin-profile-extraction). Use an account API token, not Playwright/Selenium connection credentials, and confirm scraper access and available credits. Each read starts a provider collection; timed-out collections can still consume credits. Never put live tokens or personal profile response dumps into test fixtures.

### Zero-emoji policy
To ensure clean terminal presentation and compatibility across diverse terminal emulators, do not include emojis in CLI output messages, spinner statuses, system prompts, error strings, or core documentation.

### Security and credential handling
- Never log, store, or output plaintext API keys, tokens, or passwords.
- Always utilize `SecretScanner.redact()` when emitting log lines or tool outputs containing arbitrary string content.
- Never weaken Docker container constraints (`cap_drop: [ALL]`, non-root user `1000:1000`, memory and CPU limits).

### Docker sandbox verification
When modifying execution tooling (`src/tools/executeTools.ts`, `ExecutionManager.ts`, or `docker-compose.yaml`), verify that:
1. Commands run inside the non-root sandbox container.
2. Cloned repositories stay isolated in `/workspace`.
3. The intended host project is mounted at `/app`, and working-directory validation rejects escape paths. Approved commands can change that writable mount; file-tool protected paths do not constrain interpreter code.
4. Timeout/cancellation stops container descendants, and completed commands preserve real exit codes.
5. Verification distinguishes failed assertions from unavailable snapshots, denied checks, and timeouts. Inspect recorded details instead of expanding permissions to hide an environment failure.

### Debugging and verification changes

Keep test preparation and diagnosis in `DebuggingAgent`, command execution in `VerificationRunner`, decisions in `VerificationWorkflow`, and schemas/reports in `VerificationResults`. The debugging agent has repository read/edit tools and structured submission, not direct command access. Every repair must be followed by fresh execution against current code.

Preserve meaningful expectations, baseline commands, coverage references, permissions, stale-edit recovery, and task budgets. Test-file changes during repair need an explanation. Actual command output and file/line clues must remain separate from model-inferred root causes. A passing selected test does not prove the entire application is error-free.

Use descriptive names, small focused functions, explicit branches, braces, and four-space indentation. Keep protocol and persisted-field compatibility visible during refactors. Add meaningful regression coverage for changed behavior; documentation-only changes generally need link/format checks rather than application tests.

---

## Making changes and pull requests

1. **Create a topic branch**:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Follow Conventional Commits**:
   Commit messages should adhere to the [Conventional Commits](https://www.conventionalcommits.org/) specification:
   - `feat: <summary>` for new features
   - `fix: <summary>` for bug fixes
   - `docs: <summary>` for documentation updates
   - `refactor: <summary>` for non-breaking architectural improvements
   - `test: <summary>` for test additions or fixtures
   - `chore: <summary>` for build system or dependency updates

3. **Verify locally**:
   Ensure all checks pass before pushing:
   ```bash
   bun run typecheck
   bun run test:core
   bun run test:web
   bun run src/index.ts --help
   ```

4. **Submit a Pull Request**:
   - Provide a clear description of the problem solved and the implementation approach.
   - Reference any related issues or discussions.
   - Ensure the CI workflow passes on GitHub.
   - Report actual checks and limitations. Distinguish fixture results, live-provider checks, and checks not run. Include Docker/browser results when those paths change.

---

## Security vulnerability disclosures

If you discover a security vulnerability — such as a credential leak, a sandbox escape, a guardrail bypass, or an arbitrary command execution flaw:

- **Do not post vulnerabilities in public GitHub issues or discussions.**
- Please report the issue privately through GitHub Security Advisories or contact the maintainer directly via their GitHub profile.
- Include reproduction steps and environment details to assist in rapid triage and patching.

---

## Questions and support

For questions, feature proposals, or general feedback:
- Search existing [GitHub Issues](https://github.com/subhamoydatta703/REXA/issues) to avoid duplicates.
- Open an issue detailing your operating system, Bun version, and REXA version.

Thank you for contributing to REXA.
