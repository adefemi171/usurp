#!/bin/bash
set -euo pipefail
umask 077
exec 9>/run/lock/usurp-db-backup.lock
flock -n 9 || { echo 'Usurp backup already running'; exit 1; }
backup_dir=/var/backups/usurp-db
install -d -m 700 "$backup_dir"
database=usurp
prefix=usurp
report="$backup_dir/latest-backup.json"
if [[ ${1:-} == --rehearsal ]]; then
  database=usurp_rehearsal; prefix=rehearsal
  report="$backup_dir/latest-rehearsal-backup.json"
elif [[ $# != 0 ]]; then exit 2; fi
report_failure() {
  local status=$?
  if [[ -n ${tmp:-} && -e "$tmp" ]]; then mv "$tmp" "$tmp.failed"; fi
  if (( status != 0 )); then
    printf '{"ok":false,"completedAt":"%s"}\n' "$(date -u +%FT%TZ)" > "$report"
    logger -p daemon.err -t usurp-backup 'Usurp backup failed; inspect usurp-db-backup.service'
  fi
}
trap report_failure EXIT
used=$(df --output=pcent "$backup_dir" | tail -1 | tr -dc '0-9')
(( used < 85 )) || { echo 'Backup refused: disk usage is at least 85%'; exit 1; }
name="$prefix-$(date -u +%Y%m%dT%H%M%SZ).dump.gpg"
tmp="$backup_dir/$name.partial"
docker compose --project-directory /opt/usurp-data exec -T postgres \
  pg_dump -U usurp_admin -d "$database" -Fc --no-owner --no-acl |
  gpg --batch --yes --pinentry-mode loopback --passphrase-file /opt/usurp-data/secrets/backup-passphrase \
    --symmetric --cipher-algo AES256 --output "$tmp"
test -s "$tmp"
mv "$tmp" "$backup_dir/$name"
cd "$backup_dir"
sha256sum "$name" > "$name.sha256"
printf '{"ok":true,"completedAt":"%s","file":"%s","bytes":%s}\n' \
  "$(date -u +%FT%TZ)" "$name" "$(stat -c %s "$name")" > "$report"
# Only this job's known archive/checksum names are eligible for retention.
find "$backup_dir" -maxdepth 1 -type f -name "$prefix-????????T??????Z.dump.gpg*" -mtime +14 -delete
echo "Encrypted Usurp backup completed: $name"
