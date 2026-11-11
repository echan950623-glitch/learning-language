# Claude cloud handoff

Date: 2026-11-11.

Use main after the handoff synchronization. It includes production commit 06c61f6196003c7fa97ec18cb4c38de440570e70 (November sync recovery and loading performance) plus the October 15 requirements missing from Git: typed Japanese production/usage, local-session logout, and removal of three home descriptions. PWA shell v37. Do not reset to old main 3864e08.

## Setup

Node.js 24 (.nvmrc), npm ci, npm run dev. Configure the public Supabase URL and publishable key from .env.example in Claude workspace settings for login/sync. Vercel variables are not automatically copied into a Claude workspace. Keep private credentials in workspace secrets or ignored .env.local; never commit credentials or account backups.

## Checks

npm run lint; npm run typecheck; npm test; npm run build. Real external tests are opt-in and skipped without credentials. See README.md for the handoff check result; never count skipped tests as passed.

## Preserve

Japanese recognition may use choices; production and usage require typed answers. A choice response for production is assisted and cannot advance independent recall. English meaning practice retains choice grading. Preserve original attempts and per-ability schedules.

November sync fixes keep local study responsive during ordinary network waits, recover question-position conflicts, and avoid redundant full snapshots. Keep these when editing repository or study code. Never discard outbox operations to hide sync conflicts. Logout uses local scope and does not clear learning data.

Production: https://learning-language-three.vercel.app/ . No new database migration is needed for this handoff. Existing remote migration timestamps may differ from local filenames: reconcile SQL and names before applying. Git pushes may trigger Vercel deployment. Do not manufacture real-user answers or copy progress to another account. Shared custom vocabulary is not implemented.

UI is practical and concise. No pronunciation/audio feature requested. More context variants, maintenance reviews and lapse-policy changes remain proposals, not completed features.
