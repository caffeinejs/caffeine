# @caffeinejs/static-cli

Install the build tool with `npm install -D @caffeinejs/static-cli`. After the final writer of your frontend build
finishes, create the manifest and compressed variants in its output directory.

```sh
npx caffeine-static build --root web/dist
```

To check the copy you intend to deploy, point the verifier at the staged directory.

```sh
npx caffeine-static verify --root release
```

Both commands print file and variant counts. Build reports uncompressed file bytes. Verify reports the stored
bytes checked, including variants, and checks that each variant decompresses to the identity. Exit status is
0 on success, 1 for a build or verification failure, and 2 for invalid arguments.
