# Contributing to Stacks · TravelOperator

Quick reference for human teammates. AI agents see [`AGENTS.md`](./AGENTS.md) for their version.

## Getting set up

```bash
git clone https://github.com/SkyYield-LLC/TravelOperator.git
cd traveloperator
npm install
cp .env.example .env.local
# fill in values from `vercel env pull` (for Vercel-deployed projects) or 1Password
npm run dev
```

## Branch strategy

- `main` → production (auto-deploys to https://traveloperator.vercel.app)
- `staging` → staging environment (if applicable)
- Feature branches → `feat/short-description`
- Bug branches → `fix/short-description`
- Never push directly to `main` — open a PR

## Commit conventions

Conventional commits, lowercase subject:

```
feat: add quote approval webhook
fix: correct pipeline_stage column mapping
chore: bump dependencies
docs: clarify staging deploy steps
refactor: split user-service into role + permission modules
test: cover commission edge cases
```

**Important:** sign commits with `smc92589@gmail.com` — Vercel blocks deploys from unrecognized committers.

## Pull requests

- One PR = one logical change. Don't bundle unrelated work.
- PR title format: `SKY-NNN type: subject` (Linear ticket prefix included)
- PR description: link the Linear issue, summarize scope, list what was tested
- Request review before merge. CI must be green.
- Squash-merge by default to keep history clean.

## Local development

_(add port, common gotchas, hot-reload notes)_

## Testing

```bash
# (no test script defined)
```

_(add notes about coverage, fixtures, mocking conventions)_

## Deployment

Push to `main` → Vercel auto-deploys to https://traveloperator.vercel.app.

## Where to ask for help

- **Linear:** [Stacks · TravelOperator](https://linear.app/skyyield/project/stacks-traveloperator-2b830e9aa130) — file an issue or comment on existing
- **Owner:** Stosh Cohen ([smc92589@gmail.com](mailto:smc92589@gmail.com))
- **Live session state:** [`handoff.md`](./handoff.md)
