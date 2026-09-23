

export type MemorySearchAction = "SEARCH" | "DO_NOT_SEARCH";

export type MemorySearchCategory =
    | "EXPLICIT_RECALL"              // User explicitly asks what is remembered or to check memory
    | "USER_PREFERENCE_OR_IDENTITY"   // User personal preference, coding habit, or identity detail
    | "CROSS_SESSION_CONTEXT"        // User refers to decisions or notes established in previous sessions
    | "CODEBASE_OR_FILE_OPERATION"   // Task belongs to local files or repo inspection -> DO NOT SEARCH
    | "GIT_OR_VCS_OPERATION"         // Task belongs to version control -> DO NOT SEARCH
    | "GENERAL_KNOWLEDGE_OR_CODING"  // Standard algorithms, syntax, public tech questions -> DO NOT SEARCH
    | "TERMINAL_OR_TEST_EXECUTION"   // Command execution, test runs, linting -> DO NOT SEARCH
    | "SELF_CONTAINED_REQUEST"       // All context is already in the prompt -> DO NOT SEARCH
    | "MEMORY_SAVE_OPERATION"        // Request is saving new memory via save_memory -> DO NOT SEARCH
    | "SENSITIVE_DATA_OR_CREDENTIALS"// Secrets, API keys, passwords -> DO NOT SEARCH
    | "CONVERSATIONAL_OR_GREETING"   // Chit-chat, greetings, acknowledgments -> DO NOT SEARCH
    | "DEFAULT_NO_SEARCH";           // Default fallback is to NOT search memory

export interface MemorySearchRule {
    id: string;
    action: MemorySearchAction;
    category: MemorySearchCategory;
    title: string;
    description: string;
    examples: string[];
    alternativeTool?: string;
}

export interface MemorySearchDecision {
    shouldSearch: boolean;
    category: MemorySearchCategory;
    reason: string;
    suggestedAlternativeTool?: string;
}

// Structured rules defining when memory should and should not be searched.

