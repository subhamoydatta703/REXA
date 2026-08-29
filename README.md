# REXA

REXA is a general-purpose, single-agent development harness created by Subhamoy Datta. It understands a task, gathers context, reflects on its own plan, writes or edits code, executes commands, searches the web, investigates failures, and reports the result through one continuous conversation — for up to 60 reasoning steps per task.

> REXA is an experimental agent harness. Review tool requests and do not run it against sensitive data without understanding the permissions and Docker configuration.

## Why REXA is more than a tool runner

REXA is an agent, not a collection of disconnected commands. The model decides which capabilities are needed, calls them in sequence, observes their results, and continues until it can answer or complete the task. Before executing any tool call, REXA reflects on its own proposed plan — if the plan is flawed, redundant, or hallucinated, it scraps it and re-generates before touching anything.

A single request can combine repository inspection, code changes, Git operations, command execution, web research, and verification.

For example, a request to fix a bug causes REXA to:

1. Map the project and locate relevant files.
2. Read the implementation and its surrounding context.
3. Reflect on the proposed plan and revise if needed.
4. Form a focused code change using `edit`, `create`, or `write`.
5. Re-read the modified file to reason from the actual result.
6. Run the appropriate type checks or tests in the Docker sandbox.
7. Inspect failures and iterate.
8. Explain what changed and what was verified.

## Capabilities

- **Continuous agent loop** — up to 60 steps per task (configurable via `--max-steps`).
- **Plan reflection** — the agent reflects on its own proposed tool calls before executing; bad or redundant plans are discarded and re-generated.
- **Autonomous coding workflow** — understand context, create files, apply targeted edits, re-read the file after every change to reason from the actual result.
- **File tools** — find, read (single and batch), create, edit (before/after/replace/delete), append, count, list, and delete files, scoped to the active project.
- **Project tree inspection** — inspect the full directory tree for deep structural context.
- **Sandboxed command execution** — commands run inside Docker with a 60-second default timeout (configurable up to 5 minutes); the process is hard-killed on timeout.
- **Git operations with explicit approval** — every mutating Git command (clone, add, commit, push, pull, fetch, merge, rebase, reset, clean, checkout, switch, branch, tag) requires user confirmation before running.
- **4-tier web search** — Tavily (if configured) → GitHub API (for `github.com` URLs) → DuckDuckGo → direct webpage fetch.
- **Dual guardrail system** — a separate Gemini Flash Lite model inspects every user input and every agent output independently.
- **Secret scanning on every pass** — regex pattern matching plus Shannon entropy analysis to catch high-entropy credential strings.
- **Secure API key storage** — credentials are stored via `keytar` in the OS vault: Windows Credential Manager, macOS Keychain, or libsecret on Linux.
- **Rich CLI** — progress spinners, tool status lines with timing, and markdown-rendered responses in the terminal.

## Example tasks

REXA can help with tasks such as:

- "Explain this project's architecture and identify its main entry points."
- "Add input validation to the user registration flow, then run the type checker."
- "Find why this test is failing, fix the smallest correct cause, and verify it."
- "Review this repository for exposed secrets and unsafe file operations."
- "Clone this repository in the sandbox, inspect its dependencies, and summarize risks."
- "Create a plan for migrating this module, then implement the first step."
- "Search for the current API documentation and compare it with this code."

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) with Compose
- A Gemini API key (main agent model)
- Optional: a second Gemini API key for the guardrail model, a Tavily key for premium search

