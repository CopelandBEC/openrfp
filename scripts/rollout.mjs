#!/usr/bin/env node
/**
 * Guest-mode rollout runbook — drives the dashboard steps in GUESTMODEROLLOUT.md
 * through the Supabase Management, Vercel, Resend and Cloudflare APIs.
 *
 * Credentials come from ~/.openrfp-rollout.env (KEY=value lines, chmod 600),
 * never from the repo. Keys it understands:
 *
 *   SUPABASE_ACCESS_TOKEN   sbp_…  https://supabase.com/dashboard/account/tokens
 *   SUPABASE_PROJECT_REF    defaults to the ref in NEXT_PUBLIC_SUPABASE_URL
 *   VERCEL_TOKEN            https://vercel.com/account/tokens
 *   VERCEL_PROJECT          default "openrfp"
 *   VERCEL_TEAM             default "copeland-bec" (slug)
 *   RESEND_API_KEY          full-access key (to create domain + sending key)
 *   RESEND_SMTP_KEY         sending-only key used as the SMTP password
 *   MAIL_DOMAIN             e.g. mail.copelandbec.com
 *   SENDER_EMAIL            e.g. no-reply@mail.copelandbec.com
 *   PROD_URL                default https://openrfp.vercel.app
 *   PREVIEW_URL_PATTERN     default https://*-copeland-bec.vercel.app
 *   TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID   (only for `turnstile-create`)
 *
 * Usage: node scripts/rollout.mjs <command> [args]
 *
 *   status                      what's live right now (auth config, schema, bucket, env)
 *   apply-schema [file]         Phase 2.1 — run schema.sql (default: PR branch copy)
 *   verify-schema               Phase 2.2 — the eleven checks + grants + bucket + limits
 *   resend-domain               Phase 1.2 — create MAIL_DOMAIN in Resend, print DNS records
 *   resend-domain-status        Phase 1.2 — poll verification
 *   resend-key                  Phase 3.1 — create a sending-only key (prints once)
 *   email-config                Phase 3.2–3.4 — SMTP, rate limit 30/h, site URL, redirects
 *   anon on|off                 Phase 4 — anonymous sign-ins
 *   turnstile-create            Phase 1.3 — create widget via Cloudflare (prints keys once)
 *   vercel-env                  Phase 7.1–7.2 — site key + IP_HASH_SECRET
 *   vercel-redeploy             Phase 7.3 — fresh production build from main
 *   vercel-check-key            Phase 7.4 — confirm the site key is in the deployed bundle
 *   captcha on|off              Phase 7.5 / rollback
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const env = loadEnv();
const [cmd, ...args] = process.argv.slice(2);

const PROJECT_REF =
  env.SUPABASE_PROJECT_REF ||
  (env.NEXT_PUBLIC_SUPABASE_URL || "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
const PROD_URL = env.PROD_URL || "https://openrfp.vercel.app";
const PREVIEW_URL_PATTERN = env.PREVIEW_URL_PATTERN || "https://*-copeland-bec.vercel.app";
const VERCEL_PROJECT = env.VERCEL_PROJECT || "openrfp";
const VERCEL_TEAM = env.VERCEL_TEAM || "copeland-bec";

const commands = {
  status,
  sql: async (q) => console.log(JSON.stringify(await sql(q), null, 1)),
  "apply-schema": applySchema,
  "verify-schema": verifySchema,
  "resend-domain": resendDomain,
  "resend-domain-status": resendDomainStatus,
  "resend-key": resendKey,
  "email-config": emailConfig,
  anon,
  "turnstile-create": turnstileCreate,
  "vercel-env": vercelEnv,
  "vercel-redeploy": vercelRedeploy,
  "vercel-status": vercelStatus,
  "vercel-check-key": vercelCheckKey,
  captcha,
};

// ---------------------------------------------------------------- helpers --

function loadEnv() {
  const out = {};
  for (const file of [path.join(REPO, ".env.local"), path.join(os.homedir(), ".openrfp-rollout.env")]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return { ...out, ...process.env };
}

function need(key, hint) {
  if (!env[key]) throw new Error(`${key} is not set in ~/.openrfp-rollout.env${hint ? ` — ${hint}` : ""}`);
  return env[key];
}

async function api(url, { method = "GET", token, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
  }
  return json;
}

const ok = (label, pass, detail = "") => console.log(`${pass ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
const redact = (v) => (v ? `${String(v).slice(0, 4)}…(${String(v).length} chars)` : "(unset)");

// ------------------------------------------------------------- supabase --

const SB = "https://api.supabase.com/v1";
const sbToken = () => need("SUPABASE_ACCESS_TOKEN", "create one at https://supabase.com/dashboard/account/tokens");
const sbProject = () => {
  if (!PROJECT_REF) throw new Error("Could not determine the Supabase project ref");
  return `${SB}/projects/${PROJECT_REF}`;
};

async function sql(query) {
  return api(`${sbProject()}/database/query`, { method: "POST", token: sbToken(), body: { query } });
}
async function getAuthConfig() {
  return api(`${sbProject()}/config/auth`, { token: sbToken() });
}
async function patchAuthConfig(patch) {
  // Refuse to send a key the live API doesn't report — field names drift.
  const current = await getAuthConfig();
  const unknown = Object.keys(patch).filter((k) => !(k in current));
  if (unknown.length) {
    throw new Error(`Auth config has no field(s) ${unknown.join(", ")}. Known: ${Object.keys(current).sort().join(", ")}`);
  }
  return api(`${sbProject()}/config/auth`, { method: "PATCH", token: sbToken(), body: patch });
}

const SCHEMA_CHECKS = `
select
  to_regclass('public.ai_limits') is not null                              as ai_limits_table,
  to_regprocedure('public.reserve_ai_call(text,text,integer)') is not null as reserve_fn,
  to_regprocedure('public.retry_after_seconds(timestamptz)') is not null   as retry_fn,
  to_regprocedure('public.can_create_rfp()') is not null                   as rfp_cap_fn,
  to_regprocedure('public.can_upload_file()') is not null                  as file_cap_fn,
  to_regprocedure('public.can_create_response()') is not null              as response_cap_fn,
  to_regprocedure('public.is_guest()') is not null                         as is_guest_fn,
  to_regprocedure('public.stale_guest_ids(interval)') is not null          as stale_ids_fn,
  to_regprocedure('public.stale_guest_files(interval)') is not null        as stale_files_fn,
  to_regprocedure('public.delete_stale_guests(interval)') is not null      as cleanup_fn,
  exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='ai_usage' and column_name='ip_hash') as ip_hash_column`;

const GRANTS_CHECK = `
select count(*)::int as should_be_zero
  from information_schema.role_table_grants
 where table_schema='public' and table_name='ai_usage'
   and grantee in ('authenticated','anon')
   and privilege_type in ('INSERT','UPDATE','DELETE')`;

const BUCKET_CHECK = `select file_size_limit, allowed_mime_types from storage.buckets where id = 'rfp-files'`;

async function verifySchema() {
  const [checks] = await sql(SCHEMA_CHECKS);
  let allGood = true;
  for (const [k, v] of Object.entries(checks)) { ok(k, v === true); allGood &&= v === true; }
  const [{ should_be_zero }] = await sql(GRANTS_CHECK);
  ok("ai_usage client write grants revoked", should_be_zero === 0, `(${should_be_zero})`);
  allGood &&= should_be_zero === 0;
  const [bucket] = await sql(BUCKET_CHECK);
  const bucketOk = bucket?.file_size_limit === 26214400 && JSON.stringify(bucket?.allowed_mime_types) === '["application/pdf"]';
  ok("bucket ceilings 25 MB / PDF only", bucketOk, JSON.stringify(bucket));
  allGood &&= bucketOk;
  if (checks.ai_limits_table) {
    const limits = await sql("select * from public.ai_limits");
    console.log("ai_limits:", JSON.stringify(limits[0] ?? null));
  }
  console.log(allGood ? "\nSchema verified." : "\nSchema NOT fully applied.");
  if (!allGood) process.exitCode = 1;
}

function readSchema(file) {
  if (file) return fs.readFileSync(file, "utf8");
  // Default: the PR branch copy, never main's.
  const ref = "origin/claude/magic-link-auth-options-eofyd5";
  execSync(`git fetch -q origin claude/magic-link-auth-options-eofyd5:refs/remotes/${ref}`, { cwd: REPO, stdio: "ignore" });
  return execSync(`git cat-file -p ${ref}:supabase/schema.sql`, { cwd: REPO, encoding: "utf8" });
}

async function applySchema(file) {
  const schema = readSchema(file);
  console.log(`Applying ${schema.split("\n").length}-line schema to project ${PROJECT_REF}…`);
  await sql(schema);
  console.log("Applied. Verifying…\n");
  await verifySchema();
}

async function anon(state) {
  if (!["on", "off"].includes(state)) throw new Error("usage: anon on|off");
  const r = await patchAuthConfig({ external_anonymous_users_enabled: state === "on" });
  ok(`anonymous sign-ins ${state}`, r.external_anonymous_users_enabled === (state === "on"));
}

async function emailConfig() {
  const smtpKey = env.RESEND_SMTP_KEY || need("RESEND_API_KEY", "or set RESEND_SMTP_KEY to a sending-only key");
  const sender = need("SENDER_EMAIL", "e.g. no-reply@mail.copelandbec.com");
  const current = await getAuthConfig();
  // The save-to-account flow redirects to /auth/callback?next=…, and GoTrue
  // glob-matches non-Site-URL redirects, so exact entries alone would miss it.
  const wanted = [
    "http://localhost:3000/auth/callback",
    "http://localhost:3000/auth/callback**",
    `${PROD_URL}/auth/callback`,
    `${PROD_URL}/auth/callback**`,
    `${PREVIEW_URL_PATTERN}/auth/callback`,
    `${PREVIEW_URL_PATTERN}/auth/callback**`,
  ];
  const existing = (current.uri_allow_list || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allow = [...new Set([...existing, ...wanted])].join(",");
  const r = await patchAuthConfig({
    smtp_host: "smtp.resend.com",
    smtp_port: "465",
    smtp_user: "resend",
    smtp_pass: smtpKey,
    smtp_admin_email: sender,
    smtp_sender_name: "OpenRFP",
    rate_limit_email_sent: 30,
    site_url: PROD_URL,
    uri_allow_list: allow,
  });
  ok("SMTP host", r.smtp_host === "smtp.resend.com");
  ok("SMTP user", r.smtp_user === "resend");
  ok("sender", r.smtp_admin_email === sender);
  ok("email rate limit 30/h", Number(r.rate_limit_email_sent) === 30, `(${r.rate_limit_email_sent})`);
  ok("site URL", r.site_url === PROD_URL, r.site_url);
  ok("redirect URLs", wanted.every((u) => (r.uri_allow_list || "").includes(u)), r.uri_allow_list);
}

async function captcha(state) {
  if (!["on", "off"].includes(state)) throw new Error("usage: captcha on|off");
  if (state === "on") {
    const secret = need("TURNSTILE_SECRET_KEY");
    console.log("Reminder: only do this after `vercel-check-key` passes — CAPTCHA is project-wide and gates magic links too.");
    const r = await patchAuthConfig({
      security_captcha_enabled: true,
      security_captcha_provider: "turnstile",
      security_captcha_secret: secret,
    });
    ok("CAPTCHA on (turnstile)", r.security_captcha_enabled === true && r.security_captcha_provider === "turnstile");
  } else {
    const r = await patchAuthConfig({ security_captcha_enabled: false });
    ok("CAPTCHA off", r.security_captcha_enabled === false);
  }
}

// --------------------------------------------------------------- resend --

const RS = "https://api.resend.com";
const rsToken = () => need("RESEND_API_KEY", "full-access key from https://resend.com/api-keys");

async function resendDomain() {
  const name = need("MAIL_DOMAIN", "e.g. mail.copelandbec.com");
  const list = await api(`${RS}/domains`, { token: rsToken() });
  let d = (list.data || []).find((x) => x.name === name);
  if (!d) {
    d = await api(`${RS}/domains`, { method: "POST", token: rsToken(), body: { name } });
    console.log(`Created domain ${name} (${d.id}).`);
  }
  d = await api(`${RS}/domains/${d.id}`, { token: rsToken() });
  console.log(`\nStatus: ${d.status}\n\nAdd these records at your DNS host (Namecheap → Advanced DNS):\n`);
  for (const r of d.records || []) {
    console.log(`  ${r.type.padEnd(4)} ${r.name.padEnd(28)} ${r.priority ? `prio ${r.priority} ` : ""}${r.value}`);
  }
  console.log("\nThen run: node scripts/rollout.mjs resend-domain-status");
}

async function resendDomainStatus() {
  const name = need("MAIL_DOMAIN");
  const list = await api(`${RS}/domains`, { token: rsToken() });
  const d = (list.data || []).find((x) => x.name === name);
  if (!d) throw new Error(`Domain ${name} not found in Resend — run resend-domain first`);
  if (d.status !== "verified") {
    await api(`${RS}/domains/${d.id}/verify`, { method: "POST", token: rsToken() }).catch(() => {});
  }
  const fresh = await api(`${RS}/domains/${d.id}`, { token: rsToken() });
  ok(`Resend domain ${name} verified`, fresh.status === "verified", `(${fresh.status})`);
  for (const r of fresh.records || []) console.log(`  ${r.type.padEnd(4)} ${r.name.padEnd(28)} ${r.status}`);
}

async function resendKey() {
  const r = await api(`${RS}/api-keys`, { method: "POST", token: rsToken(), body: { name: "openrfp-supabase-smtp", permission: "sending_access" } });
  console.log("Sending-only key created. Add to ~/.openrfp-rollout.env as RESEND_SMTP_KEY (shown once):\n");
  console.log(`RESEND_SMTP_KEY=${r.token}`);
}

// ----------------------------------------------------------- cloudflare --

async function turnstileCreate() {
  const token = need("CLOUDFLARE_API_TOKEN", "needs Turnstile:Edit");
  const account = need("CLOUDFLARE_ACCOUNT_ID");
  const host = new URL(PROD_URL).hostname;
  const r = await api(`https://api.cloudflare.com/client/v4/accounts/${account}/challenges/widgets`, {
    method: "POST", token,
    body: { name: "OpenRFP", mode: "managed", domains: [host, "localhost"] },
  });
  saveEnv({ TURNSTILE_SITE_KEY: r.result.sitekey, TURNSTILE_SECRET_KEY: r.result.secret });
  console.log(`Widget "${r.result.name}" created for ${r.result.domains.join(", ")}; keys saved to ~/.openrfp-rollout.env.`);
}

/** Write KEY=value pairs into ~/.openrfp-rollout.env, replacing existing lines. */
function saveEnv(pairs) {
  const file = path.join(os.homedir(), ".openrfp-rollout.env");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [k, v] of Object.entries(pairs)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text.replace(/\n?$/, "\n")}${k}=${v}\n`;
    env[k] = v;
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
}

// --------------------------------------------------------------- vercel --

const VC = "https://api.vercel.com";
const vcToken = () => need("VERCEL_TOKEN", "https://vercel.com/account/tokens");

async function vercelProject() {
  // A team-scoped token can't list teams, but it can read the project directly;
  // the project's accountId is the team id for subsequent calls.
  const project = await api(`${VC}/v9/projects/${VERCEL_PROJECT}`, { token: vcToken() });
  const q = project.accountId?.startsWith("team_") ? `?teamId=${project.accountId}` : "";
  return { project, q };
}

async function vercelEnv() {
  const siteKey = need("TURNSTILE_SITE_KEY");
  const { project, q } = await vercelProject();
  const existing = new Map((project.env || []).map((e) => [e.key, e]));

  const upsert = async (key, value, target, type) => {
    const cur = existing.get(key);
    if (cur) {
      await api(`${VC}/v9/projects/${project.id}/env/${cur.id}${q}`, { method: "PATCH", token: vcToken(), body: { value, target, type } });
      ok(`updated ${key}`, true, `→ ${target.join(",")}`);
    } else {
      await api(`${VC}/v10/projects/${project.id}/env${q}`, { method: "POST", token: vcToken(), body: { key, value, target, type } });
      ok(`added ${key}`, true, `→ ${target.join(",")}`);
    }
  };

  await upsert("NEXT_PUBLIC_TURNSTILE_SITE_KEY", siteKey, ["production", "preview"], "plain");
  if (existing.has("IP_HASH_SECRET")) {
    ok("IP_HASH_SECRET already set — left alone", true);
  } else {
    await upsert("IP_HASH_SECRET", crypto.randomBytes(32).toString("hex"), ["production"], "encrypted");
  }
  console.log("\nNEXT_PUBLIC_ values are inlined at build time — run vercel-redeploy next.");
}

async function vercelRedeploy() {
  const { project, q } = await vercelProject();
  const repoId = project.link?.repoId;
  if (!repoId) throw new Error("Project is not linked to a Git repo; redeploy from the Vercel dashboard");
  const d = await api(`${VC}/v13/deployments${q}`, {
    method: "POST", token: vcToken(),
    body: { name: VERCEL_PROJECT, project: project.id, target: "production", gitSource: { type: "github", repoId, ref: project.link.productionBranch || "main" } },
  });
  console.log(`Deployment ${d.id} queued: https://${d.url}`);
  process.stdout.write("Waiting for READY");
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const s = await api(`${VC}/v13/deployments/${d.id}${q}`, { token: vcToken() });
    process.stdout.write(".");
    if (s.readyState === "READY") { console.log(`\n✓ READY — ${PROD_URL}`); return; }
    if (["ERROR", "CANCELED"].includes(s.readyState)) throw new Error(`Deployment ${s.readyState}`);
  }
  throw new Error("Timed out waiting for deployment");
}

