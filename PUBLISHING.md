# Publishing Claude Commit

These steps require your own Microsoft/Azure DevOps account (for the VS Code
Marketplace) and, optionally, an Open VSX account (for Cursor and other
editors that don't use the Microsoft gallery). Nobody but you can run the
actual publish step - it needs your personal access token.

## 1. Fill in the placeholders

Before publishing, replace the `CHANGEME-*` placeholders:

- `package.json` → `"publisher"`: your marketplace publisher id (see step 2).
- `package.json` → `"repository"."url"`: your repo's URL, once you push
  this to GitHub/GitLab/etc. **Required, not optional** - `vsce package`
  itself refuses to run without it, since it can't resolve the relative
  links to `PUBLISHING.md`/`CLAUDE.md`/`CHANGELOG.md` in `README.md` to
  absolute URLs otherwise.
- `LICENSE` → the copyright holder name.
- Optionally swap `icon.png` (128×128) for your own artwork - the one in
  this repo is a plain placeholder.

## 2. VS Code Marketplace

1. Create a publisher at <https://marketplace.visualstudio.com/manage> (this
   creates/uses an Azure DevOps organization behind the scenes), or via:
   ```bash
   npx vsce create-publisher <your-publisher-id>
   ```
2. Generate a Personal Access Token in Azure DevOps (User settings →
   Personal access tokens → New Token), scoped to **Marketplace → Manage**.
3. Log in with vsce:
   ```bash
   npx vsce login <your-publisher-id>
   # paste the PAT when prompted
   ```
4. Sanity-check the package locally before publishing:
   ```bash
   npm run package        # produces claude-commit-0.2.0.vsix
   ```
   Install it via VS Code's **Extensions: Install from VSIX...** command and
   click through both commands once.
5. Publish:
   ```bash
   npx vsce publish
   ```
   Subsequent releases: bump `"version"` in `package.json` (or run
   `npx vsce publish patch|minor|major`, which bumps it for you) and re-run.

## 3. Open VSX (for Cursor and other non-Microsoft-gallery editors)

The README already notes this extension works in Cursor, but Cursor's
default extension gallery is **Open VSX**, not the Microsoft Marketplace -
publishing there too means Cursor users can install it without sideloading
the `.vsix`.

1. Create an account/publisher namespace at <https://open-vsx.org>.
2. Generate an access token at
   <https://open-vsx.org/user-settings/tokens>.
3. Publish:
   ```bash
   npx ovsx publish -p <your-open-vsx-token>
   ```

## 4. After publishing

- Verify the listing renders correctly (README, icon, categories) on both
  galleries.
- Tag the release in git (`git tag v0.2.0`) so the published version has a
  matching commit to point back to.
