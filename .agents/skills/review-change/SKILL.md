---
name: review-change
description: "Review a standard change to the caffeinejs monorepo, a change to its agent docs or skills, or any diff you are asked to review, against AGENTS.md, CONVENTIONS.md and FEATURES.md, after implementing and before reporting it done, committing or pushing. On your own diff, a sub-agent with a fresh context and any extra reviewer your Agent coordination setup names run the review, and you fix what they find; on someone else's diff, run the review yourself."
---

# Review a change

Use before handing over a standard change, or a change to an agent doc or a skill (`AGENTS.md` § Size the change), and
whenever you are asked to review a diff. It finds what the author read past: a rule broken, an existing type
duplicated, a test in another file's test file.

The author's own checks do not replace the review: an author reads the rules through their own reasons for bending
them. On your own diff, follow **Author**, which hands the review to reviewers with a fresh context. On someone else's
diff, or as one of those reviewers, follow **Reviewer**.

## Author

1. **Run the checks** `CONVENTIONS.md` § Checks names for the scope of the diff, and fix them until they
   pass.
2. **Run your tool's own review commands** where it has them, such as `/simplify` and then `/code-review` in Claude
   Code. Apply what they find, then rerun the checks. Skip them when the diff changes only tests and `*.md` files, and
   say so in the reviewers' prompt.
3. **Start the reviewers in parallel, each with a fresh context:** one reviewer sub-agent, and every extra reviewer
   your `Agent coordination` setup names (`AGENTS.md` § Agent coordination). For the sub-agent in Claude Code: the
   Agent tool with the sub-agent type your setup names for the `yours` tier, `general-purpose` when it names none,
   never `fork`, which inherits your context. Run an extra reviewer with its command, from the repository root:
   `<model>` and `<effort>` from its row, `<prompt file>` the prompt written to a file outside the working tree,
   `<report file>` a new path outside it for each reviewer and round, which you read when the command exits. Every
   reviewer gets the same prompt, which holds only:
   - the request and every decision the user made since, in the user's words;
   - the base commit, and the checks and review commands you ran or skipped, with their result;
   - "Load the `review-change` skill and follow its Reviewer part on this diff. Change no file. Report the findings."

   Never your plan's reasoning, why you chose a design, or why a rule does not apply: the reviewer judges the diff
   against the rules, not against your argument.

   An extra reviewer that cannot run (not installed, not signed in, exits with an error or without a report) leaves
   the round incomplete: stop and ask the user, with its error. So does one still running when every other reviewer
   has reported and 30 minutes have passed since you started it: ask whether to keep waiting, or to stop it, wait
   until its process has exited, and go on without it.
4. **Wait until every reviewer has reported**, or the user has told you to go on without one, before the first fix: a
   reviewer still running reads the working tree. Then **fix every finding** from every reviewer, test-first for a bug
   (`CONVENTIONS.md` § Tests), and rerun the checks. A finding several reviewers raise is fixed once; findings that
   contradict each other go to the user. A finding you reject goes to the user with your reason; never drop one
   silently.
5. **Review again**, starting every reviewer afresh, when you changed a file for a blocking or should-fix finding.
   After two rounds that still have such findings, stop and ask (Working rules: Two attempts).
6. **Report** what each reviewer found in each round, any reviewer that did not report and why, and what you fixed or
   rejected.

A tool with no sub-agents: re-read the rule files before you look at the diff, follow Reviewer yourself, and tell the
user the review ran in the author's context (Working rules: Report what is true). Start the extra reviewers before your
own Reviewer pass: they are separate tools and still run.

## Reviewer

A review is done when it has covered each item below, in order. They are the review's success criteria, not a script
to recite. Change no file.

1. **Get the diff.** Use the base commit you were given. Without one, run `git fetch origin main`: a clone's
   `origin/main` lags until it is fetched. Then run `git merge-base HEAD origin/main`. It must print a commit. In a
   shallow clone it can print nothing, and an empty base makes `git diff` show only unstaged changes; deepen the clone
   (`git fetch --deepen=200 origin main`) and retry rather than review an empty diff. Then run `git diff <base>`, and
   `git status` for files not yet tracked. List the changed files.
2. **Read the rules now:** `AGENTS.md` whole; for each changed file, the section the `AGENTS.md` Rule map names.
3. **Check the scope.** The diff does what the request asked and nothing more: no unrequested option, refactor or file.
4. **Check each file** against its sections and `AGENTS.md` § Working rules.
5. **Check the design**, which a file-by-file pass misses:
   - a new type, helper or context object where one already existed;
   - a field, branch, option or piece of state no requirement needs;
   - one capability's code spread over several modules of one layer, or a file's tests in another file's test file;
   - a public signature typed with a type from a `_` module;
   - a test that still passes with the behavior it names broken;
   - debug output, a TODO or a stray file left behind.
6. **Check the checks.** The ones `CONVENTIONS.md` § Checks names for the scope of the diff ran, and passed.
   Judge them from the results you were given, and name any that is missing. Never run `make check` or `lint:fix`
   yourself: they write files.
   When no Author started you, also run your tool's review commands that change nothing, such as `/code-review`
   without `--fix`.
7. **Report** each finding as `file:line`, the rule quoted, the fix, and a severity: blocking, should-fix or nit. Say
   "no findings" only after listing the rules you checked.
