# REXA

> A general-purpose, single-agent development harness. REXA understands a task, gathers context, reflects on its own plan, writes or edits code, runs commands, searches the web, investigates failures, and reports the result — all through one continuous conversation of up to 60 reasoning steps.

<br/>

<p align="center">
  <img src="https://img.shields.io/github/license/subhamoydatta703/REXA" alt="License">
  <img src="https://img.shields.io/github/stars/subhamoydatta703/REXA?style=social" alt="Stars">
  <img src="https://img.shields.io/github/actions/workflow/status/subhamoydatta703/REXA/ci.yml?branch=main&label=CI" alt="CI">
  <img src="https://img.shields.io/npm/v/rexa-agent" alt="npm version">
  <img src="https://img.shields.io/npm/dt/rexa-agent" alt="npm downloads">
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1dc" alt="Runtime: Bun">
</p>

> **Warning:** Experimental agent harness. Review tool requests carefully and do not run REXA against sensitive data without understanding its permissions and Docker configuration.

## Why REXA is more than a tool runner

REXA is an agent, not a collection of disconnected commands. The model decides which capabilities are needed, calls them in sequence, observes their results, and continues until it can answer or complete the task. Before executing any tool call, REXA reflects on its own proposed plan — if the plan is flawed, redundant, or hallucinated, it scraps it and re-generates before touching anything.

A single request can combine repository inspection, code changes, Git operations, command execution, web research, and verification. For example, a request to fix a bug causes REXA to:

1. Map the project and locate relevant files.
2. Read the implementation and its surrounding context.
3. Reflect on the proposed plan and revise if needed.
4. Form a focused code change using `edit`, `create`, or `write`.
5. Re-read the modified file to reason from the actual result.
6. Run the appropriate type checks or tests in the Docker sandbox.
7. Inspect failures and iterate.
8. Explain what changed and what was verified.

## Demo

![REXA demo](docs/demo.gif)

> **Tip:** Want a live demo here? Record a short terminal session (`vhs`, `peek`, or `asciinema`) and save it as `docs/demo.gif`. A moving demo of REXA fixing a failing test is the single biggest star-driver for a dev tool.

```text
$ bun run rexa

 ____  _______  __    _
|  _ \| ____| \/ /   / \
| |_) |  _|  \  /   / _ \
|  _ <| |___ /  \  / ___ \
|_| \_\_____/_/\_\/_/   \_\

+-----------------------------------------------+
|  REXA CLI  v1.0.0 |  Autonomous Agent Harness  |
+-----------------------------------------------+

  > Yo, it's me... REXA. What's the plan?

  > Find why the auth test is failing and fix it.

  * get_project_tree    running...
  + get_project_tree    done (0.3s)
  * coding_context_tool running...
  + coding_context_tool done (0.2s)
  * code_tool          running...
  + code_tool          done (0.1s)
  * execute_command    running [bun test]
  + execute_command    done (3.1s)

  rexa . 20:01

  Found the issue -- missing null check on line 42 of auth.ts.
  Fixed with a guard clause.  All tests pass.
```

## Quick start

```bash
# 1. Install REXA
npm install -g rexa-agent
# or from source: git clone https://github.com/subhamoydatta703/REXA.git && cd REXA && bun install

# 2. Run it inside any repo you want to work on
cd path/to/your/repository
rexa
```