export const MEMORY_SEARCH_RULES: readonly MemorySearchRule[] = [
    
    // WHEN TO SEARCH MEMORY (Search Triggers)
    {
        id: "MSR-001",
        action: "SEARCH",
        category: "EXPLICIT_RECALL",
        title: "Explicit Memory Recall Request",
        description:
            "Search memory when the user explicitly asks what is in memory, instructs the agent to check/search memory, or asks what was remembered.",
        examples: [
            "What did I tell you to remember about my environment?",
            "Do you remember my favorite test runner?",
            "Check your memory for my author details.",
            "What do you have saved in memory about this project?",
            "Recall the note I gave you earlier.",
        ],
    },
    {
        id: "MSR-002",
        action: "SEARCH",
        category: "USER_PREFERENCE_OR_IDENTITY",
        title: "User Profile, Persona, or Subjective Developer Preferences",
        description:
            "Search memory when the prompt depends on personal user defaults, custom habits, or identity information that cannot be inferred from local files.",
        examples: [
            "Who am I and what do I usually work on?",
            "Generate this component using my preferred styling convention.",
            "Write the commit message in my usual format.",
            "What license do I normally use for my projects?",
            "Set up the template with my personal defaults.",
        ],
    },
    {
        id: "MSR-003",
        action: "SEARCH",
        category: "CROSS_SESSION_CONTEXT",
        title: "Cross-Session Precedent or Prior Guidance",
        description:
            "Search memory when the user explicitly references past instructions, architectural guidelines, or decisions made in prior sessions.",
        examples: [
            "Use the architecture pattern we agreed upon last week.",
            "Apply the custom naming convention I told you about previously.",
            "Continue with the approach we decided on in our earlier session.",
        ],
    },

    // WHEN NOT TO SEARCH MEMORY (Strict Negative Rules)
    {
        id: "MSR-101",
        action: "DO_NOT_SEARCH",
        category: "DEFAULT_NO_SEARCH",
        title: "Default Baseline Rule: Do Not Search On Routine Requests",
        description:
            "Never search memory by default. The vast majority of software development tasks are self-contained or repository-focused and require no memory retrieval.",
        examples: [
            "Add a new helper function in utils.ts",
            "Refactor the authentication controller",
            "Why is this variable undefined?",
            "Format the output as a table",
        ],
    },
    {
        id: "MSR-102",
        action: "DO_NOT_SEARCH",
        category: "CODEBASE_OR_FILE_OPERATION",
        title: "Local Codebase, File, or Directory Inspection",
        description:
            "Do not search memory for project code, file paths, configurations, or directory structure. The codebase itself is the source of truth.",
        examples: [
            "Where is the database connection initialized?",
            "Show me the directory structure of src/",
            "Read package.json and tell me what dependencies we have.",
            "Find all files matching *.controller.ts.",
            "Check how error handling is implemented in this repo.",
        ],
        alternativeTool: "FileTools (get_project_tree, read_file, find_files, code_search)",
    },
    {
        id: "MSR-103",
        action: "DO_NOT_SEARCH",
        category: "GIT_OR_VCS_OPERATION",
        title: "Version Control and Repository History",
        description:
            "Do not search memory for git commits, branches, staged changes, or remote tracking. Query git directly.",
        examples: [
            "What's the status of the current git branch?",
            "Show me the last 5 commits.",
            "What changed in the last commit?",
            "Create a new branch called feature/auth.",
        ],
        alternativeTool: "gitCommand",
    },
    {
        id: "MSR-104",
        action: "DO_NOT_SEARCH",
        category: "GENERAL_KNOWLEDGE_OR_CODING",
        title: "General Programming, Syntax, and Public Technology Questions",
        description:
            "Do not search memory for standard language features, algorithms, libraries, or public technical documentation. Use internal knowledge or web search.",
        examples: [
            "How does Promise.allSettled work in TypeScript?",
            "Write a function to perform binary search.",
            "Explain the difference between interface and type in TypeScript.",
            "What are the latest features in Node.js 22?",
        ],
        alternativeTool: "Internal LLM Knowledge or SearchTool (search)",
    },
    {
        id: "MSR-105",
        action: "DO_NOT_SEARCH",
        category: "TERMINAL_OR_TEST_EXECUTION",
        title: "Build, Test, and Terminal Command Execution",
        description:
            "Do not search memory when running tests, building artifacts, diagnosing stack traces, or executing shell scripts.",
        examples: [
            "Run bun test.",
            "Execute npm run build and check for errors.",
            "Why is the docker container failing to start?",
            "Run the linter across the project.",
        ],
        alternativeTool: "executeCommand",
    },
    {
        id: "MSR-106",
        action: "DO_NOT_SEARCH",
        category: "SELF_CONTAINED_REQUEST",
        title: "Self-Contained or Fully Specified Instructions",
        description:
            "Do not search memory when the user's prompt or ongoing conversation already contains all parameters, specifications, and code snippets needed.",
        examples: [
            "Rename the userCount parameter to activeUserCount in line 45.",
            "Replace the background color with #1e1e2e.",
            "Convert this array of objects to a Map keyed by id.",
        ],
    },
    {
        id: "MSR-107",
        action: "DO_NOT_SEARCH",
        category: "MEMORY_SAVE_OPERATION",
        title: "Active Memory Saving Operations",
        description:
            "Do not search memory when the user is explicitly telling you to save, record, or remember something. Directly call save_memory.",
        examples: [
            "Remember that I prefer Bun over Node.",
            "Save to memory: my preferred port is 8080.",
            "Please remember that I use ESLint with prettier.",
        ],
        alternativeTool: "save_memory",
    },
    {
        id: "MSR-108",
        action: "DO_NOT_SEARCH",
        category: "SENSITIVE_DATA_OR_CREDENTIALS",
        title: "Secrets, Tokens, Passwords, and API Keys",
        description:
            "Never search memory for sensitive credentials. MemoryTools strictly prohibits storing API keys, passwords, and tokens, so memory will never contain them.",
        examples: [
            "Look in memory for my Gemini API key.",
            "What is my database password stored in memory?",
            "Find my GitHub personal access token.",
        ],
        alternativeTool: "ConfigManager / Environment variables / OS Credential Vault",
    },
    {
        id: "MSR-109",
        action: "DO_NOT_SEARCH",
        category: "CONVERSATIONAL_OR_GREETING",
        title: "Conversational Greetings, Chit-Chat, and Confirmations",
        description:
            "Do not search memory for greetings, casual remarks, simple confirmations, or pleasantries.",
        examples: [
            "Yo!",
            "Good morning.",
            "Thanks, that worked.",
            "Sounds good, let's proceed.",
            "What's up bro?",
        ],
    },
] as const;


//   System prompt instructions explaining when to search memory and when to avoid it.
//   Designed to be injected directly into LLM agent system prompts.
 
