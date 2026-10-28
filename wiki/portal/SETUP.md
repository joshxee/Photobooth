# One-time setup (human)

You do these steps by hand; they are one-off and not worth scripting. Each step says which
session needs it. Values that aren't secret (team domain, Access AUD tags, the service-token
client ID) go into `apps/portal/wrangler.jsonc` in session 07; until then they are in
PROGRESS.md (SETUP entry). The account ID is not in the repo (`wrangler.jsonc` never has an
`account_id`); it is the GitHub secret `CLOUDFLARE_ACCOUNT_ID`. Secrets go **only** into
`wrangler secret put` or GitHub environment secrets, never into the repo, which is public.

## A. Spike on the personal account (before session 01) — done 2026-10-22

- [x] `bunx wrangler login` with the personal account on the machine that runs the spike.
- [x] Enable R2 in the dashboard (it asks for a payment method; usage stayed free). Workers
      Paid was **not** needed: the spike ran on Workers Free, and D14 removed the Images
      binding.
- [x] Copy sample JPEGs into `wiki/portal/spike/fixtures/` (git-ignored). The ones supplied
      were Canon files, not Sony; the real Sony size is measured in session 08b.
- [x] After the spike: delete its Worker and bucket (done; RESULTS.md, Clean-up).

## B. Business Cloudflare account (before session 07) — done 2026-10-23

- [x] Create an account with a business email address (`josh@knockbox.nz`). Enable 2FA and
      save the recovery codes. That email depends on the domain's DNS, so keep a second way in
      (the Gmail member below).
- [x] Enable R2 (dashboard; it asks for a payment method). Stay on **Workers Free**: no Workers
      Paid and no Images subscription (D14, DESIGN §16). Session 18 tells you if the pilot's
      peak means the account should move to Workers Paid (USD 5 a month).
- [x] Second admin: the owner's own Gmail is a Super admin member with 2FA (**Manage Account →
      Members → Invite**). It is a break-glass login that does not depend on `knockbox.nz` DNS.
      There is no second person; if one joins, invite them as Administrator.
- [x] Budget alerts (**Manage Account → Billing → Billable Usage → Set Budget Alert**):
      Cloudflare's default USD 10 plus USD 20, the monthly budget. They watch usage-based spend
      only; on Workers Free nothing should bill.

## C. Domain (before session 07; at least a week before the pilot)

The order that works when the domain must exist before the business account (the account's
login email lives on the domain):

- [x] Register `knockbox.nz` with Cloudflare Registrar (it sells `.nz`), auto-renew on.
      Registered 2026-10-21 in the **personal** account, then the business email (Hostinger)
      was set up in its DNS.
- [x] Add the zone to the business account: **Domains → Onboard a domain → Connect a domain**,
      Free plan, "Manually enter DNS records". It stays **Pending** until the move. Ignore the
      "update your nameservers" screen: Registrar domains change nameservers by themselves.
      - Export the personal zone first (**DNS → Records → Import and Export → Export**) and
        import a cleaned copy without SOA, NS or the website record.
      - The onboarding scan adds records anyway. Delete proxied A/AAAA records that point at
        Cloudflare's own edge IPs (they would give error 1000) and the old zone's
        `_acme-challenge` TXT tokens.
      - Check every email record (MX, SPF, DKIM, DMARC, verification TXT) against the new
        zone's own nameservers before the move, for example
        `nslookup -type=MX knockbox.nz fay.ns.cloudflare.com`. The move copies no records, and
        whatever the new zone holds is live the moment the move completes.
- [x] DNSSEC off (the move requires it; it was never on). Check with the `.nz` whois
      (`whois.irs.net.nz`): `DNSSEC: unsigned`.
- [x] Website: a Worker serving static assets from `joshxee/knockbox-website`. A root custom
      domain needs the zone in the Worker's account, so the Worker was recreated in the business
      account (reinstall the "Cloudflare Workers and Pages" GitHub app there: a GitHub account
      should point to one Cloudflare account). The business account accepted `knockbox.nz` as a
      custom domain on the Pending zone, so it serves straight after the move. Gotcha: deleting
      the old Pages project in the personal account also deleted its root DNS record; adding the
      custom domain on the personal Worker restored the site until the move.
- [ ] **Move the registration** (from 2026-11-01, more than 10 days after registration):
      personal account → **Domain Registration → Manage Domains → knockbox.nz → Configuration**
      → move → **Start**, with the business account ID. Then business account → **Manage
      Domains → View Actions → Accept** (within 5 days). The domain is then transfer-locked for
      30 days.
- [ ] After the move: the zone is Active on `fay`/`zeus`, mail flows both ways, the website
      serves from the business Worker, and the business Worker's `workers.dev` and Preview URLs
      are off.
- [ ] Enable DNSSEC: business account **Manage Domains → knockbox.nz → Configuration → Enable
      DNSSEC** (Registrar adds the DS itself within 1–2 days).
- [ ] `privacy@knockbox.nz` forwards to a monitored inbox. This is the gallery's removal
      contact. Mail is Hostinger's, and Cloudflare Email Routing would need its own MX records,
      so check which one to use when setting it up (a Hostinger alias may be simpler).
- [ ] Add one WAF rate-limiting rule (included in the Free zone plan) for `photos.knockbox.nz`
      and `photos-staging.knockbox.nz`. It reduces the risk of a flood using up the Workers Free
      daily limit (a distributed flood can still get through; DESIGN §13, denial of wallet;
      §16). Session 17 checks it.
