# REXA

REXA is a general-purpose, single-agent development harness created by Subhamoy Datta. It understands a task, gathers context, plans a solution, writes or edits code, runs checks, investigates failures, searches for current information, and reports the result through one continuous conversation.

> REXA is an experimental agent harness. Review tool requests and do not run it against sensitive data without understanding the permissions and Docker configuration.

## Why REXA is more than a tool runner

REXA is an agent, not a collection of disconnected commands. The model decides which capabilities are needed, calls them in sequence, observes their results, and continues until it can answer or complete the task. A single request can combine repository inspection, code changes, Git operations, command execution, web research, and verification.

For example, a request to fix a bug can cause REXA to:

1. Map the project and locate relevant files.
2. Read the implementation and its surrounding context.
3. Form a plan and make a focused code change.
4. Run the appropriate type checks or tests.
5. Inspect failures and iterate.
6. Explain what changed and what was verified.

## Capabilities

- Conversational agent loop with multi-step reasoning and tool calling.
- Autonomous coding workflow: understand context, create files, edit targeted code, verify edits, and iterate.
- File discovery, reading, creation, editing, deletion, appending, counting, and project-tree tools.
- Grounded coding context that returns the current file contents after modifications.
- Sandboxed command execution with timeouts and command guardrails.
- Git clone, status, diff, branch, commit, pull, push, and other Git operations inside Docker; the current project is `/app` and cloned repositories use `/workspace`.
- Tavily search when configured, with GitHub, DuckDuckGo, and webpage fallbacks.
- Input and output guardrails plus secret scanning.
- CLI progress indicators, tool status, and response rendering.
- Secure API-key storage through the operating system credential vault using `keytar`.

The registered tools are implementation details that give the agent capabilities. They are not the product’s interaction model; you describe the outcome you want in natural language.

## Example tasks

REXA can help with tasks such as:

- “Explain this project’s architecture and identify its main entry points.”
- “Add input validation to the user registration flow, then run the type checker.”
- “Find why this test is failing, fix the smallest correct cause, and verify it.”
- “Review this repository for exposed secrets and unsafe file operations.”
- “Clone this repository in the sandbox, inspect its dependencies, and summarize risks.”
- “Create a plan for migrating this module, then implement the first step.”
- “Search for the current API documentation and compare it with this code.”

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) with Compose
- An API key for the configured language-model service
- Optional: a Tavily API key for higher-quality web search

The current provider adapter expects these environment variables:

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` or `GOOGLE_GEMINI_API_KEY` | Main agent model |
| `GEMINI_GUARD_API_KEY` | Input/output guardrail model |
| `GEMINI_STREAMING_API_KEY` | Streaming provider initialization |
| `TVLY_API_KEY` or `TAVILY_API_KEY` | Optional Tavily search |

The main model key can also be entered interactively on first launch and is stored in the OS credential manager. On Windows it is stored in Windows Credential Manager; on macOS and Linux, `keytar` uses the platform credential service.

## Installation

```bash
git clone https://github.com/<your-account>/<your-repository>.git
cd my_agent_adk
bun install
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

The equivalent direct command is `bun run src/index.ts`. REXA opens an interactive prompt; type a task and press Enter. Type `exit` or `quit` to leave.

### Run with `rexa`

To make the CLI available as a standalone terminal command, create a global Bun link once from the repository directory:

```bash
bun link
```

After linking, start the agent from any directory with:

```bash
rexa
```

If the command is not found, make sure Bun's global binary directory is included in your `PATH`, then restart the terminal. You can confirm the link with:

```bash
rexa --help
```

Useful options:

```bash
bun run src/index.ts --help
bun run src/index.ts --max-steps 30
bun run src/index.ts --name Nova
```

## Configure API keys

The safest CLI setup is:

```bash
bun run src/index.ts config set-key YOUR_GEMINI_API_KEY
bun run src/index.ts config set-tavily-key YOUR_TAVILY_API_KEY
```

These commands store keys in the operating system credential vault. Environment variables take priority over stored credentials.

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

Commands run in the `sandbox` service as a non-root user. The project is mounted at `/app`, while cloned repositories are stored in a separate Docker-managed volume at `/workspace`.

```bash
bun run docker:build
bun run docker:up
bun run docker:down
```

For example, when you ask REXA to clone `https://github.com/example/project`, Git creates the clone under `/workspace`, not in the host project directory. Normal Git commands such as `status` use `/app` by default so REXA can work with the current project.

The workspace volume persists across normal `docker compose down` commands. Remove it and its cloned repositories with:

```bash
docker compose down -v
```

This does not delete files from the host project directory.

## Demo

```text
$ bun run rexa

REXA CLI  v1.0.0  |  Autonomous Agent Harness
> Clone https://github.com/example/project, inspect the repository, and summarize its architecture.

▸ git_command running [git clone https://github.com/example/project project]
✓ git_command done (4.2s)
▸ execute_command running [find ...]
✓ execute_command done (0.3s)

REXA · 14:32

## Summary

- The repository is a TypeScript application.
- The main entry point is `src/index.ts`.
- Dependencies and scripts are defined in `package.json`.
```