export const MEMORY_SEARCH_RULES_PROMPT = `
=== MEMORY SEARCH RULES ===
REXA has access to persistent user memory containing short facts and preferences saved via save_memory.
Stored memory DOES NOT contain full chat logs, repository files, API keys, tokens, or passwords.

CRITICAL PRINCIPLE:
DO NOT SEARCH MEMORY FOR EVERY REQUEST.
Memory search is selective, deliberate, and sparse. Searching memory unconditionally degrades speed,
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

// Heuristic pattern matchers
const EXPLICIT_MEMORY_QUERY_PATTERNS = [
    /\b(?:do you remember|did i tell you to remember|what did i tell you|have you saved)\b/i,
    /\b(?:in (?:your|my) memory|from memory|search (?:your |the )?memory|check (?:your |the )?memory)\b/i,
    /\b(?:what (?:is|are) my (?:favorite|preferred|usual|default) (?:stack|framework|library|language|port|tool|style|convention))\b/i,
    /\b(?:who am i|what is my name|what do you know about me)\b/i,
    /\b(?:what have i told you|what do you remember)\b/i,
    /\b(?:recall (?:what|my|the|our))\b/i,
];

const MEMORY_SAVE_PATTERNS = [
    /\b(?:remember that|save (?:this )?to memory|store in memory|keep in mind that|don't forget that)\b/i,
    /\b(?:please remember|add to memory)\b/i,
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

const SENSITIVE_PATTERNS = [
    /\b(?:api[\s_-]?keys?|passwords?|tokens?|secrets?|credentials?|auth[\s_-]?tokens?|private[\s_-]?keys?)\b/i,
];

const GREETING_PATTERNS = [
    /^(?:yo|hey|hello|hi|sup|howdy|good (?:morning|afternoon|evening)|thanks|thank you|ok|okay|cool|bet|gotchu|sounds good)[\s!.]*$/i,
];


export function evaluateMemorySearchNeed(query: string): MemorySearchDecision {
    const trimmed = (query || "").trim();

    if (!trimmed) {
        return {
            shouldSearch: false,
            category: "DEFAULT_NO_SEARCH",
            reason: "Empty prompt does not warrant memory search.",
        };
    }

    // 1. Check conversational chit-chat
    if (GREETING_PATTERNS.some((p) => p.test(trimmed))) {
        return {
            shouldSearch: false,
            category: "CONVERSATIONAL_OR_GREETING",
            reason: "Casual greetings, acknowledgments, and chit-chat do not require memory retrieval.",
        };
    }

    // 2. Check memory save operations (should call save_memory, NOT search)
    if (MEMORY_SAVE_PATTERNS.some((p) => p.test(trimmed))) {
        return {
            shouldSearch: false,
            category: "MEMORY_SAVE_OPERATION",
            reason: "User is asking to save new information to memory. Use save_memory instead of searching.",
            suggestedAlternativeTool: "save_memory",
        };
    }

    // 3. Check for sensitive information (never stored or searched in memory)
    if (SENSITIVE_PATTERNS.some((p) => p.test(trimmed)) && /\b(?:search|find|get|show|what is)\b/i.test(trimmed)) {
        return {
            shouldSearch: false,
            category: "SENSITIVE_DATA_OR_CREDENTIALS",
            reason: "Secrets, passwords, and API keys are strictly excluded from memory per MemoryTools policy.",
            suggestedAlternativeTool: "ConfigManager / Environment Variables",
        };
    }

    // 4. Check explicit memory recall triggers (POSITIVE SEARCH TRIGGER)
    if (EXPLICIT_MEMORY_QUERY_PATTERNS.some((p) => p.test(trimmed))) {
        return {
            shouldSearch: true,
            category: "EXPLICIT_RECALL",
            reason: "User explicitly requested recall of remembered facts, preferences, or identity.",
        };
    }

    // 5. Check local codebase / file operations
    if (CODEBASE_OR_FILE_PATTERNS.some((p) => p.test(trimmed))) {
        return {
            shouldSearch: false,
            category: "CODEBASE_OR_FILE_OPERATION",
            reason: "Request pertains to local workspace files, paths, or repo structure. Inspect the codebase directly.",
            suggestedAlternativeTool: "FileTools (get_project_tree, read_file, find_files, code_search)",
        };
    }

    // 6. Check Git operations
    if (GIT_PATTERNS.some((p) => p.test(trimmed))) {
        return {
            shouldSearch: false,
            category: "GIT_OR_VCS_OPERATION",
            reason: "Request pertains to git repository state or history. Query git directly.",
            suggestedAlternativeTool: "gitCommand",
        };
    }

    // 7. Check terminal / test execution
    if (EXECUTION_PATTERNS.some((p) => p.test(trimmed))) {
        return {
            shouldSearch: false,
            category: "TERMINAL_OR_TEST_EXECUTION",
            reason: "Request executes tests, builds, or commands. Workspace tools should be used directly.",
            suggestedAlternativeTool: "executeCommand",
        };
    }

    // 8. Default baseline: DO NOT SEARCH
    return {
        shouldSearch: false,
        category: "DEFAULT_NO_SEARCH",
        reason: "Standard self-contained task or query. Memory search is only conducted when explicitly relevant.",
    };
}


export function shouldSearchMemory(query: string): boolean {
    return evaluateMemorySearchNeed(query).shouldSearch;
}
