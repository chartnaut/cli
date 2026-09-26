# Security

## Report a vulnerability

Email **help@chartnaut.com** with "Security" in the subject line. Do not open a public GitHub issue, pull request or discussion for a vulnerability.

## Scope

- This CLI: the code in this repository, the release binaries, the install scripts at `https://chartnaut.com/install.sh` and `https://chartnaut.com/install.ps1`, and `chartnaut upgrade`.
- The public Chartnaut API the CLI calls at `https://api.chartnaut.com/v1`, including browser sign-in and API keys.

Examples of what to report: a way to read or use another account's scripts, runs or keys; a key or credentials file exposed where it should not be; the CLI opening a link it should refuse; an install or upgrade that accepts a binary whose checksum does not match.

## What to include

- What you found and what an attacker could do with it.
- Steps to reproduce, with the CLI version (`chartnaut --version`) and your operating system.
- Any request ids the CLI printed (`request_id: …`).

Do not send a working API key, yours or anyone else's. If a key of yours was exposed while you were testing, revoke it on the [Developers page](https://terminal.chartnaut.com/morpheus/settings/developers).

## What happens next

Chartnaut is a small team. You will get a reply confirming the report was received, and a person will look at it and follow up with you about a fix. Please give Chartnaut a reasonable chance to fix the issue before you disclose it publicly.

## Testing

Test only against your own account and your own data. Do not run load or denial-of-service tests against the API, and do not access or change data that is not yours.