The current provider adapter expects these environment variables:

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` or `GOOGLE_GEMINI_API_KEY` | Main agent model |
| `GEMINI_GUARD_API_KEY` | Input/output guardrail model (Gemini Flash Lite) |
| `GEMINI_STREAMING_API_KEY` | Streaming provider initialization |
| `TVLY_API_KEY` or `TAVILY_API_KEY` | Optional Tavily search |

The main model key can also be entered interactively on first launch and is stored in the OS credential manager. On Windows it is stored in Windows Credential Manager; on macOS and Linux, `keytar` uses the platform credential service.

## Installation

```bash
git clone https://github.com/subhamoydatta703/REXA.git
cd REXA
bun install
```

Or install directly from npm:

```bash
npm install -g rexa-agent
```

Create a `.env` file if you are using environment variables:

```dotenv
GEMINI_API_KEY=your-gemini-key
GEMINI_GUARD_API_KEY=your-guardrail-key
GEMINI_STREAMING_API_KEY=your-streaming-key
TVLY_API_KEY=your-optional-tavily-key
```

Never commit `.env` or API keys to Git.

## Start the CLI agent

```bash
bun run rexa
```

REXA opens an interactive prompt; type a task and press Enter. Type `exit` or `quit` to leave.

### Run with `rexa`

To make the CLI available as a standalone terminal command, create a global Bun link once from the repository directory:

```bash
bun link
```

After linking, start the agent from any directory with:

```bash
rexa
```

REXA treats the directory where you run this command as the active project. For example:

```bash
cd path/to/your/repository
rexa
```

File tools and normal Git operations work on that repository. The Docker sandbox mounts it at `/app`; REXA itself does not need to be copied into every project.

Useful options:

```bash
rexa --help
rexa --max-steps 30
rexa --name Nova
```

## Configure API keys

The safest CLI setup is:

```bash
bun run src/index.ts config set-key YOUR_GEMINI_API_KEY
bun run src/index.ts config set-tavily-key YOUR_TAVILY_API_KEY
```

These commands store keys in the operating system credential vault via `keytar`. Environment variables take priority over stored credentials.

For CI or temporary sessions, use environment variables instead:

```bash
GEMINI_API_KEY=your-key bun run rexa
```

On PowerShell:

```powershell
$env:GEMINI_API_KEY = "your-key"
bun run rexa
```

Avoid passing secrets as command-line arguments when possible because shell history and process inspection may expose them.

## Docker sandbox

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

## Demo

```text
$ bun run rexa

 ____  _______  __    _
|  _ \| ____\ \/ /   / \
| |_) |  _|  \  /   / _ \
|  _ <| |___ /  \  / ___ \
|_| \_\_____/_/\_\/_/   \_\

+-----------------------------------------------+
|  REXA CLI  v1.0.0 |  Autonomous Agent Harness  |
+-----------------------------------------------+

  > Yo, it's me... REXA. What's the plan?

  > Find why the auth test is failing and fix it.

  * get_project_tree  running...
  + get_project_tree  done (0.3s)
  * coding_context_tool  running...
  + coding_context_tool  done (0.2s)
  * code_tool  running...
  + code_tool  done (0.1s)
  * execute_command  running [bun test]
  + execute_command  done (3.1s)

  rexa . 20:01

  Found the issue -- missing null check on line 42 of auth.ts.
  Fixed with a guard clause. All tests pass.