Other useful prompts:

```text
Explain the structure of this project.
Find the authentication code and explain the security risks.
Run the tests and summarize any failures.
Search for the latest Bun documentation and compare it with this project.
Create a concise README for this repository.
```

For a coding task, the same agent can work through implementation and verification:

```text
> Add a password-strength validator to src/auth.ts, update the tests, and run the type checker.

REXA:
- I’ll inspect the authentication code and existing test conventions.
- I found the validation boundary and will add the smallest compatible change.
- The implementation and tests are updated.
- Type checking completed successfully.
```

## How coding works

For the current project, file and coding tools operate on the project workspace mounted at `/app`. This lets REXA make real changes to the checked-out project. Commands run inside the sandbox, so builds, scripts, and package-manager operations are isolated from the host.

Repositories cloned through `git_command` are placed in `/workspace`, a separate Docker-managed volume. Use sandbox commands with `workdir: "/workspace"` to inspect or build those clones. They are deliberately kept outside the host project directory.

REXA’s coding tools support three edit modes:

- `create`: create a new file with complete content.
- `write`: replace an entire file intentionally.
- `edit`: apply targeted before, after, replace, or delete changes.

After changes, the coding tool reads the current file content again so the agent can reason from the actual result rather than an assumption.

## Available capabilities

| Tool | Purpose |
| --- | --- |
| `git_command` | Run Git inside Docker; current project `/app`, cloned repositories `/workspace` |
| `execute_command` | Run approved executables inside Docker with a timeout |
| `coding_context_tool` | Gather relevant coding context |
| `code_tool` | Perform coding operations |
| `get_project_tree` | Inspect the project tree |
| File tools | Find, read, create, edit, append, count, and delete files |
| `search` | Search the web or inspect supported URLs |

## Project layout

```text
.
├── src/
│   ├── agent/          # Agent loop and message handling
│   ├── cli/            # Interactive terminal UI
│   ├── config/         # Credential and configuration management
│   ├── guardrails/     # Input/output safety checks
│   ├── logger/         # Structured CLI logging
│   ├── providers/      # Language-model provider integrations
│   └── tools/          # Tool implementations and registry
├── docker-compose.yaml # Docker sandbox and workspace volume
├── sandbox.Dockerfile  # Non-root sandbox image
├── package.json
└── README.md
```

## Security model

- API keys are stored through the platform credential store when configured through the CLI.
- Commands execute in Docker as a non-root user with resource limits and an execution timeout.
- Git clones go to the private `/workspace` Docker volume.
- Shell built-ins and several destructive commands are blocked by the command policy.
- Input and output guardrails inspect requests and responses for unsafe content and secrets.
- Search URL inspection blocks common private-network addresses and does not follow redirects.

### Permission model

All executable commands are launched through the Docker sandbox. Read-only work such as inspecting files, checking status, viewing diffs, and running ordinary verification commands can proceed automatically. REXA asks for confirmation before state-changing operations, including:

- Git clone, add, commit, push, pull, merge, rebase, reset, clean, branch, tag, checkout, and switch operations.
- Package-manager mutations such as install, add, remove, update, upgrade, and CI installation commands.
- Evaluated code flags such as `-c`, `-e`, `--eval`, `--print`, and `-p`.
- File deletion through `delete_file`.
- Unknown executables, which require confirmation before execution.

Some shell built-ins and destructive aliases are blocked completely. A confirmation prompt is an authorization boundary, not a replacement for reviewing the command and its arguments.

No sandbox replaces review and least-privilege practices. Do not provide production credentials, mount sensitive directories, or disable Docker isolation unless you understand the consequences.

## Troubleshooting

### Docker is unavailable

```bash
docker version
docker compose version
```

Start Docker Desktop and retry.

### Model guardrail errors

Set the provider-specific guardrail key, currently `GEMINI_GUARD_API_KEY`. The guardrails are initialized separately from the main agent provider.

### Search is unavailable

Tavily is optional. Without a valid Tavily key, REXA attempts its fallback providers. Check network access and confirm the query is not empty.

### Reset stored credentials

Remove the `rexa` credentials from your operating system's credential manager, then run REXA again and enter fresh keys.

## Development

```bash
bun x tsc --noEmit -p tsconfig.json
```

The project uses strict TypeScript settings and Bun's module/runtime conventions.

## About the creator

REXA was created by **Subhamoy Datta** as a complete agent harness for practical software-development work. The architecture, agent loop, tool system, coding workflow, sandbox integration, guardrails, CLI experience, and security model are part of Subhamoy’s implementation. The model API is only one replaceable component used by the harness to provide language intelligence; REXA’s value is in the orchestration and development system built around it.

## License

No license has been declared yet. Add a license before distributing this project or accepting external contributions.
