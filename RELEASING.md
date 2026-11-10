# Releasing resend-broadcasts

The project isn't a git repository yet and has no GitHub remote, so that comes first. This is the order to do things in.

## 1. Install on your live site

- To try it now, run `pnpm add file:/Users/tom/Documents/GitHub/resend-broadcasts` in the site. Import it and add it to `emdash({ sandboxed: [resendBroadcasts] })`.
- A `file:` install only works on your machine, so it won't deploy from CI. For production, use the registry (step 3) or a git or tarball dependency.
- On the live site, add the Resend API key in the plugin settings. Set the From address (the domain must be verified in Resend), the site URL, and the postal address. Enable your collections, then send a test email.

## 2. Put it in git and on GitHub

- Run `git init`. `.gitignore` already excludes `node_modules` and `dist`.
- Create a GitHub repo (done: `https://github.com/tjsheppard/resend-broadcasts`). Its URL is the `repo` field in `emdash-plugin.jsonc`, which release setup reads. Automated releases need the repo to be public.
- Work on branches and open pull requests. Add a CI workflow that runs `pnpm install`, `pnpm run validate`, `pnpm run typecheck` and `pnpm run test`.

## 3. Publish to the EmDash registry

- `package.json` is `"private": true`, which is fine because publishing goes through the EmDash CLI, not npm.
- Run `pnpm run login -- shepp.dev` once. The manifest publisher is the DID that `shepp.dev` resolves to, so use that handle or the DID.
- Run `pnpm run publish`. It builds and uploads to your PDS. Check the listing with the `emdash-plugin info <handle> <slug> --version <version> --watch` command it prints.
- The manifest is MIT-licensed and labelled "Unofficial; not affiliated with Resend", which suits a public listing.

## 4. Versioning and automated releases

- `package.json` is the only version source, currently 0.3.1. Bump patch for fixes and minor for new features. You must bump it whenever capabilities, `allowedHosts` or storage change.
- For CI releases, run `pnpm run release:setup` after the repo is on GitHub. It writes `.github/workflows/emdash-release.yml`. Pick either trigger: Changesets (changelog and version PRs) or git tags.
- Before the first release, open https://releases.emdashcms.com/publisher, sign in as `shepp.dev` and select **Authorize publishing**. Without it the workflow fails with `DELEGATION_REQUIRED`.
- Tags suit a single-package plugin. Bump the version in a PR, merge it, then push a `resend-broadcasts@0.3.0` tag (`<slug>@<version>`; the workflow ignores `v0.3.0`) and the workflow publishes. The first automated release connects the repo to your publisher profile.
