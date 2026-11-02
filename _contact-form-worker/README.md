# fusioncam.co quote form backend

The site is a static page on GitHub Pages, so there's nothing on the server side to receive a form. This folder is a small Cloudflare Worker that does that job. The form posts to it, it checks the submission isn't spam, then it emails the answers to scott@livetools.com.au through Resend.

What each piece does:

- **Cloudflare Worker** (`src/index.js`): receives the form, runs the spam checks, sends the email. It runs on Cloudflare's free plan at a `workers.dev` address, because the fusioncam.co DNS stays at Porkbun.
- **Turnstile**: Cloudflare's spam check. Most visitors never see it. It only pops up a challenge when something looks off.
- **Resend**: sends the email from `forms@mail.fusioncam.co`. Using the `mail.` subdomain keeps it completely separate from any email on fusioncam.co itself.
- **`form-snippet.html`**: the form to paste into the page.
- **`thanks.html`** (in the site root, not this folder): where visitors land if they have JavaScript turned off.

Note: this folder lives inside the website repo. GitHub Pages skips any folder whose name starts with an underscore, so none of it gets published to fusioncam.co. Don't rename it without that underscore.

Rule number one: secrets (the Resend API key and the Turnstile secret key) NEVER go in a file that's committed. They go into Cloudflare with `wrangler secret put`, and into `.dev.vars` for local testing, which git ignores.

## 1. Set up Resend

