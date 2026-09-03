#!/usr/bin/env node
/**
 * Removes abandoned guest sessions and the files they uploaded.
 *
 * Guest accounts are permanent rows in auth.users and count toward the
 * project's monthly active users, so they need periodic sweeping. Deleting the
 * user cascades to their RFPs, responses and evaluations — but not to their
 * uploaded files, and that is why this script exists rather than a lone cron
 * job in SQL.
 *
 * Deleting a row from storage.objects removes only Storage's metadata. The
 * object itself stays in the bucket, and with the row gone nothing is left to
 * find it by. Files therefore have to go through the Storage API, which this
 * script does before asking the database to delete the users. As a backstop,
 * delete_stale_guests() skips any guest that still owns objects, so an
 * interrupted run leaves work to finish rather than bytes stranded.
 *
 * A guest who saved their work is never in scope: attaching an email clears
 * is_anonymous, which takes the account out of every query below.
 *
 * Usage:
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   node scripts/purge-stale-guests.mjs [--older-than "30 days"] [--dry-run]
 *
 * The service role key bypasses row-level security and can read and delete any
 * data in the project. It belongs only in the environment of a maintenance job
 * like this one — never in .env.local, and never in anything prefixed
 * NEXT_PUBLIC_, which ships to the browser.
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Both are under Project Settings -> API in the Supabase dashboard."
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const olderThanIndex = args.indexOf("--older-than");
const olderThan =
  olderThanIndex !== -1 ? args[olderThanIndex + 1] : "30 days";

if (!/^\d+\s+(second|minute|hour|day|week|month|year)s?$/.test(olderThan)) {
  console.error(
    `Invalid --older-than value: ${olderThan}\n` +
      'Expected a PostgreSQL interval such as "30 days" or "6 hours".'
  );
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BUCKET = "rfp-files";
/** Storage caps a remove() call at 1000 keys. */
const REMOVE_BATCH = 500;

async function main() {
  console.log(
    `Sweeping guests inactive for more than ${olderThan}${dryRun ? " (dry run)" : ""}…`
  );

  const { data: guests, error: guestsError } = await supabase.rpc(
    "stale_guest_ids",
    { p_older_than: olderThan }
  );
  if (guestsError) throw new Error(`stale_guest_ids: ${guestsError.message}`);

  const guestCount = guests?.length ?? 0;
  if (guestCount === 0) {
    console.log("Nothing to sweep.");
    return;
  }

  const { data: files, error: filesError } = await supabase.rpc(
    "stale_guest_files",
    { p_older_than: olderThan }
  );
  if (filesError) throw new Error(`stale_guest_files: ${filesError.message}`);

  const paths = (files ?? []).map((row) => row.object_name);
  console.log(`Found ${guestCount} stale guest(s) holding ${paths.length} file(s).`);

  if (dryRun) {
    console.log("Dry run — nothing deleted.");
    return;
  }

  let removed = 0;
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const batch = paths.slice(i, i + REMOVE_BATCH);
    const { error } = await supabase.storage.from(BUCKET).remove(batch);

    // Stop rather than press on: delete_stale_guests() skips guests that still
    // hold objects, so leaving early is safe and the next run resumes. Deleting
    // the users anyway would strand whatever this batch failed to remove.
    if (error) {
      throw new Error(
        `Storage remove failed after ${removed} file(s): ${error.message}`
      );
    }
    removed += batch.length;
  }

  if (removed > 0) console.log(`Removed ${removed} file(s) from ${BUCKET}.`);

  const { data: deleted, error: deleteError } = await supabase.rpc(
    "delete_stale_guests",
    { p_older_than: olderThan }
  );
  if (deleteError) throw new Error(`delete_stale_guests: ${deleteError.message}`);

  console.log(`Deleted ${deleted} guest account(s) and their evaluations.`);

  if (deleted < guestCount) {
    console.warn(
      `${guestCount - deleted} guest(s) were left in place because files remain ` +
        `for them. Re-run to finish.`
    );
  }
}

main().catch((error) => {
  console.error(`Purge failed: ${error.message}`);
  process.exit(1);
});
