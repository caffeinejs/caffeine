---
name: plan-change
description: 'Plan a change to the caffeinejs monorepo before writing code: a feature, a fix, a refactor, a new module, option, method or API. Use at the start of every standard change, as AGENTS.md sizes it; a small change does not load it. Builds the plan from the code and AGENTS.md, CONVENTIONS.md and FEATURES.md, never from the human-facing docs; names the files and their tests, the existing code reused and the skills to load; and makes it implementation-ready, refined by EGM reviewers when the plugin is installed.'
---

# Plan a change

Use before the first edit of a standard change (`AGENTS.md` § Size the change). A small change states its plan in chat
and does not load this skill.

The rules live in `AGENTS.md`, `CONVENTIONS.md` and `FEATURES.md`. This skill copies none of them: it makes you open
the right ones and put their words where you decide.

## Sources

- **Design from the code**: exports, callers, tests, types, lint config. Rules come from the three root files above.
- **Never from the docs the project delivers**: `docs/`, `<package>/docs/**`, every `README.md` but
  `.agents/skills/README.md`, and everything under `ai/`. `ai/` is written for agents, but it ships to applications,
  so it counts as delivered docs too. They describe the code as it once was and may be stale. Do not take a design
  decision, an API shape or a constraint from them, even where a root rule file links to one.
- Read them only to find what the change makes wrong, or to edit one the change itself updates. Each page the change
  makes wrong becomes a step under `## Docs to update`.
- Write no path in the plan as a Markdown link: `/egm:egm-review` hands every linked file in the working tree to its
  reviewers as reading.

## What a plan holds

A plan is done when it holds each item below that applies to the change. They are the plan's success criteria, not a
script to recite.

1. **Restate the request** in the user's words. List what it leaves open; do not fill the gaps with requirements of
   your own.
2. **Read before you design.** Read the exports, immediate callers and shared utilities of the code you will touch. List
   the existing types, kits, helpers and patterns the change reuses. A new type, context object or helper states why
   none of them fits (Working rules: Reuse first).
3. **Name the files.** Every file the change creates, edits or deletes, marked `Create`, `Modify` or `Delete`, and the
   test file of each. `CONVENTIONS.md` § Module layout and § Tests decide where each goes; quote them in step 4.
4. **Quote the rules.** For each kind of file in step 3, open the section the `AGENTS.md` Rule map names, and quote the
   lines that decide it. Quote; do not paraphrase.
5. **Load the skills** the `AGENTS.md` Skills table selects for this work, before designing. Write down which, and what
   each changed in the plan.
6. **Ask only what is left.** Ask only what the code and the rule files cannot answer. Each option states a choice,
   never a requirement the user did not give; recommend one (Working rules: Look, then ask).
7. **Cut what serves nothing.** Tie every field, branch, option and file to a requirement from step 1, and remove the
   rest (Working rules: Minimum change).
8. **Make it implementation-ready.** A less capable model must be able to carry out the plan without taking a single
   design decision: ordered steps, exact paths, every new or changed signature written out, each test named with what
   it asserts, and the verification commands. Anything still to decide goes back to step 6.
9. **Refine with EGM** (below) when the change touches more than one file besides its tests, or a public API.
10. **Brief your helpers.** `AGENTS.md` § Use the cheapest thing that gets it right says which steps a cheaper model
    may carry out and what a brief holds. The rule sections a brief names are the ones from step 4.
11. **Plan the review.** After implementing, run `review-change` (`AGENTS.md` § Size the change) and the checks
    `CONVENTIONS.md` § Checks names for the scope of the change.

## Refine with EGM

The EGM plugin (Elephant-Goldfish Model) reviews a written plan with sub-agents that have none of your context. It is
installed per user, so check for its agents (`egm:egm-implementation-readiness`, …) before relying on it.

1. Write the plan to a file outside the working tree, such as your tool's plan or scratchpad directory, so it never
   lands in the diff.
2. Start these Goldfish reviewers on it in parallel, in fresh contexts:
   - always `egm:egm-implementation-readiness` (can another model build it as written?) and `egm:egm-codebase-details`
     (do its claims match the code?);
   - also, for a new public API, option, module or package, `egm:egm-zoom-out` (is it the simplest design, does it
     reuse what exists?) and `egm:egm-design` (does the architecture hold?). Point these two at `## Context`,
     `## Reuse` and `## Files and tests` only: they judge the design, and `egm:egm-zoom-out` flags the code-level
     detail `## Steps` must hold.

   They know nothing of this repository. Brief each with:
   - `Mode: REVIEW` and the plan's absolute path;
   - the Target Standard, with the absolute path of this file: for `egm:egm-implementation-readiness` and
     `egm:egm-codebase-details`, step 8 under § What a plan holds and § Plan template; for `egm:egm-design`, steps 2,
     3 and 7 under § What a plan holds; `egm:egm-zoom-out` uses its own standard;
   - "Read the root `AGENTS.md` (give its absolute path) and the rule sections the plan quotes. Check every claim
     against the code. Never use `docs/`, `<package>/docs/**`, a `README.md` or `ai/` as evidence: they may be stale."
3. Fix the plan for each finding, or tell the user why you reject it.
4. Repeat until a round reports no Blocker or Major finding. After two rounds that still do, stop and ask (Working
   rules: Two attempts).

The EGM skills can be started only by the user. When the design itself is still open, recommend
`/egm:egm-brainstorm`, then `/egm:egm-draft` and `/egm:egm-review`, before writing the plan:

- They save files such as `concepts_brief.md` and `design_draft.md`, and offer `docs/designs/`. Save them outside the
  working tree instead, never under `docs/`.
- When one asks for its `GoldfishContext` reading list, propose code paths and the three root rule files only.

When the plugin is not installed and step 9 applies, the plan must still meet step 8: say in it that the EGM review
was skipped (Working rules: Report what is true).

## Plan template

```md
## Context

## Reuse

## Files and tests

## Rules

## Skills

## Steps

## Docs to update

## Verification
```

## Example

The request: "Add a startup banner, configurable with `.banner()`: `false`, a string, or a function taking the usual
context object."

Wrong: the context object taken from a docs page, the tests in `application.test.ts`, the public types in a private
`_banner.ts`, a new `BannerContext`, no skill loaded, a step that says "add the option". Right:

- **Reuse:** `BootstrapKit`, the kit a callback gets once the container has initialized, is "the usual context object"
  for a function `run()` calls, read from `application.ts`. No new context type.
- **Files and tests:** `application/banner.ts` holds everything: `Banner`, the default art, printing.
  `application/banner.test.ts` holds every banner test, booting an application where it must.
  `application/application.ts` gains `.banner()` and one call.
- **Rules:**
  - CONVENTIONS § Tests: "A test of one module sits beside it, named after it, even when it boots a container, an
    application or a server to observe that module";
  - CONVENTIONS § Module layout: "One capability's code and public types live in one module, and other modules call
    into it rather than hold parts of it";
  - FEATURES: "A start-up callback added to an application, a feature or a plugin takes the kit of the phase it runs
    in" and "Output that only decorates start-up, such as a banner or a report, never fails it".
- **Skills:**
  - `sharp-edges`: a new public option with a default, the banner printed to stdout by default;
  - `typescript-magician`: the `Banner<C>` union;
  - `node`: `createRequire`, `process`.
- **Steps:** each names the file and the signature, such as
  `banner(banner: Banner<C>): this` on the application builder, and each test with its assertion, such as
  "`.banner(false)` prints nothing: stdout stays empty after `run()`".
- **Docs to update:** none: `git grep -n 'banner' -- '*.md'` finds no page the change makes wrong.
