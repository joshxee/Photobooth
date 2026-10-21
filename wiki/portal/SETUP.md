# One-time setup (human)

You do these steps by hand; they are one-off and not worth scripting. Each step says which
session needs it. Record values that aren't secret (account ID, Access AUD tags, team domain)
in `apps/portal/wrangler.jsonc` once session 02 exists. Secrets go **only** into
`wrangler secret put` or GitHub environment secrets, never into the repo, which is public.

## A. Spike on the personal account (before session 01) — done 2026-10-22

- [x] `bunx wrangler login` with the personal account on the machine that runs the spike.
- [x] Enable R2 in the dashboard (it asks for a payment method; usage stayed free). Workers
      Paid was **not** needed: the spike ran on Workers Free, and D14 removed the Images
      binding.
- [x] Copy sample JPEGs into `wiki/portal/spike/fixtures/` (git-ignored). The ones supplied
      were Canon files, not Sony; the real Sony size is measured in session 08b.
- [x] After the spike: delete its Worker and bucket (done; RESULTS.md, Clean-up).

## B. Business Cloudflare account (before session 07)

- [ ] Create an account with a business email address. Enable 2FA.
- [ ] Enable R2 (dashboard; it asks for a payment method). Stay on **Workers Free**: no Workers
      Paid and no Images subscription (D14, DESIGN §16). Session 18 tells you if the pilot's
      peak means production should move to Workers Paid (USD 5 a month).
- [ ] Invite the second admin as a member (Administrator role) with their own login.
- [ ] Billing notifications at USD 25, 50 and 100.

## C. Domain (before session 07; at least a week before the pilot)

- [ ] Register the `.co.nz` with an InternetNZ-authorised registrar, with registrar lock and
      auto-renew on.
- [ ] Add the domain to the business account (Free zone plan) and switch the nameservers at the
      registrar.
- [ ] Add one WAF rate-limiting rule (included in the Free zone plan) for `photos.<domain>`
      and `photos-staging.<domain>`, so a request flood can't use up the Workers Free daily
      limit (DESIGN §13). Session 17 checks it.
- [ ] Enable DNSSEC in Cloudflare and add the DS record at the registrar.
- [ ] Email Routing (free): forward `privacy@<domain>` to a monitored inbox. This is the
      gallery's removal contact.

## D. Zero Trust and Access (before session 07)

- [ ] Choose a Zero Trust team name. Free plan, up to 50 users.
- [ ] Add a one-time PIN or Google login method.
- [ ] Create an Access app for `admin-staging.<domain>`, with a policy allowing the two admin
      emails and an 8-hour session. Record the **AUD tag**.
- [ ] Create an Access app for `admin.<domain>`, with the same policy and its own AUD tag.
- [ ] Create a **service token** `agent-staging`. Add a *Service Auth* policy to the
      **staging** app only. Store the client ID and secret in your password manager and in the
      agent's local environment (`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`). Never
      commit them.

## E. Tokens and GitHub (before session 07)

- [ ] API token `ci-deploy`, limited to this account and zone: Workers Scripts edit, Workers
      Routes edit, D1 edit, R2 edit, Account Settings read.
- [ ] GitHub → Settings → Environments:
  - `staging`: secret `CLOUDFLARE_API_TOKEN` = `ci-deploy`, plus `CLOUDFLARE_ACCOUNT_ID`.
  - `production`: the same secrets, plus **required reviewer = you**.
- [ ] API token `agent-readonly` for the agent's machine (local env `CLOUDFLARE_API_TOKEN`):
      Workers Observability read, D1 read, R2 read, Workers Scripts read.
- [ ] Generate secrets for staging with
      `bunx wrangler secret put UPLOAD_KEY --env staging` and the same for `SESSION_KEY`, using
      32 random bytes each in base64. Session 07 prompts you when it needs them.

## F. Production (before session 18)

- [ ] Create the production D1 and R2 resources with the commands session 07 prints. You run
      them, not the agent.
- [ ] Set the production secrets (`UPLOAD_KEY`, `SESSION_KEY`, unique values, never reused
      from staging).
- [ ] Set `CONTACT_EMAIL` and confirm `CONTACT_ADDRESS` (34b Malvern Road, Morningside,
      Auckland).
- [ ] Privacy notice text reviewed against the NZ Privacy Act (the business's responsibility).

