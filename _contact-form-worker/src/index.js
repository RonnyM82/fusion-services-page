// Contact form backend: receives a form POST from the static site, filters spam,
// and emails the submission to TO_EMAIL through Resend.

const MAX_BODY_BYTES = 32 * 1024;
const MAX_FIELDS = 30;
const MAX_NAME_LENGTH = 64;
const MAX_VALUE_LENGTH = 5000;
const MAX_SUBJECT_LENGTH = 150;
const MAX_TOKEN_LENGTH = 2048;
const TURNSTILE_TIMEOUT_MS = 5000;
const RESEND_TIMEOUT_MS = 10000;
const DEFAULT_SUBJECT = "New website form submission";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RESEND_SEND_URL = "https://api.resend.com/emails";

// Turnstile's own field, plus anything starting with "_" (_gotcha, _subject, ...).
const TURNSTILE_FIELD = "cf-turnstile-response";
const isReserved = (name) => name === TURNSTILE_FIELD || name.startsWith("_");

// Thrown anywhere in the request flow to stop and answer with a status and a
// plain-English message. `code` goes to the logs, the message to the visitor.
class FormError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ctx = {
      origin: request.headers.get("Origin"),
      allowedOrigins: splitList(env.ALLOWED_ORIGINS),
      wantsJson: (request.headers.get("Accept") || "").includes("application/json"),
      referer: request.headers.get("Referer"),
    };

    try {
      if (url.pathname !== "/") throw new FormError(404, "not_found", "Not found.");
      if (request.method !== "POST" && request.method !== "OPTIONS") {
        throw new FormError(405, "method_not_allowed", "This address only accepts form submissions.");
      }
      if (!ctx.origin || !ctx.allowedOrigins.includes(ctx.origin)) {
        // No CORS headers on this one, so a browser on another site can't read it.
        ctx.origin = null;
        throw new FormError(403, "origin_not_allowed", "Submissions are only accepted from this website.");
      }
      if (request.method === "OPTIONS") return preflight(ctx.origin);

      log(await handleSubmission(request, env, ctx));
      return success(env, ctx);
    } catch (err) {
      if (err instanceof FormError) {
        log("rejected", { code: err.code, status: err.status });
        return failure(err, env, ctx);
      }
      log("error", { code: "unhandled", detail: String(err && err.name) });
      return failure(new FormError(500, "unhandled", "Something went wrong on our side. Please try again later."), env, ctx);
    }
  },
};

// Returns the outcome to log. Anything that stops the submission throws a FormError.
async function handleSubmission(request, env, ctx) {
  const form = await readForm(request);

  // Bots fill in every field they find. Answer as if it worked and send nothing.
  if ((form.get("_gotcha") || "") !== "") return "honeypot";

  await checkRateLimit(request, env);

  const fields = collectFields(form);
  const subject = buildSubject(form.get("_subject"), env.SUBJECT_PREFIX);
  const replyTo = findReplyTo(fields);

  const token = form.get(TURNSTILE_FIELD);
  await verifyTurnstile(token, request, env);

  const submittedAt = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date());

  await sendEmail(env, {
    subject,
    replyTo,
    text: renderText(fields, submittedAt, ctx),
    html: renderHtml(fields, submittedAt, ctx),
    idempotencyKey: await sha256Hex(token),
  });
  return "sent";
}

// ---------------------------------------------------------------------------
// Reading and validating the form

async function readForm(request) {
  // Keep the original case: the multipart boundary is case-sensitive.
  const contentType = request.headers.get("Content-Type") || "";
  const type = contentType.toLowerCase();
  if (!type.startsWith("multipart/form-data") && !type.startsWith("application/x-www-form-urlencoded")) {
    throw new FormError(415, "unsupported_content_type", "The form was sent in a format this address doesn't accept.");
  }

  const declared = Number(request.headers.get("Content-Length"));
  if (declared > MAX_BODY_BYTES) throw tooLarge();

  // Content-Length can be missing or wrong, so count the bytes as they arrive too.
  const chunks = [];
  let received = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BODY_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return await new Response(body, { headers: { "Content-Type": contentType } }).formData();
  } catch {
    throw new FormError(400, "unreadable_form", "The form data couldn't be read. Please try again.");
  }
}

function tooLarge() {
  return new FormError(413, "body_too_large", "That message is too long. Please shorten it and try again.");
}

// Every non-reserved text field, in the order the form sent them. File inputs are skipped.
function collectFields(form) {
  const fields = [];
  for (const [name, raw] of form.entries()) {
    if (isReserved(name) || typeof raw !== "string") continue;
    if (name.length > MAX_NAME_LENGTH) {
      throw new FormError(400, "field_name_too_long", "The form has a field this address doesn't accept.");
    }
    const value = raw.trim();
    if (value.length > MAX_VALUE_LENGTH) {
      throw new FormError(400, "field_too_long", `One of the answers is over ${MAX_VALUE_LENGTH.toLocaleString("en-NZ")} characters. Please shorten it.`);
    }
    if (value === "") continue;
    fields.push({ name, value });
    if (fields.length > MAX_FIELDS) {
      throw new FormError(400, "too_many_fields", "The form has more fields than this address accepts.");
    }
  }
  if (fields.length === 0) throw new FormError(400, "empty_form", "The form was empty. Please fill it in and try again.");
  return fields;
}

function buildSubject(raw, prefix) {
  const custom = typeof raw === "string"
    ? raw.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_LENGTH).trim()
    : "";
  const subject = custom || DEFAULT_SUBJECT;
  return prefix ? `${prefix} ${subject}` : subject;
}