```

Other useful prompts:

```text
Explain the structure of this project.
Find the authentication code and explain the security risks.
Run the tests and summarize any failures.
Search for the latest Bun documentation and compare it with this project.
Clone https://github.com/example/repo in the sandbox and summarize its architecture.
```

## How coding works

For the current project, file and coding tools operate on the project workspace mounted at `/app`. This lets REXA make real changes to the checked-out project. Build, script, and package-manager commands run inside the sandbox; approved current-project Git commands run on the host to use the user's existing Git credentials.

Repositories cloned through `git_command` are placed in `/workspace`, a separate Docker-managed volume. Use sandbox commands with `workdir: "/workspace"` to inspect or build those clones. They are deliberately kept outside the host project directory.

REXA's coding tools support three edit modes:

- `create`: create a new file with complete content.
- `write`: replace an entire file intentionally.
- `edit`: apply targeted `before`, `after`, `replace`, or `delete` changes.

After every change, the coding tool re-reads the current file content so the agent reasons from the actual result, not an assumption.

## Available tools

| Tool | Purpose |
| --- | --- |
| `git_command` | Run approved Git operations; host for current project, Docker for clones in `/workspace` |
| `execute_command` | Run approved executables inside Docker with a configurable timeout |
| `coding_context_tool` | Gather relevant file content as coding context |
| `code_tool` | Perform `create`, `write`, or `edit` coding operations with post-change verification |
| `get_project_tree` | Inspect the full project directory tree |
| File tools | Find, read (single/batch), create, edit, append, count, list, and delete files |
| `search` | Tavily > GitHub API > DuckDuckGo > direct fetch, in priority order |

## Project layout

```text
.
+-- src/
|   +-- agent/          # Agent loop, plan reflection, and message handling
|   +-- cli/            # Interactive terminal UI (Commander, Ink, Chalk, Ora)
|   +-- config/         # Credential and configuration management (keytar)
|   +-- guardrails/     # Input/output safety checks and secret scanning
|   +-- logger/         # Structured CLI logging with tool status and timing
|   +-- providers/      # Gemini LLM provider with streaming support
|   +-- tools/          # Tool implementations and registry
+-- docker-compose.yaml # Docker sandbox and workspace volume
+-- sandbox.Dockerfile  # Non-root sandbox image
+-- package.json
+-- README.md
```

## Security model

- **API keys** are stored via `keytar` in the OS credential vault — Windows Credential Manager, macOS Keychain, or libsecret. Keys are never written to disk in plaintext.
- **Dual guardrail system** — a dedicated Gemini Flash Lite model instance runs independently from the main agent, inspecting every user input before it reaches the agent and every agent response before it reaches the terminal.
- **Secret scanning** — every input and output is scanned using regex patterns for common credential formats and Shannon entropy analysis to catch high-entropy strings that pattern matching might miss.
- **Docker sandbox** — commands execute inside Docker as a non-root user. Commands have a 60-second default timeout (configurable up to 5 minutes); the process is hard-killed on breach.
- **Volume isolation** — the host project is mounted at `/app`; cloned repositories go to `/workspace`, a separate Docker volume that never touches the host filesystem.
- **Git approval** — every mutating Git operation requires explicit user confirmation before running. The prompt states clearly whether the command runs on the host or in the sandbox.
- **Command policy** — 18 shell built-ins and destructive aliases are permanently blocked: `ls`, `cat`, `dir`, `cd`, `echo`, `mkdir`, `rmdir`, `find`, `cmd`, `grep`, `pwd`, `rm`, `cp`, `mv`, `touch`, `which`, `where`, `type`. Package-manager mutations and script runners require confirmation. Evaluated code flags (`-e`, `-c`, `--eval`, `--print`) require confirmation.
- **SSRF protection** — the search tool blocks requests to localhost, loopback (`127.x.x.x`), private network ranges (`10.x`, `172.16-31.x`, `192.168.x`), and link-local addresses (`169.254.x`). Redirects are not followed.

### Permission model

REXA asks for confirmation before any state-changing operation. Read-only operations proceed automatically. A confirmation prompt is an authorization boundary — review the full command and its arguments, not just the executable name.

No sandbox replaces review and least-privilege practices. Do not provide production credentials, mount sensitive directories, or disable Docker isolation unless you understand the consequences.

## Troubleshooting

### Docker is unavailable

```bash
docker version
docker compose version
```

Start Docker Desktop and retry.

### Guardrail errors

Set `GEMINI_GUARD_API_KEY` to a valid Gemini API key. The guardrail model (`gemini-3.1-flash-lite`) is initialized separately from the main agent model.

### Search is unavailable

Tavily is optional. Without a valid Tavily key, REXA falls back automatically to GitHub API, DuckDuckGo, and direct webpage fetch. Check network access and confirm the query is not empty.

### Reset stored credentials

Remove the `rexa` service credentials from your operating system credential manager (Windows Credential Manager / macOS Keychain / libsecret), then run REXA again and enter fresh keys.

## Development

```bash
bun x tsc --noEmit -p tsconfig.json
```

The project uses strict TypeScript settings and Bun's module and runtime conventions.

## About the creator

REXA was created by **Subhamoy Datta** as a complete agent harness for practical software-development work. The architecture, agent loop, plan reflection system, tool orchestration, coding workflow, sandbox integration, guardrail pipeline, CLI experience, and security model are Subhamoy's implementation. The Gemini model API is one replaceable component used by the harness to provide language intelligence; REXA's value is in the orchestration and development system built around it.

## License

This project is licensed under the [MIT License](./LICENSE).
