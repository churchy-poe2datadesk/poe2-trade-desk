# PoE2 Trade Desk (public tools)

Currency exchange calculator and trade ledger, hosted as a static site, fed by an hourly GitHub Actions capture.

- `scripts/capture.js`: economy-only poe.ninja capture (supported economy overview endpoints, ETags, descriptive User-Agent). Writes `market.json`, `history.json`, `state.json`.
- `.github/workflows/capture.yml`: runs hourly, publishes the files to the `data` branch (one rewritten commit, so the repo never grows).
- `site/`: the static website (deploy this folder to Cloudflare Pages).
- `scripts/sync-tools.js`: re-copies the tools from the Data Desk app into `site/` (run it after improving the tools there).

## Setup
1. Create a **public** GitHub repository and upload this folder's contents (including the hidden `.github` folder).
2. Repository **Settings > Actions > General > Workflow permissions**: choose **Read and write permissions**, save.
3. **Actions** tab > **Capture poe.ninja economy** > **Run workflow**. When it finishes, a `data` branch exists.
4. **Settings > Pages**: Source **Deploy from a branch**, branch `data`, folder `/ (root)`, save.
   The data file is then at `https://<username>.github.io/<repository>/market.json`.
5. Edit `site/config.js` and put that address in `MARKET_URL`. Commit.
6. **Cloudflare > Workers & Pages > Create > Pages > Connect to Git**: pick the repository, no build command, output directory `site`.

## Notes
- GitHub may pause scheduled workflows on repositories with no activity for 60 days; re-enable on the Actions tab if you get the email.
- Scheduled runs can start 10-30 minutes late at busy times.
- Not affiliated with or endorsed by poe.ninja or Grinding Gear Games. Prices are estimates only.
