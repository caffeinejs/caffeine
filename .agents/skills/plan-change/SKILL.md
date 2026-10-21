---
name: plan-change
description: 'Plan a change to the caffeinejs monorepo before writing code: a feature, a fix, a refactor, a new module, option, method or API. Use at the start of every implementation task. Maps the change to AGENTS.md, CONVENTIONS.md, FEATURES.md and the package AGENTS.md, and names the files and their tests, the existing code reused and the skills to load.'
---

# Plan a change

Use before the first edit of any change to code in this repository (`AGENTS.md` Rule 13). A one-line fix needs a short
plan, not none.

The rules live in `AGENTS.md`, `CONVENTIONS.md`, `FEATURES.md` and the package `AGENTS.md`. This skill copies none of
them: it makes you open the right ones and put their words where you decide.

## What a plan holds

A plan is done when it holds each item below that applies to the change. They are the plan's success criteria, not a
script to recite.

1. **Restate the request** in the user's words. List what it leaves open; do not fill the gaps with requirements of
   your own.
2. **Read before you design.** Read the exports, immediate callers and shared utilities of the code you will touch. List
   the existing types, kits, helpers and patterns the change reuses. A new type, context object or helper states why
   none of them fits (Rule 8).
3. **Name the files.** Every file the change creates or edits, and the test file of each. `CONVENTIONS.md` § Module
   layout and § Tests decide where each goes; quote them in step 4.
4. **Quote the rules.** For each kind of file in step 3, open the section the `AGENTS.md` Rule map names, and quote the
   lines that decide it. Quote; do not paraphrase.
5. **Load the skills** the `AGENTS.md` Skills table selects for this work, before designing. Write down which, and what
   each changed in the plan.
6. **Ask only what is left.** Ask only what the code and the rule files cannot answer. Each option states a choice,
   never a requirement the user did not give; recommend one (Rule 1).
7. **Cut what serves nothing.** Tie every field, branch, option and file to a requirement from step 1, and remove the
   rest (Rule 2).
8. **Brief your helpers.** A sub-agent you start may not see these files: tell it to read `AGENTS.md` and the sections
   from step 4 first.
9. **Plan the review.** After implementing, run `review-change` (Rule 14) and the checks `CONVENTIONS.md` § After every
   edit names for the scope of the change.

## Plan template

```md
## Context

## Reuse

## Files and tests

## Rules

## Skills

## Verification
```

## Example

The request: "Add a startup banner, configurable with `.banner()`: `false`, a string, or a function taking the usual
context object."

Wrong: the tests in `application.test.ts`, the public types in a private `_banner.ts`, a new `BannerContext`, no skill
loaded. Right:

- **Reuse:** `BootstrapKit`, the kit a callback gets once the container has initialized, is "the usual context object"
  for a function `run()` calls. No new context type.
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
