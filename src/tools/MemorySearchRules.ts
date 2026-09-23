export const MEMORY_SEARCH_RULES_PROMPT = `
=== MEMORY SEARCH RULES ===
REXA has access to persistent user memory containing short facts and preferences saved via save_memory.
Stored memory DOES NOT contain full chat logs, repository files, API keys, tokens, or passwords.

CRITICAL PRINCIPLE:
DO NOT SEARCH MEMORY FOR EVERY REQUEST.
Memory search is selective, deliberate, and sparse. Searching memory unconditionally degrades speed,
wastes tokens, and risks pulling irrelevant past facts into current tasks.

1. WHEN TO SEARCH MEMORY (TRUE):
   - Explicit recall requests: The user directly asks what you remember or tells you to check memory.
     (e.g., "What did I ask you to remember?", "Do you remember my preferred framework?", "Check memory for...")
   - Missing personal preferences / conventions: The user asks for personalized conventions or style that
     are not specified in the prompt and not found in repository config files.
     (e.g., "Write this in my preferred style", "Use my favorite logging library", "Who am I?")
   - Cross-session guidance: The user refers back to a decision or preference from a prior session.
     (e.g., "Apply the rule I told you about yesterday")

2. WHEN NOT TO SEARCH MEMORY (FALSE):
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

// Heuristic pattern matchers
const GREETING_PATTERNS = [
    /^(?:yo|hey|hello|hi|sup|howdy|good (?:morning|afternoon|evening)|thanks|thank you|ok|okay|cool|bet|gotchu|sounds good)[\s!.]*$/i,
];

const MEMORY_SAVE_PATTERNS = [
    /\b(?:remember that|save (?:this )?to memory|store in memory|keep in mind that|don't forget that|please remember|add to memory)\b/i,
];

const SENSITIVE_PATTERNS = [
    /\b(?:api[\s_-]?keys?|passwords?|tokens?|secrets?|credentials?|auth[\s_-]?tokens?|private[\s_-]?keys?)\b/i,
];

const EXPLICIT_MEMORY_QUERY_PATTERNS = [
    /\b(?:do you remember|did i tell you to remember|what did i tell you|have you saved)\b/i,
    /\b(?:in (?:your|my) memory|from memory|search (?:your |the )?memory|check (?:your |the )?memory)\b/i,
    /\b(?:what (?:is|are) my (?:favorite|preferred|usual|default) (?:stack|framework|library|language|port|tool|style|convention))\b/i,
    /\b(?:who am i|what is my name|what do you know about me)\b/i,
    /\b(?:what have i told you|what do you remember)\b/i,
    /\b(?:recall (?:what|my|the|our))\b/i,
    /\b(?:my preferred|my usual|my favorite|my standard|my default convention|how do i usually)\b/i,
    /\b(?:as we (?:discussed|agreed)|in (?:our|the) (?:last|previous) session|like i told you (?:yesterday|before|earlier))\b/i,
];

const CODEBASE_OR_FILE_PATTERNS = [
    /\b(?:read_file|find_files|package\.json|tsconfig\.json|docker-compose|dockerfile)\b/i,
    /\b(?:where is (?:the|this) (?:file|function|class|method|interface|type|variable|route|endpoint))\b/i,
    /\b(?:list files|project tree|directory structure|show tree|find all files|in this repo|in this codebase)\b/i,
    /\b(?:look at line|in file |in src\/|inside src\/)\b/i,
];

const GIT_PATTERNS = [
    /\b(?:git status|git diff|git log|git commit|git push|git pull|git branch|git checkout|git switch|git merge)\b/i,
    /\b(?:what branch|staged changes|unstaged changes|last commit|commit history)\b/i,
];

const EXECUTION_PATTERNS = [
    /\b(?:run tests?|bun test|npm test|npm run|bun run|execute|docker compose|build the project|compile)\b/i,
];


export function shouldSearchMemory(query: string): boolean {
    const trimmed = (query || "").trim();

    if (!trimmed) {
        return false;
    }

    // 1. Casual chit-chat / greetings -> false
    if (GREETING_PATTERNS.some((p) => p.test(trimmed))) {
        return false;
    }

    // 2. Saving to memory (use save_memory instead) -> false
    if (MEMORY_SAVE_PATTERNS.some((p) => p.test(trimmed))) {
        return false;
    }

    // 3. Secrets / API keys / Credentials -> false
    if (SENSITIVE_PATTERNS.some((p) => p.test(trimmed)) && /\b(?:search|find|get|show|what is)\b/i.test(trimmed)) {
        return false;
    }

    // 4. Explicit memory recall or user preference inquiry -> true
    if (EXPLICIT_MEMORY_QUERY_PATTERNS.some((p) => p.test(trimmed))) {
        return true;
    }

    // 5. Codebase / file operations -> false
    if (CODEBASE_OR_FILE_PATTERNS.some((p) => p.test(trimmed))) {
        return false;
    }

    // 6. Git commands -> false
    if (GIT_PATTERNS.some((p) => p.test(trimmed))) {
        return false;
    }

    // 7. Terminal execution / tests -> false
    if (EXECUTION_PATTERNS.some((p) => p.test(trimmed))) {
        return false;
    }

    // 8. Default baseline: false (do not search memory for routine tasks)
    return false;
}