/** Latest production deployment; waits for it to settle when given "wait". */
async function vercelStatus(mode) {
  const { project, q } = await vercelProject();
  const sep = q ? "&" : "?";
  for (let i = 0; i < 60; i++) {
    const j = await api(`${VC}/v6/deployments${q}${sep}projectId=${project.id}&target=production&limit=1`, { token: vcToken() });
    const d = (j.deployments || [])[0];
    if (!d) throw new Error("No production deployments found");
    const state = d.readyState || d.state;
    const sha = d.meta?.githubCommitSha?.slice(0, 7);
    if (mode !== "wait" || ["READY", "ERROR", "CANCELED"].includes(state)) {
      console.log(`${state}  sha=${sha}  ${d.meta?.githubCommitMessage?.split("\n")[0]?.slice(0, 70) ?? ""}  https://${d.url}`);
      if (state !== "READY") process.exitCode = 1;
      return;
    }
    process.stdout.write(`${state} (${sha})… `);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("Timed out waiting for the deployment");
}

async function vercelCheckKey() {
  const siteKey = need("TURNSTILE_SITE_KEY");
  const html = await (await fetch(PROD_URL, { cache: "no-store" })).text();
  const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  let found = html.includes(siteKey);
  for (const s of scripts) {
    if (found) break;
    const js = await (await fetch(`${PROD_URL}${s}`)).text();
    found = js.includes(siteKey);
  }
  ok("Turnstile site key present in the deployed production bundle", found);
  if (!found) { console.log("Do NOT enable CAPTCHA yet — redeploy first."); process.exitCode = 1; }
}

// --------------------------------------------------------------- status --

async function status() {
  console.log(`Project ref: ${PROJECT_REF}   Production: ${PROD_URL}\n`);
  console.log("Credentials in ~/.openrfp-rollout.env:");
  for (const k of ["SUPABASE_ACCESS_TOKEN", "VERCEL_TOKEN", "RESEND_API_KEY", "RESEND_SMTP_KEY", "CLOUDFLARE_API_TOKEN", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "MAIL_DOMAIN", "SENDER_EMAIL"]) {
    console.log(`  ${k.padEnd(24)} ${["MAIL_DOMAIN", "SENDER_EMAIL"].includes(k) ? env[k] || "(unset)" : redact(env[k])}`);
  }

  // Public probe — works with no credentials at all.
  const settings = await (await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY } })).json();
  console.log(`\nSupabase auth (public): anonymous sign-ins ${settings.external?.anonymous_users ? "ON" : "off"}, email ${settings.external?.email ? "on" : "off"}`);

  if (env.SUPABASE_ACCESS_TOKEN) {
    const c = await getAuthConfig();
    console.log("Supabase auth (management API):");
    console.log(`  SMTP host        ${c.smtp_host || "(built-in sender, 2/h cap)"}`);
    console.log(`  email rate limit ${c.rate_limit_email_sent}/h`);
    console.log(`  site URL         ${c.site_url}`);
    console.log(`  redirect URLs    ${c.uri_allow_list || "(none)"}`);
    console.log(`  CAPTCHA          ${c.security_captcha_enabled ? `ON (${c.security_captcha_provider})` : "off"}`);
    console.log("\nSchema:");
    await verifySchema();
  } else {
    console.log("  (set SUPABASE_ACCESS_TOKEN to see SMTP/redirect/CAPTCHA config and to apply the schema)");
  }

  if (env.VERCEL_TOKEN) {
    const { project } = await vercelProject();
    const names = (project.env || []).map((e) => `${e.key}[${e.target.join("/")}]`);
    console.log(`\nVercel env vars: ${names.join(", ")}`);
  }
  if (env.RESEND_API_KEY && env.MAIL_DOMAIN) {
    console.log("");
    await resendDomainStatus().catch((e) => console.log(`Resend: ${e.message}`));
  }
}

// ------------------------------------------------------------- dispatch --

if (!commands[cmd]) {
  console.error(`Unknown command "${cmd ?? ""}". Commands: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}
await commands[cmd](...args).catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
