# Deploying to Azure via GitHub (step by step)

This hosts the tool on **Azure App Service** and sets up **GitHub Actions** so every
push to your `main` branch automatically redeploys. Follow the parts in order.

Estimated time: ~30 minutes the first time.

---

## What you'll need

- An **Azure** account with permission to create an App Service
  (a free trial or your company subscription works).
- A **GitHub** account.
- **Git** installed locally — check with `git --version` in PowerShell. If it's
  missing, install from <https://git-scm.com/download/win>.
- This project folder (the one containing `server.js`).

> **Security reminder:** your Plex credential lives only in `.env`, which is
> git-ignored, so it will **not** be pushed to GitHub. You'll set it directly in
> Azure in Part 3. Don't paste the token into any file you commit.

---

## Part 1 — Put the code on GitHub

Open **PowerShell** in the project folder and run these once:

```powershell
# Make sure you're in the project folder
cd "C:\Users\cchen\OneDrive - Vintechplastics\Caitlyn\Vintech Weekly Reporting 2026\Inventory"

git init
git add .
git status            # CONFIRM: .env should NOT appear in this list
git commit -m "Initial commit: Vintech inventory web tool"
```

> ⚠ Before continuing, double-check the `git status` output above does **not**
> list `.env`. If it does, stop — the `.gitignore` isn't being picked up. (It
> should be; `.env` is on line 2.)

Now create the GitHub repository and push. Two options:

**Option A — using the GitHub website (no extra tools):**

1. Go to <https://github.com/new>.
2. Name it e.g. `vintech-inventory-tool`. Set it to **Private** (recommended —
   it's an internal tool). Do **not** add a README/.gitignore (you already have
   them). Click **Create repository**.
3. GitHub shows a "push an existing repository" snippet. Run it in PowerShell:

   ```powershell
   git remote add origin https://github.com/<your-username>/vintech-inventory-tool.git
   git branch -M main
   git push -u origin main
   ```

**Option B — using the GitHub CLI** (if you have `gh` installed):

```powershell
gh repo create vintech-inventory-tool --private --source=. --remote=origin --push
```

Refresh the repo page — you should see your files, and **no `.env`**.

---

## Part 2 — Create the Azure Web App

