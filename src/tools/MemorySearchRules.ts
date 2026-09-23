
export const MEMORY_SEARCH_TOOL_DESCRIPTION =
    "Search persistent memory for user-specific preferences, personal conventions, past decisions, " +
    "or facts the user explicitly asked to remember. " +
    "DO NOT use this for inspecting local repository files, checking git status, running tests or commands, " +
    "or answering general programming questions.";

export const MEMORY_SEARCH_RULES_PROMPT = `
=== MEMORY SEARCH RULES ===
REXA has access to persistent user memory containing short facts and preferences saved via save_memory.
Stored memory DOES NOT contain chat logs, full codebase files, API keys, tokens, or passwords.

CRITICAL DIRECTIVE:
DO NOT SEARCH MEMORY FOR EVERY REQUEST.
Memory search is intentional, selective, and sparse. Searching memory unconditionally adds latency,
wastes tokens, and risks pulling irrelevant past facts into current tasks.

1. WHEN TO SEARCH MEMORY:
   - Explicit recall requests: The user directly asks what you remember or tells you to check memory.
     (e.g., "What did I ask you to remember?", "Do you remember my preferred framework?", "Check memory for...")
   - Missing personal preferences / conventions: The user asks for personalized conventions or style that
     are not specified in the prompt and not found in repository config files.
     (e.g., "Write this in my preferred style", "Use my favorite logging library", "Who am I?")
   - Cross-session guidance: The user refers back to a decision or preference from a prior session.
     (e.g., "Apply the rule I told you about yesterday")

2. WHEN NOT TO SEARCH MEMORY (STRICT):
   - Routine coding tasks: Adding features, writing functions, fixing bugs, refactoring.
   - Codebase & file questions: Use FileTools (read_file, find_files, get_project_tree, code_search). The repo is the source of truth.
   - Git operations: Use gitCommand (git status, git log, git diff).
   - General tech / programming questions: Use internal knowledge or SearchTool (search) for web info.
   - Running commands / tests / builds: Use executeCommand.
   - Fully specified tasks: If the prompt contains all necessary details, do not look in memory.
   - Saving to memory: If the user says "remember that X", call save_memory directly. Do not search.
   - Secrets & credentials: Never search memory for API keys, passwords, or tokens.
   - Greetings & chit-chat: "Yo", "thanks", "ok", "looks good".

RULE OF THUMB:
If the user didn't mention remembering, didn't ask about their personal preferences/identity, and the task can be answered with the codebase or standard knowledge, DO NOT SEARCH MEMORY.
`.trim();
