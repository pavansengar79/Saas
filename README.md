# HRMS backend setup

## Prerequisites

Node.js 22+ (needed for `npm test`), npm, and a reachable MongoDB instance. The one backend repository is `https://github.com/pavansengar79/Saas` (branch `main`). Old copies (`pavansengar79/HRMS-BE`, `prakharChaudhary-beno/Saas`) are retired; do not push to them.

```sh
git clone https://github.com/pavansengar79/Saas.git hrms-backend
cd hrms-backend
npm install
cp .env.example .env
# Edit .env with your own values; never commit it.
npm run seed
npm run dev
```

Run `npm run seed` on a **fresh non-production database only** after checking the target `MONGO_URI`. The seed script creates modules, plans, permissions, roles and holidays, then migrates leave-type indexes; it may modify system data and must not run on every startup. `npm start` runs the persistent Node server. `app.js` is the serverless Express entrypoint; the API is mounted under `/api/v1` and health check is `/health`. Set `MONGO_URI` (not `MONGODB_URI`, `MONGODB_URL` or `MONGO_URL`) for app and seed.

## Deployment and operations

The repository contains no verified Vercel project settings or CI/CD pipeline. Set production environment variables in the hosting provider's secret store, provision MongoDB access/CORS/OAuth callbacks, deploy the agreed commit, check `/health`, exercise a login and a representative scoped API, and verify scheduled jobs. Do not promote without a staging smoke test, a database backup, and an agreed rollback commit. `node-cron` runs only on a persistent Node process, **not reliably on Vercel**; see the scheduler plan in the handover package. Protected manual endpoints exist, but creating them does not activate production scheduling.

Standalone root `test-*.js`, `debug-*.js`, `check-*.js`, `seed-*.js` and similar files are diagnostics/admin scripts, not server startup files. Inspect their database target and side effects before running. Do not run scripts or migrations against production without backup and approval.




## Statutory references

### EPF wage ceiling — ₹25,000 from 17 Sep 2026
- **Code:** `modules/payrollPolicy/payrollRunRules.js` → `EPF_CEILING_OLD` / `EPF_CEILING_NEW`, `getStatutoryPfCeiling()`
- **Law:** Code on Social Security, 2020 — Section 2(89), Chapter III
- **Notification:** S.O. 5109(E), Gazette of India (Extraordinary), 17 Sep 2026; supersedes S.O. 2702(E), 29 May 2026 (₹15,000)
- **In force:** 17 Sep 2026 (date of publication)
- **Official confirmation:**
  - Ministry of Labour & Employment, 16 Sep 2026: https://www.labour.gov.in/static/uploads/2026/09/4f607a88c5342aeb980c6b999997caab.pdf
  - PIB, 23 Sep 2026: https://www.pib.gov.in/PressReleasePage.aspx?PRID=2313790
- **Not verified as of 12 Nov 2026:** a direct egazette.gov.in link for S.O. 5109(E), and any EPFO circular number. Add them here and in the code comment when found.
- **September 2026:** prorated by default (16 days at ₹15,000, 14 days at ₹25,000). Set `taxCompliance.pfSep2026Transition = "full"` to use ₹25,000 for the whole month. Confirm with the CA.
- **Open question for the CA:** G.S.R. 890(E), 15 Oct 2026 (EPS para 4(2), ₹15,000) is reported by one source only. The code applies employer EPS 8.33% on wages up to ₹25,000.node -e "require('./package.json'); console.log('package.json ok')"