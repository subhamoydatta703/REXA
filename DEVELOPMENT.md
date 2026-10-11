# Developing Rexa

Rexa runs TypeScript with Bun. Repository discovery and code search use ripgrep (`rg`). Approved sandbox commands run in Linux Docker containers; the process supervisor also runs TypeScript with Bun inside the container.

## The five priorities

The user-facing workflow and commands are documented in the [README](./README.md#five-core-improvements). These are the implementation boundaries:

| Priority | Main modules | Enforced behavior and limits |
| --- | --- | --- |
| Repository understanding | `RepositoryTools.ts`, `Workspace.ts` | Ignore-aware discovery, bounded search/read output, protected paths, and rejection of paths resolving outside the project. Reads load the whole eligible file and hash its complete contents. |
| Plan mode | `ToolDispatcher.ts`, `Agent.ts` | Only `read` and `web` effects are exposed and executable in plan mode. Commands, including test commands, are blocked. Reflection and planning quality remain model-dependent. |
| Editing and undo | `SafeEditor.ts`, `CheckpointStore.ts`, `StaleEditRecovery.ts` | Prepare/revalidate batches, detect stale contents, checkpoint eligible files, require fresh reads during recovery, and cap recovery attempts. Multi-file writes require rollback on failure; they are not OS-atomic. |
| Sessions and context | `SessionStore.ts`, `SessionRecovery.ts`, `ContextManager.ts`, `LocalCommands.ts` | Save workspace-scoped transcripts, restore conversations, represent unknown tool outcomes without replay, and compact older context. Summaries may omit information; process handles are not persisted. |
| Permissions and commands | `PermissionService.ts`, `ToolDispatcher.ts`, `ExecutionManager.ts`, `ProcessManager.ts`, `sandbox-supervisor.ts` | Validate and authorize operations, manage container commands and descendants, bound retained output, and support cancellation. Approved commands can write mounted project files. `/app` operations through `git_command` run on the host. |

Local state is rooted at `~/.rexa/workspaces/<workspace-id>`, using a hash of the absolute workspace path. Sessions, permission configuration, and checkpoints are separate from authenticated cloud preference memory. Starting Rexa from a different project path selects a different local state directory.

## Permission flow

Tool effects are part of the execution contract. Classify new tools accurately: plan mode allows only `read` and `web`. Unclassified tools are unavailable in plan mode and default to asking in act mode.

Permission rules are evaluated in order; the last matching rule wins. Reads and web tools default to allow, while edits, commands, external effects, and unknown effects default to ask. An explicit deny is checked before session grants. Session approval fingerprints the tool, effect, and complete validated arguments with sorted object keys. An operation requiring a prompt is denied when standard input is not a TTY.

The executable-name schema is not a sandbox policy or executable allowlist. Keep claims about protection scoped correctly: file-tool path checks do not constrain approved interpreter code, Docker has a writable project mount and networking by default, and host Git can invoke configured hooks and helpers.

`ResearchAgent` builds a restricted registry containing only `search` and `read_url`, then uses the same dispatcher for supplied URLs and model tool calls. Main-agent plan mode retains its read/web tools; it does not delegate to the separate research agent. Keep these two boundaries distinct when adding tools or changing routing.

Both workflows reuse the registered web-tool implementations. Repository tools belong to the main agent's planning context, not to the research agent's restricted registry. A routing test that skips `ResearchAgent.execute()` in plan mode does not establish that plan mode cannot retrieve URLs: the main agent can execute permitted web tools itself.

Research cancellation is checked before work and between calls, and forwarded to model generation and retrieval. `Cancellation.ts` stops waiting for operations that do not expose cancellation themselves; this helper alone cannot terminate their underlying work. HTTP, browser subrequests, Tavily requests, and LinkedIn fetches receive actual abort signals. DNS lookup and guardrail evaluation may finish internally after Rexa stops waiting, and already-submitted remote collection jobs are outside local cancellation control.

`TavilyRequest.ts` uses a fixed-origin authenticated HTTP request for search and extraction because the installed Tavily SDK does not expose request cancellation. It validates the consumed response fields and retains a 15-second deadline. The provider wire fields (`max_results`, `include_raw_content`, `extract_depth`, `raw_content`) are mapped explicitly in the search and reader implementations.

## Where to start reading

| Area              | Entry point                                                                           | Responsibility                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Startup           | `src/index.ts`                                                                        | Configure providers, register tools, open session storage, and start the CLI.                                   |
| Terminal          | `src/cli/AgentCLI.ts`                                                                 | Read prompts, handle local commands, display output, and cancel a task with Ctrl+C.                             |
| Local commands    | `src/cli/LocalCommands.ts`                                                            | Handle `/resume`, `/continue`, `/diff`, `/undo`, and process commands without sending them to the model.        |
| Optional API setup | `src/cli/OptionalApiSetup.ts` | Explain optional providers, require explicit Y/N input, and request masked keys only after Y. |
| Routing           | `src/orchestration/Orchestrator.ts`                                                   | Route a request to a direct response, the main agent, or research.                                              |
| Agent loop        | `src/agent/Agent.ts`                                                                  | Generate a response, review proposed tool calls, execute them, record results, and validate the final response. |
| Tool boundary     | `src/tools/ToolDispatcher.ts`                                                         | Enforce plan/act restrictions, validate arguments, and request permission before execution.                     |
| Repository reads  | `src/tools/RepositoryTools.ts`, `src/tools/Workspace.ts`                              | Discover files, search text, read bounded source ranges, and enforce file-tool path restrictions.               |
| Editing           | `src/tools/SafeEditor.ts`, `src/tools/CheckpointStore.ts`                             | Prepare edits, detect stale content, record transactions, and restore eligible file changes.                    |
| Commands          | `src/tools/executeTools.ts`, `src/tools/ExecutionManager.ts`                          | Expose command tools, own a Docker Compose project, and associate command results with snapshots.               |
| Processes         | `src/tools/ProcessManager.ts`                                                         | Track process handles, consume output, send stdin, and manage timeout/cancellation.                             |
| Container cleanup | `src/tools/sandbox-supervisor.ts`                                                     | Own a Linux process group and terminate its descendants on completion, timeout, or cancellation.                |
| Sessions          | `src/sessions/SessionStore.ts`                                                        | Append and load versioned transcript snapshots for a workspace.                                                 |
| Recovery          | `src/sessions/SessionRecovery.ts`                                                     | Represent missing tool results as unknown outcomes without replaying calls.                                     |
| Context           | `src/sessions/ContextManager.ts`                                                      | Summarize older context while retaining recent turns and original user requirements.                            |
| Verification | `src/verification/VerificationWorkflow.ts`, `VerificationRunner.ts`, `VerificationResults.ts` | Coordinate debugging, execute checks, observe stability, and report evidence. |
| Shared utilities  | `src/utils/SanitizeStored.ts`, `src/utils/WorkspaceData.ts`, `src/utils/FileLease.ts` | Redact sensitive data, locate private project storage, and guard concurrent state writers.                      |

The original exports of `sanitizeStored`, `recoverInterruptedMessages`, and `workspaceDataDirectory` remain available from their previous modules for compatibility. New production callers import these functions from their focused modules.

## Follow one tool call

Before the chat starts, `src/index.ts` completes required authentication and Gemini setup, then calls `runOptionalApiSetup()`. The optional setup module returns immediately unless both standard input and output are TTYs. Existing keys or completed provider decisions suppress the matching question. Explicit config commands do not go through onboarding.

`ConfigManager` stores independent `optionalApiSetup` completion flags alongside encrypted credentials in the user configuration. A skip is recorded only after N; a key's setup is completed only after its setter succeeds. Cancellation, empty keys, and storage failures leave that provider incomplete. Tavily and Bright Data setters accept storage success in the OS vault or encrypted file, and throw if both fail. This verifies storage, not provider authentication.

1. The provider returns a tool name and arguments to `Agent.run()`.
2. The agent records the model turn before executing its calls.
3. `ToolDispatcher.execute()` checks whether the tool is available in the current mode and validates the arguments with its Zod schema.
4. `PermissionService.authorize()` evaluates rules in order; the last matching rule wins. A session grant applies to the exact operation and arguments.
5. The tool executes. Editing uses checkpoints; sandbox commands use `ExecutionManager` and `ProcessManager`.
6. The agent sanitizes and bounds the result, appends a tool response, and saves the session before requesting another model response.

The shared `Tool` interface accepts different argument and result shapes, so it retains a dynamic execution boundary. Within a tool, parse arguments before using them. Prefer concrete types or validated `unknown` in the rest of the implementation.

## Lifecycle rules that must remain visible

- Validate every edit in a batch before writing any file. Recheck content during writes, and check all restore conflicts before restoring any file.
- An edit checkpoint progresses from `pending` to `complete`, or to `rolled_back` after recovery. Undo changes a completed checkpoint to `undone`.
- A command snapshot starts as `recording` and becomes `complete` after capturing eligible changed files. It is a file snapshot, not a reversal of all command effects. Ignored files, credentials, binaries, Git history, external effects, and private `/workspace` clones are outside its documented scope.
- Session JSONL files contain full snapshots. Ignore an incomplete final line after interruption; report corruption in committed records.
- A missing tool response does not prove whether the operation ran. Recovery records that uncertainty and never replays the call automatically.
- Keep a model tool-call turn together with its responses when compacting context. The token estimate is approximate, and a summary can omit details.
- For container commands, stop the remote process group before killing the host Docker client. In the Linux supervisor, a negative PID targets a process group.
- Keep cancellation listeners active until cleanup is finished. Clear timers and listeners when a managed process completes.
- Await final-response validation and session persistence inside the agent's `try` block so errors reach its interruption handler and cleanup follows validation.
- Sanitize complete output lines before streaming them; a credential may span several incoming chunks. Retained output has a separate size limit.
- File-tool path restrictions are not an operating-system sandbox. An approved Docker command can access the mounted project files.

## Automatic verification architecture

`src/index.ts` enables verification on the coding agent with its active workspace. Programmatic `Agent` instances opt in through `enableVerification(workspace)`, keeping test fixtures and other embeddings explicit. Plan mode never creates an active verification task.

| Module | Responsibility |
| --- | --- |
| `VerificationWorkflow.ts` | Coordinate preparation, execution, investigation, repair, and completion. Validate coverage references and test-file existence, preserve baseline commands, and bound repair rounds. |
| `VerificationRunner.ts` | Discover optional baseline commands, validate selected commands, execute through `ToolDispatcher`, capture bounded output and reported locations, and compare workspace fingerprints. |
| `VerificationResults.ts` | Define check, submission, coverage, and session-evidence schemas; build a sanitized deterministic report. |
| `../agent/DebuggingAgent.ts` | A separate bounded model loop for inspecting source, creating/reusing tests, and repairing failures. Only repository read tools, `code_tool`, and `submit_debugging` are available. |

Baseline evidence is recorded before appending the main model's modifying tool-call turn. If the debugging agent makes the first edit, its before-edit callback establishes the baseline. Provider raw parts and call/result ordering are retained. Commands execute through the runner's dispatcher, preventing recursive verification. Mutating failures conservatively require testing; rejected mutations stop debugging rather than authorizing a bypass.

Before accepting a coding completion, `Agent` creates a `DebuggingAgent` and calls `workflow.finish()`. Mutations, resumed tasks, or explicit coding/test request words trigger the workflow; unchanged conversations and reported documentation-only edits normally skip it. This request-word detection is a heuristic. The debugging agent must submit structured coverage, commands, findings, and any blocker through `submit_debugging`; prose success cannot complete the workflow. The application checks that referenced tests exist and commands are valid, but coverage adequacy remains a model judgment.

Feature checks can trigger repair without a passing baseline. A command already failed at baseline is not automatically treated as a new regression. Baseline checks remain selected, and commands/coverage cannot change during repair. Listed test-file fingerprints detect revisions, which require an explanation. This is an accountability mechanism, not semantic proof against weak tests. Each repair is followed by fresh execution, even when no successful edit was reported. There are at most two repair rounds and 30 debugging model steps shared across phases, further capped by the main loop's remaining allowance. Both agents share the task's `StaleEditRecovery` state and edit sequentially.

The session stores stages, bounded debugging exchanges, findings, and evidence before dispatching each check and after it returns. A crash can leave an unknown outcome. New tasks create fresh workflow state; old evidence fields are optional for session compatibility. Debugging history is not replayed or recursively embedded in new handoffs. Verification evidence messages are excluded from original-user-requirement anchors during compaction.

Final response validation finishes before one more workspace stability check and the deterministic report. Concurrent changes invalidate earlier pass/fail conclusions. This is bounded observation, not an atomic filesystem lock. Snapshots follow repository ignore/protected-path rules, omit binary contents, reject discovered files larger than 2,000,000 bytes, and stop above a 32,000,000-byte aggregate. Out-of-scope or external command effects cannot be certified by this mechanism.

The runner defaults each check to 60 seconds and accepts at most 300 seconds, sharing a 600-second accumulated command/approval-time budget. It saves up to 8,000 sanitized characters for each output stream per check and extracts at most 30 recognizable source locations. It does not universally parse per-test counts, assertion fields, or root causes; original bounded output remains the evidence. Debugging tool responses are bounded to 24,000 characters and model context to 160,000 characters before generation. Investigation text is model-authored, distinct from recorded command outcomes.

`tests/core/verification.test.ts` covers the three-file structure, preparation/repair decisions, real connected-feature test execution, unchanged tests after a source fix, persisted evidence, fresh resume, permissions, cancellation, budgets, and final-report invalidation. Model responses are controlled fixtures. The Docker suite separately exercises the real sandbox command boundary; these tests do not establish live-model debugging quality.

## Stale-edit recovery

`EditConflictError.ts` supplies structured conflict results. `StaleEditRecovery.ts` tracks recovery for one `Agent.run()`; the editor receives that state through `ToolExecutionContext`. No failed operation is automatically replayed.

After a `STALE_FILE` result, the model must inspect the latest file and reconsider the proposed edit using the original task. The editor requires a newer nonempty workspace read before another attempt. An explicit `expected_hash` must match that observed read. File identities are canonicalized so alternate path spellings and directory symlinks share the same recovery budget.

Each file gets at most two recovery edit attempts in a task. Reads and successful recoveries do not replenish that budget. A further conflict after the budget is used reports `STALE_RETRY_LIMIT`. A new user task starts a new budget. This tracking is in memory; resuming a conversation does not replay interrupted edits.

The whole edit batch is prepared and revalidated. A rollback failure reports `RECOVERY_CONFLICT`, retains the checkpoint, and blocks further `code_tool` edits for that task. Cancellation stops recovery, and cancellation during a transaction attempts rollback. Final responses include a notice if a detected edit conflict remains unresolved.

The model is instructed to preserve unrelated user changes, investigate missing or ambiguous targets, ask when intent is unclear, and run relevant checks after a recovered edit. Freshness and retry limits are enforced in code. Understanding the user's intent and selecting adequate tests still depend on model reasoning; approved shell commands remain outside this file-edit guard.

## Readability conventions

- Use descriptive names: `checkpoint`, `workspace`, `processHandle`, and `newlineIndex`. Short loop counters are appropriate when their meaning is immediately clear.
- Give a function one identifiable responsibility. Extract a helper when its name makes the caller easier to follow; keep related logic together.
- Use braces for control-flow bodies. Prefer explicit branches to nested ternaries or comma expressions containing side effects.
- Use named constants for meaningful limits. Keep externally visible argument names, messages, and persisted field names stable during readability refactors.
- Put a blank line between class methods and between distinct stages of a function. Use four-space indentation, semicolons, and the existing multiline formatting style.
- Comment on ordering constraints, platform behavior, and recovery decisions. Avoid comments that only repeat the next statement.
- Explain necessary type assertions at external boundaries. Avoid assertions merely to hide a type mismatch.
- Keep prompts and protocol payloads intact when reorganizing code. Moving asynchronous work into a helper must preserve error handling and cleanup order.
- Keep bug fixes distinguishable from readability changes. Verify behavior after each substantial extraction, rather than relying on formatting or line counts as proof of quality.

## Verify a change

```sh
bun run typecheck
bun run test:core
bun run test:web
bun run test:web:browser
bun run test:docker
git diff --check
```

Core tests exercise repository reads, permissions, editing, processes, planning, and sessions. Web tests use fixtures and mocked providers. Browser tests require the installed Chromium runtime. Docker tests require a running Docker daemon and build the sandbox image; the command fixtures include Python programs to check child-process cleanup and stdin.

`tests/core/optional-api-setup.test.ts` uses injected prompts and storage to cover strict Y/N validation, skip/entry decisions, independent provider state, cancellation, missing input, failure reporting, and noninteractive behavior. An isolated subprocess with a temporary home and mocked OS vault exercises real encrypted config persistence, environment precedence, and rejected saves without touching developer credentials or paid APIs.

Docker lifecycle tests mount a disposable temporary workspace. On Linux, `mkdtemp` creates that directory with mode `0700`, while the container runs as UID 1000. The fixture explicitly sets mode `0755` so a different CI runner UID does not prevent the sandbox from entering it. This permission change applies only to the generated test directory. An inaccessible command working directory can produce a spawn `EACCES` and supervisor exit code 1 even when the requested executable exists; it does not establish an exit-code propagation bug.

`tests/core/stale-edit.test.ts` covers fresh-read enforcement, explicit-hash checks, retry budgets, alias paths, batch prevalidation, rollback conflicts, cancellation, and agent/session integration. Its agent uses mocked model responses. One recovery scenario runs a real Bun fixture test after a revised edit. These tests verify recovery mechanics; they do not establish live-model coding quality or guarantee semantic preservation of every user change.

`tests/web/research-controls.test.ts` covers denied supplied/model URLs, schema validation, cancellation before and during research, and retrieval fallback cancellation. Transport fixtures exercise cancellation during DNS and a real local HTTP body. Browser fixtures include cancellation during a real Chromium retrieval. Provider/model behavior is mocked; these checks do not call paid APIs or establish live research-answer quality.

`tests/core/verification.test.ts` covers configuration, discovery, permission denial, outcome classification, budgets, stability invalidation, bounded repairs, cancellation persistence, plan restrictions, and session refresh. Its end-to-end agent fixture uses mocked model responses with real Bun tests and the real editor. `tests/docker/lifecycle.test.ts` additionally checks the verification runner through the real Docker command tool with passing and failing Python fixtures. These tests verify mechanics; they do not establish live-model repair quality.

Review the source as well as the tests: confirm that the main path reads in execution order, failure paths are visible, and a helper's name explains why its caller needs it. A passing suite verifies the covered behavior; it does not prove every possible behavior is unchanged.
