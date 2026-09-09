#!/bin/bash
# Restores into a new database with no app/worker attached; removes only the
# scratch database created by this invocation. Never overwrites a database.
set -euo pipefail
umask 077
exec 9>/run/lock/usurp-db-restore-check.lock
flock -n 9 || exit 1
compose=(docker compose --project-directory /opt/usurp-data)
report=/var/backups/usurp-db/latest-restore.json
prefix=usurp
if [[ ${1:-} == --rehearsal ]]; then
  prefix=rehearsal; report=/var/backups/usurp-db/latest-rehearsal-restore.json
elif [[ $# != 0 ]]; then exit 2; fi
created=0
finish() {
  local code=$?
  if (( created )); then "${compose[@]}" exec -T postgres dropdb -U usurp_admin usurp_restore_check || code=1; fi
  if (( code == 0 )); then
    printf '{"ok":true,"completedAt":"%s"}\n' "$(date -u +%FT%TZ)" > "$report"
  else
    printf '{"ok":false,"completedAt":"%s"}\n' "$(date -u +%FT%TZ)" > "$report"
    logger -p daemon.err -t usurp-backup 'Usurp restore check failed; inspect usurp-db-restore-check.service'
  fi
  exit "$code"
}
trap finish EXIT
cd /var/backups/usurp-db
archive=$(find . -maxdepth 1 -type f -name "$prefix-????????T??????Z.dump.gpg" -printf '%f\n' | sort | tail -1)
[[ -n "$archive" ]] || { echo 'No production backup available'; exit 1; }
sha256sum -c "$archive.sha256"
"${compose[@]}" exec -T postgres createdb -U usurp_admin -O usurp usurp_restore_check
created=1
gpg --batch --quiet --pinentry-mode loopback --passphrase-file /opt/usurp-data/secrets/backup-passphrase --decrypt "$archive" |
  "${compose[@]}" exec -T postgres pg_restore -U usurp_admin -d usurp_restore_check --role=usurp --no-owner --no-acl --exit-on-error
# Assert critical tables are queryable, not merely that pg_restore exited 0.
"${compose[@]}" exec -T postgres psql -X -q -U usurp_admin -d usurp_restore_check -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*) FROM public.usage_events;
SELECT count(*) FROM public.devices;
SELECT count(*) FROM public.usage_bridge_snapshots;
SELECT count(*) FROM drizzle.__drizzle_migrations;
SELECT count(*) FROM pgboss.job;
SQL
echo 'Usurp encrypted backup restored successfully; no worker was started.'
