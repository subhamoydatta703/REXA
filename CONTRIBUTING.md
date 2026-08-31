# Contributing to REXA

Thanks for taking the time to contribute! REXA is a single-developer, experimental harness, so every bit of help counts — issues, docs, tests, and code are all welcome.

## Code of Conduct

This project is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to follow it.

## Getting started

Prerequisites:

- [Bun](https://bun.sh) 1.1+
- [Docker](https://www.docker.com/get-started) for the sandbox
- A Gemini API key only if you run a live agent session

Setup:

```bash
git clone https://github.com/subhamoydatta703/REXA.git
cd REXA
bun install
bun x tsc --noEmit -p tsconfig.json
```

## Finding something to work on

- Browse [open issues](https://github.com/subhamoydatta703/REXA/issues).
- Labels like `good first issue` are beginner-friendly — feel free to add them to your issues.
- Docs, tests, and example prompts are just as valuable as new features.

## Making changes

1. Create a branch: `git checkout -b feat/your-change`
2. Make focused changes with clear conventional-commit messages, e.g. `fix: ...`, `feat: ...`, `docs: ...`, `refactor: ...`.
3. Run the type checker: `bun x tsc --noEmit -p tsconfig.json`
4. Smoke-test the CLI: `bun run src/index.ts --help`
5. Open a pull request using the [PR template](./.github/PULL_REQUEST_TEMPLATE.md).

## Security issues

REXA has a deliberate security model (guardrails, secret scanning, Docker sandboxing, git approval). If you believe you found a security bypass — a credential leak, a guardrail escape, or a sandbox escape — **do not paste secrets or exploit details in a public issue**. Open an issue marked `security` with minimal information, or email the maintainer privately via their GitHub profile.

## Commit style

The project uses [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat: <summary>
fix: <summary>
chore: <summary>
docs: <summary>
refactor: <summary>
test: <summary>
ci: <summary>
```

## Questions

Open an issue and search for duplicates before posting. Please mention which OS, Bun version, and REXA version you are using.

Thank you for helping make REXA safer, faster, and more useful!