- Fail-closed at the daily limit is a per-route toggle (Cloudflare docs, Workers limits:
  fail open bypasses the Worker, fail closed returns error 1027). The portal uses Custom
  Domains, which have no origin to fall back to. Session 07 (interim, `workers.dev`): there are no
  routes, so there is no toggle to set; with no origin behind them, a Worker over the limit can
  only fail (error 1027). **Unverified** (not exercised: it would take the account's whole daily
  allowance). Check the toggle again when the Custom Domains exist.

## D. Zero Trust and Access (before session 07)

- [x] Zero Trust team `knockbox`, Free plan. Team domain `knockbox.cloudflareaccess.com`.
- [x] Login method: the **Cloudflare** identity provider, restricted to account members (the
      default for new teams). It uses each admin's Cloudflare login and 2FA, which is stronger
      than a one-time PIN, so there is no OTP.
- [x] Interim staging (session 07, until the move; wiki/Portal.md → "Interim staging on
      workers.dev"): a **Worker-level** Access app on `portal-staging-admin`. **Workers & Pages →
      portal-staging-admin → Access → Protect this Worker behind Access → All traffic → Apply**,
      then in **Zero Trust → Access controls → Applications** the Allow policy limited to the two
      admin emails with an 8-hour session, plus a *Service Auth* policy for `agent-staging`. Its
      AUD tag is `ACCESS_AUD` in `env.staging-admin` (not a secret). It covers the Worker's
      `workers.dev` hostname, which a hostname app couldn't without a zone.
- [ ] After the move (an Access app needs an active zone): an Access app for
      `admin-staging.knockbox.nz`, with a policy allowing the two admin emails and an 8-hour
      session. Record the **AUD tag**. Then follow the switch checklist in wiki/Portal.md and
      delete the interim Worker-level app with its Worker.
- [ ] An Access app for `admin.knockbox.nz`, with the same policy and its own AUD tag.
- [x] **Service token** `agent-staging` (**Zero Trust → Access controls → Service credentials →
      Service Tokens**), 1 year. The client ID and secret are in the password manager, this
      PC's user environment (`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) and the GitHub
      `staging` environment. Never commit them.
- [ ] After the move: a *Service Auth* policy for `agent-staging` on the **staging** app only.

## E. Tokens and GitHub (before session 07)

Both tokens are **account API tokens** (**Manage Account → Account API tokens**), not user
tokens, so they belong to the business account. Each has two policies: one on the account and
one on the zone `knockbox.nz`. The account permissions must be on the account policy: on the
zone policy they don't apply.

- [x] `ci-deploy`, 1 year. Account: Workers Scripts Write, D1 Write, Workers R2 Storage Read,
      Account Settings Read. Zone `knockbox.nz`: Workers Routes Write (to attach Custom
      Domains). R2 is Read because a deploy needs no R2 access and the smoke check only lists
      objects.
- [x] GitHub → Settings → Environments:
  - `staging`: secrets `CLOUDFLARE_API_TOKEN` (`ci-deploy`), `CLOUDFLARE_ACCOUNT_ID`,
    `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`. No reviewers and no branch rule: agents
    deploy branches here.
  - `production`: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; **required reviewer =
    joshxee**, "Allow administrators to bypass" **off** (agents use the owner's `gh` login),
    branch `main` only.
  - **Not an enforced boundary yet** (the session 07 review):
    - Both environments hold the same `ci-deploy` token, which can write production too.
    - Agents act as joshxee, so they could approve the reviewer gate themselves.
    - `main` has no branch protection.
    - Decide before session 18 (DESIGN §4.1, "Open"): a separate production account or token,
      protect `main`, and a non-owner identity for agents.
- [x] `agent-readonly`, 1 year, in this PC's environment (`CLOUDFLARE_API_TOKEN`,
      `CLOUDFLARE_ACCOUNT_ID`). Account: Workers Scripts Read, Workers Tail Read, D1 Read,
      Workers R2 Storage Read, Account Settings Read. Zone `knockbox.nz`: Workers Routes Read.
      While it is set, Wrangler on this PC uses it for everyone: before running a write command
      yourself, run `Remove-Item Env:CLOUDFLARE_API_TOKEN; npx wrangler login` in that window, and `npx wrangler logout` when done (a cached login would otherwise serve any process without the token).
      Apps started before the variables were set (the Claude app, open terminals) need a
      restart to see them.
- [x] Staging D1, R2 and secrets (done 2026-10-28): run what `bun run scripts/provision.ts --env staging` prints, in
      a new PowerShell 7 window from `apps/portal` (session 07). It removes the read-only token
      for that window, logs in, creates `portal-staging` (D1) and `portal-media-staging` (R2),
      and pipes a fresh random 32-byte value for `UPLOAD_KEY` and `SESSION_KEY` into both staging
      Workers (`--env staging` and `--env staging-admin`; this also creates them empty). It **ends
      with `npx wrangler logout`**: otherwise the write login stays cached in `~/.wrangler` and any
      process on this PC that runs Wrangler without `CLOUDFLARE_API_TOKEN` would use it, so agents
      would hold a write token after all. If `npx wrangler` does nothing (no Node on PATH), prefix
      each command with `fnm exec --using=22.11.0 --`.

## F. Production (before session 18)

- [ ] Create the production D1 and R2 resources with the commands session 07 prints. You run
      them, not the agent.
- [ ] Set the production secrets (`UPLOAD_KEY`, `SESSION_KEY`, unique values, never reused
      from staging).
- [ ] Set `CONTACT_EMAIL` and confirm `CONTACT_ADDRESS` (34b Malvern Road, Morningside,
      Auckland).
- [ ] Privacy notice text reviewed against the NZ Privacy Act (the business's responsibility).