On first launch REXA opens [the REXA website](https://rexa-agent-web.vercel.app/) so you can sign in and generate a CLI token. Paste that token in the terminal (masked input). After the server accepts it, REXA asks for your Gemini API key if one is not already stored.

Type a task (for example `Find why the auth test is failing and fix it.`) and press Enter. Type `exit` or `quit` to leave.

See [Account login](#account-login) and [Configuration & API keys](#configuration--api-keys) for the credential vault, and [Docker sandbox](#docker-sandbox) for how commands are isolated.

## Capabilities

- **Continuous agent loop** — up to 60 steps per task (configurable via `--max-steps`).
- **Plan reflection** — the agent reflects on its own proposed tool calls before executing; bad or redundant plans are discarded and re-generated.
- **Autonomous coding workflow** — understand context, create files, apply targeted edits, and re-read the file after every change to reason from the actual result.
- **File tools** — find, read (single and batch), create, edit (before/after/replace/delete), append, count, list, and delete files, scoped to the active project.
- **Project tree inspection** — inspect the full directory tree for deep structural context.
- **Sandboxed command execution** — commands run inside Docker with a 60-second default timeout (configurable up to 5 minutes); the process is hard-killed on timeout.
- **Git operations with explicit approval** — every mutating Git command (clone, add, commit, push, pull, fetch, merge, rebase, reset, clean, checkout, switch, branch, tag) requires user confirmation before running.
- **4-tier web search** — Tavily (if configured) → GitHub API (for `github.com` URLs) → DuckDuckGo → direct webpage fetch.
- **Dual guardrail system** — a separate Gemini Flash Lite model inspects every user input and every agent output independently.
- **Secret scanning on every pass** — regex pattern matching plus Shannon entropy analysis to catch high-entropy credential strings.
- **Website account login** — first run opens the REXA site; a CLI token is verified with the backend, then stored like other credentials.
- **Secure credential storage** — API keys and the CLI auth token are stored via `keytar` in the OS vault: Windows Credential Manager, macOS Keychain, or libsecret on Linux.
- **Rich CLI** — progress spinners, tool status lines with timing, and markdown-rendered responses in the terminal.

## Example tasks

REXA can help with tasks such as:

- "Explain this project's architecture and identify its main entry points."
- "Add input validation to the user registration flow, then run the type checker."
- "Find why this test is failing, fix the smallest correct cause, and verify it."
- "Review this repository for exposed secrets and unsafe file operations."
- "Clone https://github.com/example/repo in the sandbox, inspect its dependencies, and summarize its security posture."

## Account login

REXA requires a website account before the agent starts.

1. Sign in at [https://rexa-agent-web.vercel.app/](https://rexa-agent-web.vercel.app/) and generate a CLI token (tokens are short-lived; generate a new one if it expires).
2. Paste the token in the CLI when prompted. Do not paste it as a chat message — use the login prompt, `rexa login`, or the vault.
3. REXA sends the token to the backend (`POST https://rexa-server.onrender.com/api/cli/verify` with `Authorization: Bearer …`). The token is never written to git and is not logged.
4. After a successful verify, REXA continues to Gemini API key setup, then the agent.

```bash
rexa login    # paste a new token and verify
rexa logout   # remove the saved token
```

Saved tokens are stored the same way as Gemini keys (`keytar`, with encrypted fallback in `~/.rexa/config.json`). Each start re-checks the token with the server. If it is expired, revoked, or you generated a new one on the site, REXA asks you to paste again.

Paste the token only at the login prompt. Input guardrails will reject a token pasted into the agent chat.

## Configuration & API keys

### Environment variables

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` or `GOOGLE_GEMINI_API_KEY` | Main agent model |
| `GEMINI_GUARD_API_KEY` | Input/output guardrail model (Gemini Flash Lite) |
| `GEMINI_STREAMING_API_KEY` | Streaming provider initialization |
| `TVLY_API_KEY` or `TAVILY_API_KEY` | Optional Tavily search |
| `REXA_CLI_TOKEN` | Optional CLI auth token (otherwise stored in the vault) |
| `REXA_WEB_URL` | Override the site opened for login (default: the REXA website) |
| `REXA_VERIFY_URL` | Override the token verify endpoint (default: Render API) |

The website token and the Gemini key can also be entered interactively and are stored in the OS credential manager. On Windows it is stored in Windows Credential Manager; on macOS and Linux, `keytar` uses the platform credential service.

### Install from source

```bash
git clone https://github.com/subhamoydatta703/REXA.git
cd REXA
bun install
```

Create a `.env` file if you are using environment variables:

```dotenv
GEMINI_API_KEY=your-key
GEMINI_GUARD_API_KEY=your-guardrail-key
GEMINI_STREAMING_API_KEY=your-streaming-key
TVLY_API_KEY=your-optional-tavily-key
```

Never commit `.env`, API keys, or CLI tokens to Git.

### Run the CLI agent

```bash
bun run rexa
```

Or link it so `rexa` works from any directory:

```bash
bun link
```

After linking, start the agent from any repository with `rexa`. REXA treats the directory where you run it as the active project; the Docker sandbox mounts it at `/app`, and REXA itself does not need to be copied into every project.

Useful options:

```bash
rexa --help
rexa login
rexa logout
rexa --max-steps 30
rexa --name Nova
```

### Configure API keys securely

```bash
bun run src/index.ts config set-key YOUR_GEMINI_API_KEY
bun run src/index.ts config set-tavily-key YOUR_TAVILY_API_KEY
```

These commands store keys in the operating system credential vault via `keytar`. Environment variables take priority over stored credentials.

For CI or temporary sessions:

```bash
GEMINI_API_KEY=your-key bun run rexa
```

On PowerShell:

```powershell
$env:GEMINI_API_KEY = "your-key"
bun run rexa
```

Avoid passing secrets as command-line arguments when possible, because shell history and process inspection may expose them.

### Docker sandbox

Commands run in the `sandbox` service as a non-root user. The directory where the user starts `rexa` is mounted at `/app`, while cloned repositories are stored in a separate Docker-managed volume at `/workspace`.

```bash
bun run docker:build
bun run docker:up
bun run docker:down
```

When you ask REXA to clone `https://github.com/example/project`, Git creates the clone under `/workspace`, not in the host project directory. Normal Git commands such as `status`, `commit`, and `push` run against the current project on the host after confirmation, so they can use the user's existing Git credentials.

The workspace volume persists across normal `docker compose down` commands. Remove it and its cloned repositories with:

```bash
docker compose down -v
```

This does not delete files from the host project directory.

## Available tools

| Tool | Purpose |
| --- | --- |
| `git_command` | Approved Git operations: host for the current project, Docker for clones in `/workspace` |
| `execute_command` | Run approved executables in the Docker sandbox |
| `coding_context_tool` | Gather file content as coding context |
| `code_tool` | Create, write, or edit files with verification |
| `get_project_tree` | Inspect the project directory tree |
| File tools | Find, read, create, edit, append, list, delete |
| `search` | Tavily > GitHub API > DuckDuckGo > direct fetch |

## Project layout

```text
.
+-- src/
|   +-- agent/          # Agent loop, plan reflection, messages
|   +-- cli/            # Interactive terminal UI
|   +-- config/         # Credentials and configuration (keytar)
|   +-- guardrails/     # Input/output safety, secret scanning
|   +-- logger/         # Structured CLI logging
|   +-- providers/      # Gemini LLM provider with streaming
|   +-- tools/          # Tool implementations and registry
+-- .github/            # CI workflow, issue and PR templates
+-- docker-compose.yaml # Docker sandbox and workspace volume
+-- sandbox.Dockerfile  # Non-root sandbox image
+-- package.json
+-- README.md
```

## Security model

- Keys and the CLI auth token are stored in the OS credential vault via `keytar` — never written to disk in plaintext.
- Website login is verified by the REXA backend; the CLI does not embed Clerk or database credentials.
- **Dual guardrail system** — a Gemini Flash Lite model inspects every input and output independently from the main agent.
- **Secret scanning** — every pass scans for credential patterns (regex) plus Shannon entropy analysis.
- **Docker sandbox** — commands run inside Docker as a non-root user; 60-second default timeout, hard-killed on breach.
- **Volume isolation** — the host project mounts at `/app`; clones go to `/workspace`, separate from the host filesystem.
- **Git approval** — mutating Git operations require explicit confirmation before running.
- **Command policy** — destructive shell commands are blocked; package-manager mutations need confirmation.
- **SSRF protection** — the search tool blocks localhost, private, and link-local addresses; redirects are not followed.

## Permission model

REXA confirms every state-changing operation; read-only operations run automatically. No sandbox replaces review and least-privilege practices.

## REXA versus other agent CLIs

| | REXA | Claude Code | OpenHands |
| --- | --- | --- | --- |
| Plan reflection before tool calls | Yes | Partial | Partial |
| Docker sandboxed execution | Yes | No | Yes |
| Dual guardrail system | Yes | No | No |
| Entropy-based secret scanning | Yes | No | Partial |
| Open source | MIT | No | MIT |
| Install | `npm i -g rexa-agent` | `npm i -g` | pip / Docker |

An honest note: REXA is a young, single-developer project while Claude Code and OpenHands are mature products. REXA's differentiators are the guardrails and secret-scanning layer built into the agent loop itself.

## Troubleshooting

### Docker unavailable

Start Docker Desktop and retry, or verify with `docker version`.

### Guardrail errors

Set `GEMINI_GUARD_API_KEY` to a valid Gemini API key.

### Search unavailable

Tavily is optional; without a key REXA falls back to GitHub API, DuckDuckGo, and direct webpage fetch.

### Login or token verify failed

Generate a new CLI token on the [REXA website](https://rexa-agent-web.vercel.app/) and run `rexa login`. The free Render API may take up to about a minute to wake; wait and retry if the CLI cannot reach the verify URL.

### Reset credentials

Run `rexa logout`, or remove the `rexa` credentials from your OS credential manager, then run REXA again and enter a fresh token and keys.

## Development

```bash
bun x tsc --noEmit -p tsconfig.json
```

The project uses strict TypeScript settings and Bun's module and runtime conventions. A CI workflow runs this check on every push and pull request.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

This project is licensed under the [MIT License](./LICENSE).