1. Sign in to the **Azure Portal**: <https://portal.azure.com>.
2. Click **Create a resource** → search **Web App** → **Create**.
3. Fill in the **Basics** tab:

   | Field | Value |
   | --- | --- |
   | **Subscription** | your subscription |
   | **Resource Group** | create one, e.g. `rg-vintech-inventory` |
   | **Name** | a globally-unique name, e.g. `vintech-inventory` — this becomes your URL `https://vintech-inventory.azurewebsites.net` |
   | **Publish** | **Code** |
   | **Runtime stack** | **Node 20 LTS** |
   | **Operating System** | **Linux** |
   | **Region** | closest to your users (e.g. Central US / East US) |
   | **Pricing plan** | **Basic B1** is plenty for an internal tool (you can start with Free F1 to test, but B1 avoids the Free tier's daily quota) |

4. Click **Review + create** → **Create**. Wait for "Deployment complete", then
   **Go to resource**.

---

## Part 3 — Set your environment variables (the credential)

This is where the Plex credential goes — in Azure, never in the repo.

1. In your App Service, left menu → **Settings → Environment variables**
   (on older portals: **Configuration → Application settings**).
2. Under **App settings**, click **+ Add** for each of these:

   | Name | Value |
   | --- | --- |
   | `PLEX_AUTH` | the Base64 token (the part after `Basic ` in your Power Query) |
   | `PLEX_HOST` | `https://Vintech.on.plex.com` |
   | `PLEX_DATASOURCE_ID` | `18777` |
   | `COMPANY_UTC_OFFSET` | `-5` |

3. Click **Apply** (and confirm the restart). Do **not** add `PORT` — Azure sets
   it automatically.

> The app is built to **refuse to start** if `PLEX_AUTH` is missing, so if you
> forget this step the deploy will fail loudly (visible in the log stream) rather
> than serving broken pages.

---

## Part 4 — Connect GitHub → Azure (automatic deploys)

1. In your App Service, left menu → **Deployment → Deployment Center**.
2. **Source:** choose **GitHub**. Click **Authorize** and sign in to GitHub if
   prompted (grant access to the repo).
3. Select:
   - **Organization:** your GitHub username/org
   - **Repository:** `vintech-inventory-tool`
   - **Branch:** `main`
4. **Build provider:** **GitHub Actions**. Azure shows a preview of the workflow
   file it will add. Leave the defaults (it detects Node automatically).
5. Click **Save**.

What this does: Azure commits a workflow file to your repo under
`.github/workflows/` and kicks off the **first deployment** immediately. From now
on, **every `git push` to `main` redeploys automatically**.

> Since Azure added a file to GitHub, pull it locally so your copy stays in sync:
> ```powershell
> git pull
> ```

---

## Part 5 — Watch the first deploy

Pick either view:

- **GitHub:** your repo → **Actions** tab → click the running workflow. The build
  step runs `npm install`; the deploy step ships it to Azure. Green check = done
  (usually 2–4 minutes).
- **Azure:** Deployment Center → **Logs** tab.

---

## Part 6 — Open and verify

1. Browse to `https://<your-app-name>.azurewebsites.net`
   (also shown on the App Service **Overview** page).
2. Quick checks:
   - `https://<app>.azurewebsites.net/health` → should show `{"ok":true}`
   - The **Part detail** page loads a chart for `65-%`.
   - The **Receipts vs. demand** page: the **first** run warms the cache and takes
     **~5 minutes** (you'll see the progress bar). After that it's fast. To
     pre-warm it yourself so no colleague waits, just open that page once.

If you see "Application Error", jump to **Troubleshooting** below.

---

## Part 7 — Lock it down (important)

It's an internal tool holding a live Plex credential, so don't leave it open to the
public internet. In the App Service:

- **Easiest:** **Settings → Authentication → Add identity provider → Microsoft**
  (Entra ID). This forces a company login before anyone can view the site.
- **Or** **Settings → Networking → Access restrictions** to limit it to your
  office IP range / VPN.

---

## Part 8 — Day-to-day updates

To ship a change later, just commit and push — GitHub Actions does the rest:

```powershell
git add .
git commit -m "describe your change"
git push
```

Watch it land in the repo's **Actions** tab.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **"Application Error" page** | App Service → **Log stream** (under Monitoring). If you see `✖ PLEX_AUTH is not set`, you missed Part 3 — add the app settings and restart. |
| **Build fails in GitHub Actions** | Open the failed run in the **Actions** tab and read the red step. Usually a Node version mismatch — confirm the App Service runtime is **Node 20 LTS** (Part 2). |
| **Pages load but charts error** | Check the credential is correct/active in Plex, and that `PLEX_HOST` / `PLEX_DATASOURCE_ID` match your Power Query. The error text from Plex is shown on the page. |
| **Variability page is slow the first time** | Expected — it's warming the cache (~5 min, one time / after each restart). Subsequent runs are fast. |
| **Don't set `PORT`** | Azure injects it; the app reads `process.env.PORT` automatically. Setting it manually can break startup. |

---

## Appendix — Manual workflow (alternative to Part 4)

If you'd rather not use Deployment Center, you can add the workflow yourself and
authenticate with a **publish profile**:

1. Azure App Service → **Overview** → **Download publish profile**.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository
   secret**. Name it `AZURE_WEBAPP_PUBLISH_PROFILE`, paste the file's contents.
3. Add this file to your repo as `.github/workflows/azure-deploy.yml` (replace
   `<your-app-name>`), then `git push`:

```yaml
name: Deploy to Azure App Service

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "20.x"

      - name: Install dependencies
        run: npm ci --omit=dev

      - name: Deploy to Azure Web App
        uses: azure/webapps-deploy@v3
        with:
          app-name: "<your-app-name>"
          publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
          package: .
```

This does the same thing as Deployment Center: build on push, then deploy.
