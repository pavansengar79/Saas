# HRMS backend setup

## Prerequisites

Node.js 20.19+ or 22+ (verify with the lockfile and deployment runtime), npm, and a reachable MongoDB instance. Clone the backend from `https://github.com/prakharChaudhary-beno/Saas.git` on the agreed release branch. The `package.json` repository field points to another URL and must be reconciled by the owner.

```sh
git clone https://github.com/prakharChaudhary-beno/Saas.git hrms-backend
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