1. Create an account at [resend.com](https://resend.com).
2. Go to **Domains** and add `mail.fusioncam.co`. If it asks for a region, pick whichever is closest to NZ.
3. Resend shows you a set of DNS records to add on its **Records** tab. Expect a few TXT records, plus either an MX record or some CNAME records, depending on how Resend sets up the account. Add every record it lists, at Porkbun under **Domain Management → fusioncam.co → DNS**.

   The key thing to understand is that Porkbun adds `.fusioncam.co` to the end of whatever you type in the **Host** box. So type only the part before it. For example:

   | Resend shows | Type into Porkbun's Host box |
   |---|---|
   | `send.mail.fusioncam.co` | `send.mail` |
   | `resend._domainkey.mail.fusioncam.co` | `resend._domainkey.mail` |

   Some screens show the name already shortened (e.g. `send.mail`). Use that as is.

   Copy the record type, value and priority (if there is one) straight from Resend. Don't retype them.

   IMPORTANT: leave every existing record alone, especially anything with a blank Host. None of the new records sit on fusioncam.co itself, so they can't affect the root domain's MX or SPF.

4. Back in Resend, click **Verify DNS Records**. It can take anywhere from a few minutes to a few hours.
5. Once it says **Verified**, go to **API Keys → Create API Key**:
   - **Permission**: Sending access
   - **Domain**: `mail.fusioncam.co`

   Copy the key (it starts with `re_`). Resend only shows it once.

## 2. Set up Turnstile

Turnstile works fine with DNS at Porkbun. You only need a free Cloudflare account.

1. Log in at [dash.cloudflare.com](https://dash.cloudflare.com) and open **Turnstile → Add widget**.
2. Name it something like `fusioncam.co quote form`.
3. Add both hostnames: `fusioncam.co` and `www.fusioncam.co`.
4. Leave **Widget Mode** on **Managed**. The snippet already tells it to stay hidden unless it needs to ask the visitor something.
5. Create it, then copy the **Site Key** (public, goes in the page) and the **Secret Key** (private, goes into the Worker).

## 3. Deploy the Worker

Run these from this folder (`C:\source\fusion-services-page\_contact-form-worker`) in a terminal.

```sh
npm install
npx wrangler login
```

`wrangler login` opens a browser to approve access to your Cloudflare account, then hands control back to the terminal.

Tip: if you ever run this from WSL2 instead of Windows and the login page can't call back to the terminal, skip the browser login. Create an API token in the Cloudflare dashboard under **My Profile → API Tokens** using the **Edit Cloudflare Workers** template, then run `export CLOUDFLARE_API_TOKEN=<token>` before the commands below.

Deploy, then add the two secrets:

```sh
npx wrangler deploy
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Each `secret put` asks you to paste the value. Secrets take effect straight away, no redeploy needed. Until both are in, every submission gets rejected, which is the safe way round.

The first deploy asks you to pick a `workers.dev` subdomain if your account doesn't have one yet. When it finishes, it prints the Worker's address, something like:

```
https://contact-form-worker.<your-subdomain>.workers.dev
```

Write it down. The form needs it.

The non-secret settings live in `wrangler.jsonc` under `vars` (delivery address, sender, allowed sites, subject prefix, thank-you page). Change them there, then run `npx wrangler deploy` again.

## 4. Put the form on the page

This is already done in `index.html`: the form is in the closing "Not sure which one fits?" section, styled to match the page, and it posts to `https://contact-form-worker.livetools.workers.dev/`. Its script sits at the bottom of the page with the others.

1. Put the Turnstile **Site Key** from step 2 into the form's `data-sitekey`, in place of `YOUR_TURNSTILE_SITEKEY`.
2. Commit, merge into `main` and push. GitHub Pages publishes it within a minute or two.

`form-snippet.html` is the same form unstyled, for reuse on another page. If the Worker ever moves to a new address, change the form's `action` in both places.

Then send yourself a real quote request from fusioncam.co. Hitting **Reply** on the email should go straight to the address typed into the form.

Adding a question to the form later is just a matter of adding a field to the HTML. The Worker emails every field it gets, in order, so it doesn't need redeploying. Field names become the labels in the email (`machine_and_control` shows as "Machine and control"). Names starting with `_` are reserved and don't appear in the email.

## Testing locally

This runs the Worker on your PC with Turnstile's test keys, which always pass, so you can try the form without touching the live site.

1. Copy `.dev.vars.example` to `.dev.vars`. To test actual sending, put your real Resend key in it. Mail goes to `delivered@resend.dev`, Resend's test inbox, so nothing reaches you. Without a real key, everything works up to the send, which then fails with a 502.
2. In one terminal: `npm run dev` (the Worker, on http://localhost:8787)
3. In another: `npm run test-page` (the test form, on http://localhost:8788)
4. Open http://localhost:8788 and send the form.

Note: if Resend rejects the test sender `onboarding@resend.dev`, change `FROM_EMAIL` in `.dev.vars` to `forms@mail.fusioncam.co` once that domain is verified.

To check the "spam check failed" path, change `TURNSTILE_SECRET_KEY` in `.dev.vars` to `2x0000000000000000000000000000000AA` (always fails) and restart `npm run dev`.

### Curl tests

These run in Git Bash with `npm run dev` going. The rate limit allows 5 submissions a minute per visitor address. Locally you can fake a different visitor per test with the `CF-Connecting-IP` header, which is why each test uses its own number. (On the live Worker, Cloudflare sets that header itself and ignores yours.)

```sh
W=http://localhost:8787/
O="Origin: http://localhost:8788"
J="Accept: application/json"
T=XXXX.DUMMY.TOKEN.XXXX   # the token Turnstile's test keys accept

# Success: {"ok":true} with a real Resend key, otherwise a 502
curl -s -H "$O" -H "$J" -H "CF-Connecting-IP: 10.0.0.1" \
  -F name=Test -F email=test@example.com -F "message=Hello" -F _subject="Quote request" \
  -F cf-turnstile-response=$T $W

# Success without JavaScript: a 303 redirect to the thank-you page (with a real key)
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -H "$O" -H "CF-Connecting-IP: 10.0.0.2" \
  -d name=Test -d message=Hi -d cf-turnstile-response=$T $W

# Honeypot filled in: {"ok":true}, but nothing is sent (the dev log shows "honeypot")
curl -s -H "$O" -H "$J" -H "CF-Connecting-IP: 10.0.0.3" \
  -F name=Bot -F _gotcha=spam -F cf-turnstile-response=$T $W

# Another website: 403
curl -s -H "Origin: https://example.com" -H "$J" -F name=Test -F cf-turnstile-response=$T $W

# Missing spam-check token: 400
curl -s -H "$O" -H "$J" -H "CF-Connecting-IP: 10.0.0.4" -F name=Test $W

# Oversized body (40 KB, the limit is 32 KB): 413
head -c 40000 /dev/zero | tr '\0' a > big.txt
curl -s -H "$O" -H "$J" -H "CF-Connecting-IP: 10.0.0.5" \
  -F "message=<big.txt" -F cf-turnstile-response=$T $W
rm big.txt

# Wrong method: 405
curl -s -o /dev/null -w "%{http_code}\n" -X GET -H "$O" $W
```

Note: right after an oversized upload, wrangler's local server sometimes fails the next request with "Network connection lost". That's a quirk in wrangler's local proxy, not the Worker. The request after that works normally.

## Troubleshooting

To see what the live Worker is doing, run `npx wrangler tail` while you send a test, or open **Workers & Pages → contact-form-worker → Logs** in the Cloudflare dashboard. Each request logs one line with an outcome (`sent`, `honeypot`, `rejected`) and a code. Nothing the visitor typed is ever logged.

### Resend domain stuck on Pending

- The most common cause is a doubled-up domain. If you typed `send.mail.fusioncam.co` into Porkbun's Host box, the record ends up at `send.mail.fusioncam.co.fusioncam.co`. Edit it down to `send.mail`.
- Check the record is visible from outside: `nslookup -type=TXT resend._domainkey.mail.fusioncam.co`. If nothing comes back, Porkbun hasn't published it yet or the host is wrong.
- Make sure the value was pasted whole. The signing key is long and easy to clip.
- Give it a few hours before deleting and re-adding anything.

### Turnstile errors

The log line shows the reason after `turnstile_failed:`.

- `invalid-input-secret`: the Worker's `TURNSTILE_SECRET_KEY` is wrong, or it's still a test key. Run `npx wrangler secret put TURNSTILE_SECRET_KEY` again.
- `timeout-or-duplicate`: the token was older than 5 minutes or had already been used. Usually it's someone who left the page open, and a second try works.
- `turnstile_wrong_hostname`: the spam check ran on a site that isn't in `ALLOWED_HOSTNAMES`. Check `wrangler.jsonc`.
- The widget shows an error on the page itself, or the browser console mentions error `110200`: the site isn't in the widget's hostname list in the Turnstile dashboard.

### CORS errors in the browser console

The page's address has to match an entry in `ALLOWED_ORIGINS` exactly: `https`, with or without `www`, and no trailing slash. Both `https://fusioncam.co` and `https://www.fusioncam.co` are already in. If you add another address, add it to both `ALLOWED_ORIGINS` and `ALLOWED_HOSTNAMES`, then redeploy. The Worker log shows `origin_not_allowed` for these.

### Resend errors (the Worker returns a 502)

The log line shows Resend's status and error name.

- **401** `validation_error`: the API key is wrong or was deleted. Make a new one and `secret put` it again.
- **403** `validation_error`: usually the `from` domain isn't verified, or the key is restricted to a different domain. Check `FROM_EMAIL` ends in `@mail.fusioncam.co` and the domain shows Verified.
- **422** `missing_required_field`: a setting is blank, most likely `FROM_EMAIL` or `TO_EMAIL` in `wrangler.jsonc`.
- **429** `daily_quota_exceeded` or `monthly_quota_exceeded`: you've hit the free plan limit (below).

## Free plan limits

- **Resend**: 3,000 emails a month and 100 a day. The daily count resets at midnight UTC, which is lunchtime or early afternoon in NZ.
- **Cloudflare Workers**: 100,000 requests a day. A quote form won't get near it.
- **Turnstile**: free.
- **Rate limit**: 5 submissions a minute per visitor address. Cloudflare counts this per data centre, so it's a loose filter. Turnstile is the real gate.
