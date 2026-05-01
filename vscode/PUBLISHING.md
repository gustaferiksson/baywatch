# Publishing the Baywatch VS Code extension

## TL;DR (after first-time setup)

```bash
cd vscode
npm version patch     # bumps version, creates commit + tag
git push --tags       # let CI publish (when wired up); or vsce publish manually
```

## First-time setup

### 1. VS Code Marketplace publisher

If you don't already have a publisher account from `multi-repo-workspace-explorer`:

- Visit https://marketplace.visualstudio.com/manage
- Sign in with your Microsoft / Azure account
- Create publisher with id `gustaferiksson` (already used; should still resolve)

### 2. Personal Access Token (PAT)

If you already have a marketplace PAT from publishing other extensions, you can reuse it. Otherwise:

- https://dev.azure.com/_usersSettings/tokens
- New Token → All accessible organizations → Custom scopes → Marketplace: Acquire + Manage
- Copy the token immediately

### 3. Install vsce

```bash
bun add -g @vscode/vsce
# or: npm install -g @vscode/vsce
```

### 4. Login

```bash
vsce login gustaferiksson
# paste PAT
```

## Publishing (manual)

### 1. Test locally

```bash
cd vscode
bun install
bun run build
# then in VS Code: F5 to launch the Extension Development Host
```

### 2. Bump version

```bash
npm version patch    # 0.0.1 → 0.0.2
# or `npm version minor` / `npm version major`
```

This creates a commit and a tag.

### 3. Build + publish

```bash
bun run package   # produces baywatch-vscode-<version>.vsix
bun run publish   # uploads to the marketplace
```

### 4. Push the tag

```bash
git push origin main --tags
```

## Publishing (CI, future)

Like `multi-repo-workspace-explorer`, this can be wired to a `publish` GitHub Action that triggers on tag push and runs `vsce publish` with a stored `VSCE_PAT` secret. Not done yet for baywatch — manual is fine for now.

## What gets published

Files included in the `.vsix` per `.vscodeignore`:

- `dist/extension.js` and source maps
- `package.json`
- `README.md`
- `LICENSE`

Excluded: `src/`, `node_modules/`, `tsconfig.json`, anything else.
