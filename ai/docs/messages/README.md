# Error message pages

One markdown file per `code` string (`ERR_HTTP_NOT_FOUND.md`). Agents grep the code from a thrown error, then read this folder.

This slice has a single example. Add files as codes become worth documenting.

## Reading a Caffeine error

```text
Cannot serve router "admin": it is bound to "ops", and no installed server has that name
Possible Solutions:
  - Install it: ".install(Ops('ops', ...))"
  - Or bind to an installed server: "main"
```

- The first line says what failed and why. The quoted values are the application's own names: search the code for them.
- `Possible Solutions` lists fixes, most likely first. Apply the first one that matches what the application means to do. Do not catch the error to silence it.
- A message may end with `Read more:` and `See also:` links. Read them before guessing.
- Branch on `err.code` or the class (`err instanceof ErrX`), never on the message text: wording changes between releases.
