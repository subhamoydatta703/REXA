# REXA — Autonomous Agent Harness

> REXA is an autonomous terminal agent harness engineered to understand software tasks, conduct external web research, reflect on tool plans prior to execution, safely modify codebases with automated verification, execute commands inside an isolated Docker sandbox, enforce dual-layer safety guardrails with entropy-based secret scanning, and retain explicit user preferences across sessions.

<br/>

<p align="center">
  <img src="https://img.shields.io/github/license/subhamoydatta703/REXA" alt="License">
  <img src="https://img.shields.io/github/stars/subhamoydatta703/REXA?style=social" alt="Stars">
  <img src="https://img.shields.io/github/actions/workflow/status/subhamoydatta703/REXA/ci.yml?branch=main&label=CI" alt="CI">
  <img src="https://img.shields.io/npm/v/rexa-agent" alt="npm version">
  <img src="https://img.shields.io/npm/dt/rexa-agent" alt="npm downloads">
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1dc" alt="Runtime: Bun">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/subhamoydatta703/REXA/main/assets/rexa.png" alt="REXA CLI Interface" width="800">
</p>

> [!WARNING]
> REXA is an autonomous agent harness with command execution and file modification capabilities. Review tool confirmations attentively and do not execute REXA against sensitive environments without inspecting permission settings and Docker container configurations.

---

## Table of contents

