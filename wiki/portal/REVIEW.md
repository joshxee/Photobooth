# Review checklist

The reviewer is **not** the agent that wrote the code. Use a fresh context (a
`cavecrew-reviewer` subagent or a new session). Be sceptical: verify each claim by reading the
diff or running the command, and don't trust the PR description. Report findings as
`blocker`, `should-fix` or `nit`, with a file and line for each.

Give the reviewer: this file, the session file, the PR diff (`git diff main...HEAD`), and
DESIGN.md sections the session lists.

## 1. Scope
- [ ] Every item under the session's *Done when* is met, with evidence (test name, command
      output or screenshot).
- [ ] Nothing from *Out of scope* was built. No speculative abstractions, flags or
      "for later" code.
- [ ] New dependencies are only those in DESIGN.md §5 or the session file, or have a
      justification.

## 2. Correctness against DESIGN.md
- [ ] Behaviour matches the cited DESIGN sections. Any deviation is reflected in DESIGN.md
      with a reason.
- [ ] Error codes and response shapes match `apps/portal/contract/fixtures/`. Fixtures are
      updated if the contract changed, and both zod and serde tests still load them.
- [ ] Idempotency and retry behaviour holds (re-run the request, a duplicate, a concurrent
      duplicate).

## 3. Security (portal sessions)
- [ ] Every new route has explicit authentication. An unknown host or a missing credential
      returns 404 or 401, never data.
- [ ] Guest and admin queries scope by event. There is a test that tries another event's ID.
- [ ] No secret, token, cookie, signed-URL query or request body is logged. Grep the diff for
      `console.` and `log(`.
- [ ] Input validation uses zod with unknown fields rejected and size caps. SQL uses bound
      parameters only.
- [ ] Security headers and CSP are unchanged, or tightened.

## 4. Booth sessions
- [ ] Photos are written only to the outbox and deleted on READY. Test-mode and
      cancelled-session shots are never queued.
- [ ] New commands are least-privilege in capabilities (`default.json` vs `dev.json`).
- [ ] Device check level met: automated evidence attached, or the critical once-over is
      requested in PROGRESS.md.

## 5. Tests
- [ ] Tests were written first or alongside the code, and fail if the behaviour is removed.
      Spot-check one by reverting a line mentally or actually.
- [ ] No `.skip`, `only`, `allow(...)` or `@ts-ignore` was added. No sleeps standing in for
      synchronisation.
- [ ] Anything not exercised on real Cloudflare or the real tablet is labelled as such.

## 6. Hand-off
- [ ] The PROGRESS.md entry is accurate and the next session could start from it alone.
- [ ] The listed wiki pages are updated with the *why* (trade-offs, limitations), not a copy of
      the code.