// Only ever used as reply_to. Nothing is ever sent to this address.
function findReplyTo(fields) {
  const field = fields.find((f) => f.name === "email");
  if (!field) return undefined;
  const email = field.value;
  return email.length <= 254 && /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]{2,}$/.test(email)
    ? email
    : undefined;
}

// ---------------------------------------------------------------------------
// Spam checks

async function checkRateLimit(request, env) {
  if (!env.RATE_LIMITER) return;
  const key = request.headers.get("CF-Connecting-IP") || "unknown";
  let allowed = true;
  try {
    ({ success: allowed } = await env.RATE_LIMITER.limit({ key }));
  } catch {
    // A loose filter only. If it's unavailable, let Turnstile do the work.
    log("rate_limit_unavailable");
    return;
  }
  if (!allowed) {
    throw new FormError(429, "rate_limited", "Too many messages from your connection. Please wait a minute and try again.");
  }
}

async function verifyTurnstile(token, request, env) {
  const retry = "The spam check didn't go through. Please wait a few seconds and send it again.";
  if (typeof token !== "string" || token === "") throw new FormError(400, "turnstile_missing", retry);
  if (token.length > MAX_TOKEN_LENGTH) throw new FormError(400, "turnstile_malformed", retry);

  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY || "", response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.set("remoteip", ip);

  let result;
  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    result = await response.json();
  } catch (err) {
    const code = err && err.name === "TimeoutError" ? "turnstile_timeout" : "turnstile_network";
    throw new FormError(503, code, "The spam check couldn't be reached. Please try again in a minute.");
  }

  if (!result || result.success !== true) {
    const codes = Array.isArray(result && result["error-codes"]) ? result["error-codes"].join(",") : "none";
    throw new FormError(403, `turnstile_failed:${codes}`, retry);
  }
  if (!splitList(env.ALLOWED_HOSTNAMES).includes(result.hostname)) {
    throw new FormError(403, "turnstile_wrong_hostname", retry);
  }
}

// ---------------------------------------------------------------------------
// Sending

async function sendEmail(env, { subject, replyTo, text, html, idempotencyKey }) {
  const payload = { from: env.FROM_EMAIL, to: env.TO_EMAIL, subject, text, html };
  if (replyTo) payload.reply_to = replyTo;

  const failed = new FormError(502, "resend_failed", "Sorry, your message couldn't be sent. Please try again later, or email us directly.");
  let response;
  try {
    response = await fetch(RESEND_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY || ""}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (err) {
    log("resend_error", { code: err && err.name === "TimeoutError" ? "timeout" : "network" });
    throw failed;
  }

  if (!response.ok) {
    // Resend's message text can contain email addresses, so only its error name is logged.
    let name = "unknown";
    try {
      name = (await response.json()).name || name;
    } catch {}
    log("resend_error", { status: response.status, name });
    throw failed;
  }
}

function renderText(fields, submittedAt, ctx) {
  const lines = fields.map(({ name, value }) =>
    value.includes("\n") ? `${label(name)}:\n${value}\n` : `${label(name)}: ${value}`
  );
  return [
    lines.join("\n").trimEnd(),
    "",
    "---",
    `Submitted: ${submittedAt}`,
    `Origin: ${ctx.origin || "unknown"}`,
    `Page: ${ctx.referer || "unknown"}`,
  ].join("\n");
}

function renderHtml(fields, submittedAt, ctx) {
  const rows = fields
    .map(({ name, value }) => `<p><strong>${escapeHtml(label(name))}</strong><br>${escapeHtml(value).replace(/\r?\n/g, "<br>")}</p>`)
    .join("\n");
  const meta = [
    `Submitted: ${escapeHtml(submittedAt)}`,
    `Origin: ${escapeHtml(ctx.origin || "unknown")}`,
    `Page: ${escapeHtml(ctx.referer || "unknown")}`,
  ].join("<br>");
  return `<!doctype html><html><body style="font-family:sans-serif;line-height:1.5">\n${rows}\n<hr>\n<p style="color:#666;font-size:13px">${meta}</p>\n</body></html>`;
}

// "machine_and_control" -> "Machine and control"
function label(name) {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// Responses

function corsHeaders(origin) {
  const headers = { Vary: "Origin" };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function preflight(origin) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function success(env, ctx) {
  if (ctx.wantsJson) return json({ ok: true }, 200, ctx.origin);
  return new Response(null, { status: 303, headers: { ...corsHeaders(ctx.origin), Location: env.REDIRECT_URL } });
}

function failure(err, env, ctx) {
  const extra = err.status === 405 ? { Allow: "POST, OPTIONS" } : {};
  if (ctx.wantsJson) return json({ ok: false, error: err.message }, err.status, ctx.origin, extra);

  // Plain page for browsers with JavaScript off. Link back to the page they came from
  // when it's on an allowed site, otherwise to the first allowed site.
  const back = ctx.referer && ctx.allowedOrigins.some((o) => ctx.referer.startsWith(`${o}/`))
    ? ctx.referer
    : ctx.allowedOrigins[0] || "/";
  const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Message not sent</title></head>
<body style="font-family:sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>Message not sent</h1>
<p>${escapeHtml(err.message)}</p>
<p><a href="${escapeHtml(back)}">Go back to the form</a></p>
</body>
</html>`;
  return new Response(page, {
    status: err.status,
    headers: { ...corsHeaders(ctx.origin), ...extra, "Content-Type": "text/html; charset=utf-8" },
  });
}

function json(data, status, origin, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), ...extra, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Helpers

function splitList(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Outcomes and error codes only. Never field values or email addresses.
function log(outcome, details = {}) {
  console.log(JSON.stringify({ outcome, ...details }));
}
