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
- [Docker Desktop](https://www.docker.com/) for sandboxed command execution
- A Google Gemini API key for running live agent sessions
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
  - `AgentMode.ts`: Manages `plan` (read-only, design-focused) and `act` (autonomous tool execution) modes.
- **Tooling suite (`src/tools/`)**:
  - `ToolRegistry.ts`: Registers the 9 tools and their Zod parameter schemas.
  - `CodingTools.ts` & `FileTools.ts`: Provides verified atomic file modifications and directory traversal.
  - `executeTools.ts` & `CommandPolicy.ts`: Manages Docker container commands, command whitelists, and confirmation policies.
  - `SearchTool.ts`: Discovers sources with Tavily or DuckDuckGo; search snippets are not page contents.
  - `ReadUrlTool.ts` & `web/`: Read exact URLs with DNS-pinned HTTP, content extraction, and a Node/Chromium fallback. Browser requests use the same bounded transport.
  - `web/LinkedInReader.ts`: Routes personal LinkedIn `/in/` URLs through Bright Data's LinkedIn Profiles scraper. Submits one collection per read, polls progress, checks the returned profile URL, and provides available fields with retrieval time. It uses a fixed API origin with redirects disabled and bounded responses and timeouts.
  - `MemoryTools.ts`: Handles authenticated cloud memory storage and semantic recall.
- **Guardrails & safety (`src/guardrails/`)**:
  - `InputGuardrails.ts`: Detects prompt injections, jailbreaks, and malicious directives.
  - `OutputGuardrails.ts`: Prevents credential leaks and unauthorized system prompt disclosures.
  - `SecretScanner.ts`: Uses regex detection and Shannon entropy calculations (threshold 4.5) to redact secrets.
- **Terminal UI (`src/cli/`)**:
  - `AgentCLI.ts` & `AgentUI.ts`: Manages raw terminal input, multi-line composing, mode switching (`Tab`), streaming markdown, and error translation.

---

## Contribution standards

### Strict TypeScript compliance
The project enforces strict TypeScript checking. All changes must pass type checking cleanly without introducing any `any` casts or unhandled nullability:

```bash
bun run typecheck
```

### Web retrieval verification

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
3. Workstation project directories remain confined to `/app`.

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
   bun run src/index.ts --help
   ```

4. **Submit a Pull Request**:
   - Provide a clear description of the problem solved and the implementation approach.
   - Reference any related issues or discussions.
   - Ensure the CI workflow passes on GitHub.

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