- [Overview](#overview)
- [How REXA works](#how-rexa-works)
- [System architecture](#system-architecture)
- [Orchestration and routing](#orchestration-and-routing)
- [Specialized agents](#specialized-agents)
  - [Research agent](#research-agent)
  - [Coding agent](#coding-agent)
- [Execution modes](#execution-modes)
- [Interactive terminal experience](#interactive-terminal-experience)
- [Available tools](#available-tools)
- [Docker sandbox environment](#docker-sandbox-environment)
- [Security and guardrails](#security-and-guardrails)
- [Persistent cloud memory](#persistent-cloud-memory)
- [Installation and setup](#installation-and-setup)
- [Configuration and credentials](#configuration-and-credentials)
- [LLM provider integration](#llm-provider-integration)
- [Project structure](#project-structure)
- [Comparative analysis](#comparative-analysis)
- [Troubleshooting](#troubleshooting)
- [Development and verification](#development-and-verification)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Modern software development requires balancing autonomous execution with safety and verification. REXA bridges conversational AI reasoning and production environments by providing:

1. **Intelligent multi-agent routing**: Tasks are classified dynamically into direct conversational responses, local repository coding tasks, or combined research-and-code workflows.
2. **Autonomous web research**: External documentation, release notes, and third-party APIs are researched prior to code modification without modifying local files.
3. **Plan reflection**: Planned tool calls undergo autonomous reflection using the Gemini LLM model to validate efficacy and eliminate redundant or hallucinated actions before execution.
4. **Sandboxed execution**: Command execution and external dependency operations are isolated inside a dedicated Docker container with strict CPU, memory, PID, and permission boundaries.
5. **Dual guardrail validation**: Every user input and agent response is evaluated independently by specialized guardrail evaluators powered by the Gemini LLM model and Shannon entropy secret scanning.
6. **Explicit persistent memory**: Cross-session user preferences and development rules are stored securely through authenticated endpoints.

---

## How REXA works

When a prompt is submitted to REXA, execution proceeds through a deterministic, verified pipeline:

```text
User Input
    │
    ▼
[Input Guardrails] ──(Fails validation)──► Block request & return security rationale
    │ (Passes)
    ▼
[Supervisor Routing]
    ├── DIRECT ──────────► Stream direct conversational response (no tool overhead)
    ├── CODE_ONLY ───────► Forward request directly to Coding Agent
    └── RESEARCH_AND_CODE► Execute Research Agent first ──► Synthesize brief ──► Coding Agent
                                                                                  │
    ┌─────────────────────────────────────────────────────────────────────────────┘
    ▼
[Coding Agent Execution Loop] (Up to 60 steps)
    │
    ├── 1. Generate candidate plan & tool calls via Gemini LLM model
    ├── 2. Perform plan reflection to validate tool relevance and safety
    ├── 3. Execute approved tool calls (Docker sandbox / verified file modifications)
    ├── 4. Ingest tool feedback and test outputs into context
    └── 5. Repeat until objective is fulfilled or step limit is reached
    │
    ▼
[Output Guardrails] ──(Detects secrets/violations)──► Redact & sanitize response
    │ (Safe)
    ▼
Rendered Terminal Output
```

---

## System architecture

The project is structured around modular subsystems separating CLI presentation, orchestration, agent execution, safety, and system tooling:

```text
Terminal Interface (AgentCLI & AgentUI)
  │
  └── Orchestrator (src/orchestration/Orchestrator.ts)
        │
        ├── InputGuardrails (src/guardrails/input/InputGuardrails.ts)
        │     ├── Shannon Entropy Secret Scanner
        │     └── Gemini LLM model Safety Evaluation
        │
        ├── Supervisor (src/orchestration/Supervisor.ts)
        │     └── Structured Route Decision (DIRECT | CODE_ONLY | RESEARCH_AND_CODE)
        │
        ├── ResearchAgent (src/agent/ResearchAgent.ts)
        │     └── SearchTool (Tavily, GitHub, DuckDuckGo, Web Scrape)
        │
        └── Agent / Coding Agent (src/agent/Agent.ts)
              ├── Plan Reflection Layer (Gemini LLM model)
              ├── ToolRegistry (8 Registered Tools)
              ├── ExecutionManager & Docker Sandbox
              └── OutputGuardrails (src/guardrails/output/OutputGuardrails.ts)
```

---

## Orchestration and routing

The orchestration subsystem coordinates message lifecycles, user safety checks, and routing decisions.

### Orchestrator (`src/orchestration/Orchestrator.ts`)
- Evaluates raw user input through `InputGuardrails` before triggering downstream models.
- Emits real-time status callbacks (`thinking...`, `researching...`, `coding...`).
- Dispatches requests based on the decision returned by the `Supervisor`.
- In `RESEARCH_AND_CODE` workflows, executes `ResearchAgent`, appends the research findings to the user prompt as a `RESEARCH & TECHNICAL BRIEF`, and hands off execution to the `Agent`.

### Supervisor (`src/orchestration/Supervisor.ts`)
- Employs structured JSON schema enforcement via the Gemini LLM model to classify intent:
  - `DIRECT`: Informal inquiries, greetings, identity questions, or conversational exchanges. Returned without tool invocation using the custom agent persona.
  - `CODE_ONLY`: Local repository modifications, bug fixes, refactoring, code explanation, file queries, and test executions where external research is unneeded.
  - `RESEARCH_AND_CODE`: Tasks referencing modern frameworks, external SDK updates, breaking library changes, or unfamiliar third-party APIs.
- Features automatic fallback to `CODE_ONLY` in the event of parsing or network irregularities.

---

## Specialized agents

### Research agent
Defined in `src/agent/ResearchAgent.ts`, this agent acts as an autonomous external researcher.

- **Strict boundaries**: The research agent is strictly read-only and external. It cannot write files, delete code, execute shell commands, or modify Git state.
- **Tools**: Restricted exclusively to the `search` tool.
- **Workflow**: Performs iterative queries across up to 60 steps to synthesize a structured technical brief containing:
  - Objective summary
  - Technical requirements and library specifications
  - Architectural constraints and implementation risks
  - Coding guidance (without guessing local file names)
  - Verified source references and confidence rating
- **Output**: The brief is fed directly into the coding agent as authoritative context; it is not dumped raw to the terminal.

### Coding agent
Defined in `src/agent/Agent.ts`, this agent serves as the autonomous software engineer.

- **Context gathering**: Maps repository layout via `get_project_tree` and reads file slices via `coding_context_tool`.
- **Pre-execution reflection**: Before executing any batch of proposed tool calls, submits the plan to a reflection prompt powered by the Gemini LLM model. Hallucinated file paths or unproductive actions are rejected and revised before execution.
- **Verified file manipulation**: Uses `code_tool` to apply atomic additions, replacements, or deletions. Every file update re-reads the underlying file to guarantee valid disk state.
- **Iterative feedback**: Executes tests and builds via `execute_command` inside the Docker sandbox, observes stdout/stderr, and self-corrects until verification succeeds.

---

## Execution modes

REXA supports two operational modes toggled interactively with the `Tab` key:

| Mode | Key behavior | Tool availability | Best used for |
| :--- | :--- | :--- | :--- |
| **Plan** | Analyzes context and outlines architectural solutions, affected files, risks, and testing strategies without executing mutations. External research is described conceptually rather than executed. | Disabled (`tools: []`) | Architectural design, feasibility assessments, task decomposition, and code reviews. |
| **Act** | Executes actions autonomously: creates files, modifies code, runs commands inside Docker, and iterates against errors. | Fully enabled (All 8 registered tools) | Implementation, bug fixing, test running, refactoring, and command execution. |

---

## Interactive terminal experience

REXA delivers a focused developer experience directly in the terminal:

- **Interactive composer**: Built with custom terminal control sequences supporting multi-line input (`Shift+Enter` or `Ctrl+J`), immediate editing, and mode switching (`Tab`).
- **Live status and token streaming**: Emits phase indicators (`thinking...`, `researching...`, `coding...`) alongside live Markdown token streaming.
- **Formatted Markdown output**: Parses and syntax-highlights Markdown tables, code blocks, bulleted lists, and diffs using specialized terminal renderers.
- **Error classification**: Translates raw network, provider, and container errors into clear, actionable advice using `ErrorTranslator.ts`.

```text
$ rexa
  > Yo, it's me... REXA. What's the plan?
  > Identify why user session validation fails and implement unit tests.
  [get_project_tree] running...
  [coding_context_tool] running... [src/auth/SessionManager.ts]
  [code_tool] running... [edit: src/auth/SessionManager.ts]
  [execute_command] running... [bun test tests/auth.test.ts]
  rexa · 14:22
  Resolved session validation by handling expired token boundaries.
  All 12 test assertions now pass.
```

---

## Available tools

REXA registers exactly 8 core tools in `src/index.ts`:

| Tool name | Primary input parameters | Operational description |
| :--- | :--- | :--- |
| `git_command` | `args`, `workdir` | Executes Git operations. Repository inspection (`status`, `diff`, `log`) runs directly; state-altering operations (`commit`, `checkout`, `push`) prompt for confirmation. Repositories cloned via Git are strictly isolated in `/workspace`. |
| `execute_command` | `command`, `args`, `timeoutMs`, `workdir` | Runs commands inside the non-root Docker sandbox. Common utilities (`node`, `bun`, `npm`, `tsc`, `python`) are permitted; interactive or destructive operations require explicit user approval. Shell built-ins (`cat`, `ls`, `rm`) are blocked to enforce verified tool use. |
| `coding_context_tool` | `path`, `instruction` | Loads file contents into memory with line numbers and token-conscious pagination. |
| `code_tool` | `create`, `write`, `edit` | Performs atomic file creation, full overwrites, or granular patch operations (`before`, `after`, `replace`, `delete`). Re-reads modified files to verify content consistency. |
| `get_project_tree` | None | Traverses project directory structure up to 300 entries, excluding artifacts such as `node_modules`, `dist`, `.git`, and build outputs. |
| `search` | `query` | 4-tier web search engine cascading from Tavily API to GitHub API, DuckDuckGo HTML scraping, and direct webpage fetching with built-in SSRF protections. |
| `save_memory` | `text` | Persists explicit user preferences and development rules to the authenticated cloud memory service. |
| `search_memory` | `query` | Retrieves authenticated cross-session preferences when explicit context recall is requested. |

### Command execution safety policy
Commands passed to `execute_command` are governed by `CommandPolicy.ts`:
- **Safe command whitelist**: `git`, `bun`, `bunx`, `node`, `npm`, `npx`, `tsc`, `python`, `tail`.
- **Blocked shell built-ins**: `cat`, `ls`, `dir`, `cd`, `echo`, `mkdir`, `rm`, `cp`, `mv`, `grep`, `pwd`. The agent is directed to use native file tools.
- **Mandatory confirmation triggers**: Arbitrary command evaluation flags (`-e`, `--eval`), package additions or removals (`install`, `add`, `remove`), file deletions, or unrecognized binaries require explicit user confirmation in the terminal.

---

## Docker sandbox environment

To prevent unexpected side effects on the host workstation, command executions take place inside a managed Docker container:

- **Base image**: `ubuntu:22.04` with pre-installed toolchains (`Node.js`, `Bun`, `npm`, `Python 3`, `curl`, `git`).
- **Isolation boundaries**:
  - Drops all Linux capabilities (`cap_drop: [ALL]`).
  - Runs as an unprivileged user (`sandbox`, UID `1000:1000`).
  - Resource limits: capped at `0.5 CPU`, `512MB RAM`, and `128 PIDs`.
  - Non-root working directories: host directory mounted to `/app`; temporary clones isolated to `/workspace`.
- **Lifecycle management**: `ExecutionManager.ts` provisions containers on demand using project-specific naming (`rexa_<project-hash>`), terminates on command timeouts (default 60s, maximum 300s), and shuts down the container stack cleanly upon session exit.

---

## Security and guardrails

Security in REXA is integrated directly into the agent reasoning loop rather than treated as a peripheral filter:

### Dual guardrail architecture
1. **Input guardrails (`InputGuardrails.ts`)**: Evaluates incoming prompts for prompt injection, jailbreaks, hidden instructions, and system prompt override attempts using the Gemini LLM model. Short conversational greetings bypass the model check for instant responsiveness.
2. **Output guardrails (`OutputGuardrails.ts`)**: Analyzes candidate agent outputs prior to terminal rendering. Suppresses unauthorized internal reasoning disclosures, schema leaks, or unsafe directives.

### Entropy-based secret scanner (`SecretScanner.ts`)
- Performs pattern matching for recognized secrets: JWT tokens, Stripe live/test keys, AWS access keys, generic API tokens, and variable assignments matching password patterns.
- Calculates Shannon entropy across alphanumeric character sequences of 16 characters or longer. Tokens with entropy exceeding `4.5` are flagged as prospective secrets.
- Redacts identified credentials in terminal output and debug logs using `[REDACTED]`.

### SSRF protection in web search
- Blocks local loopback addresses (`127.0.0.1`, `localhost`), link-local metadata addresses (`169.254.169.254`), and private IPv4 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
- Refuses to follow automatic HTTP redirects when performing direct webpage scraping.

---

## Persistent cloud memory

REXA features an explicit, account-backed memory architecture:

- **Explicit intent requirement**: The agent invokes `save_memory` only when explicitly instructed by the user (e.g., *"Remember that this project uses Vitest instead of Jest"*).
- **Security safeguards**: Passwords, API keys, repository code blocks, and conversation dumps are strictly blocked from memory storage.
- **Search guidelines**: Governed by `MemorySearchRules.ts`. The agent searches memory only when addressing personal preferences, conventions, or past decisions. General coding questions and file queries default to reading repository code as the source of truth.

---

## Installation and setup

### Prerequisites
- **Runtime**: [Bun](https://bun.sh/) (version 1.1 or higher) or Node.js (version 18 or higher).
- **Containerization**: [Docker Desktop](https://www.docker.com/) running locally for command execution isolation.
- **API key**: An active Google Gemini API key.

### Global installation
Install REXA globally via npm:

```bash
npm install -g rexa-agent
```

### Installation from source
Clone the repository and install dependencies using Bun:

```bash
git clone https://github.com/subhamoydatta703/REXA.git
cd REXA
bun install
bun run typecheck
```

Launch the CLI:

```bash
bun run rexa
```

You can link the binary locally to make it accessible anywhere on your system:

```bash
bun link
```

---

## Configuration and credentials

REXA prioritizes secure credential storage. Sensitive values are stored in the operating system's native credential vault (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux) via `keytar`, with encrypted fallback files using AES-256-GCM.

### CLI commands

```bash
# Authenticate with your REXA cloud account
rexa login

# Remove saved authentication credentials
rexa logout

# Store your Gemini API key in the secure credential store
rexa config set-key

# Store an optional Tavily Search API key
rexa config set-tavily-key

# Launch REXA with customized step limits
rexa --max-steps 45
```

### Environment variables

Environment variables take precedence over credentials stored in the local vault:

| Variable | Description |
| :--- | :--- |
| `GEMINI_API_KEY` | Primary API key for the Gemini LLM model. |
| `GEMINI_GUARD_API_KEY` | Dedicated API key for guardrail evaluations (falls back to `GEMINI_API_KEY`). |
| `GEMINI_STREAMING_API_KEY` | Dedicated API key for streaming operations (falls back to `GEMINI_API_KEY`). |
| `TVLY_API_KEY` | Optional Tavily search key for enhanced research queries. |
| `REXA_CLI_TOKEN` | Overrides the authenticated CLI web token. |
| `REXA_WORKSPACE` | Overrides the host directory mounted inside `/app` in Docker (defaults to `process.cwd()`). |
| `REXA_CONFIG_KEY` | Custom 32-byte Base64 key for file-based configuration encryption. |
| `LOG_LEVEL` | Set to `debug` to enable verbose execution logs and stack traces. |

---

## LLM provider integration

REXA integrates with the Gemini LLM model through `GeminiProvider.ts`:

- **Structured function calling**: Automatically converts Zod schema definitions into JSON schema declarations.
- **Token streaming**: Streams partial responses directly to the user interface via `onToken` callbacks while buffering function calls.
- **Plan reflection**: Invokes an isolated reflection pass prior to tool execution to evaluate whether candidate function calls align with user constraints.
- **Error classification**: Captures provider errors (including HTTP 429 quota exhaustion, HTTP 503 service unavailability, and context length limits) and converts them into structured user guidance.

---

## Project structure

```text
.
├── src/
│   ├── index.ts                     # CLI entrypoint, command parsing, and subsystem initialization
│   ├── orchestration/
│   │   ├── Orchestrator.ts          # Main execution orchestrator and workflow manager
│   │   ├── Supervisor.ts            # Route classification model interface
│   │   └── SupervisorPrompt.ts      # Routing taxonomy prompt contracts
│   ├── agent/
│   │   ├── Agent.ts                 # Primary coding agent loop and tool execution
│   │   ├── ResearchAgent.ts         # Read-only external research agent
│   │   ├── ReseatchAgentSystemPrompt.ts # Research persona and report specifications
│   │   ├── AgentMode.ts             # Plan and Act mode definitions
│   │   ├── Message.ts               # Conversation turn data contracts
│   │   └── RunCallbacks.ts          # Streaming and status update callback interfaces
│   ├── tools/
│   │   ├── ToolRegistry.ts          # Central tool registration and schema validation
│   │   ├── CodingTools.ts           # Implementation of code_tool and coding_context_tool
│   │   ├── FileTools.ts             # File system reading, creation, and project tree traversal
│   │   ├── GitTools.ts              # Git command runner with workspace isolation
│   │   ├── executeTools.ts          # Sandboxed command execution tool
│   │   ├── ExecutionManager.ts      # Docker container lifecycle management
│   │   ├── CommandPolicy.ts         # Command whitelist, blacklist, and confirmation rules
│   │   ├── SearchTool.ts            # 4-tier web search implementation
│   │   ├── MemoryTools.ts           # Cloud memory save and search interfaces
│   │   └── MemorySearchRules.ts     # Decision criteria for memory queries
│   ├── guardrails/
│   │   ├── input/
│   │   │   ├── InputGuardrails.ts   # Prompt injection and malicious content detection
│   │   │   └── InputGuardrailPrompt.ts
│   │   ├── output/
│   │   │   ├── OutputGuardrails.ts  # Secret leak and reasoning disclosure detection
│   │   │   └── OutputGuardrailPrompt.ts
│   │   ├── SecretScanner.ts         # Shannon entropy and regex secret scanner
│   │   └── types/                   # Guardrail context and result definitions
│   ├── providers/
│   │   ├── LLMProvider.ts           # Provider abstraction contract
│   │   ├── LLMResponse.ts           # Response interfaces and token callback types
│   │   ├── GeminiProvider.ts        # Gemini LLM model implementation
│   │   └── GeminiStreaming.ts       # Streaming helper utilities
│   ├── cli/
│   │   ├── AgentCLI.ts              # Interactive REPL session controller
│   │   ├── AgentUI.ts               # Terminal UI rendering, composer, and formatting
│   │   └── TerminalState.ts         # Spinner coordination during interactive prompts
│   ├── config/
│   │   └── ConfigManager.ts         # Keytar vault and AES-256-GCM configuration storage
│   ├── logger/
│   │   └── AgentLogger.ts           # Sanitized, redacted terminal logger
│   └── utils/
│       └── ErrorTranslator.ts       # Structured error classifier and translator
├── docker-compose.yaml              # Docker sandbox container definition
├── sandbox.Dockerfile               # Ubuntu-based sandbox environment configuration
├── tsconfig.json                    # Strict TypeScript configuration
└── package.json                     # Project dependencies and script declarations
```

---

## Comparative analysis

| Feature | REXA | Claude Code | OpenHands |
| :--- | :--- | :--- | :--- |
| **Plan reflection before tool calls** | Yes (Automated pre-flight check via Gemini LLM model) | Partial | Partial |
| **Multi-agent routing** | Yes (Dedicated Supervisor and Research Agent) | Partial | Partial |
| **Docker sandboxed command execution** | Yes (Default, non-root, isolated volumes) | No | Yes |
| **Dual-layer guardrails** | Yes (Independent input and output evaluation) | No | No |
| **Entropy-based secret scanning** | Yes (Regex pattern analysis + Shannon entropy) | No | Partial |
| **External web research tier** | Yes (Tavily, GitHub, DuckDuckGo, Web Scrape) | Partial | Yes |
| **Plan vs. Act operational modes** | Yes (Interactive single-key toggle) | Yes | Yes |
| **License** | MIT License | Proprietary | MIT License |

---

## Troubleshooting

### Docker sandbox is unavailable
- Ensure Docker Desktop is active: verify with `docker version`.
- Verify Docker Compose availability: verify with `docker compose version`.
- If permission errors occur on Linux, verify your user belongs to the `docker` usergroup (`sudo usermod -aG docker $USER`).

### Guardrail rejection errors
- If input is blocked with `Potential secret detected`, ensure API keys or passwords are not pasted into the interactive chat. Use `rexa config set-key` or environment variables instead.
- If input is blocked with `Input too long`, shorten the initial prompt and instruct the agent to inspect large files via `coding_context_tool`.

### Rate limiting or API quota exhaustion
- REXA automatically detects HTTP 429 quota exhaustion. If this occurs, verify quota limits in Google AI Studio or supply a dedicated guardrail key via `GEMINI_GUARD_API_KEY`.

### Persistent memory authentication failure
- Run `rexa login` to refresh the CLI authentication token.
- Free-tier cloud instances may take up to 60 seconds to wake from idle states. Retry after a short interval if connection times out.

---

## Development and verification

To contribute or test modifications locally:

```bash
# Run strict TypeScript compilation checks
bun run typecheck

# Start local Docker sandbox manually
bun run docker:up

# Tear down Docker sandbox environment
bun run docker:down

# Rebuild the Docker sandbox image
bun run docker:build
```

---

## Contributing

Contributions are welcome. Please refer to [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md) for contribution guidelines and development workflow standards.

---

## License

This project is licensed under the terms of the [MIT License](./LICENSE).
