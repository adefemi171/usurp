#!/bin/bash
# Run as root from an audited staging directory. Creates only Usurp resources.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run as root'; exit 1; }
cd -- "$(dirname -- "$0")"
[[ ! -e /opt/usurp-data ]] || { echo 'Usurp directory exists; inspect before proceeding'; exit 1; }
[[ ! -e /etc/nginx/sites-enabled/usurp-db-acme.conf ]] || exit 1
[[ -z $(ss -H -lnt 'sport = :15433') ]] || { echo 'Port 15433 is occupied'; exit 1; }
[[ -z $(docker ps -aq --filter label=com.docker.compose.project=usurp-data) ]] || exit 1
install -d -m 700 /opt/usurp-data /opt/usurp-data/secrets
install -m 644 compose.yml pg_hba.conf /opt/usurp-data/
install -m 755 init.sh /opt/usurp-data/
openssl rand -hex 32 > /opt/usurp-data/secrets/admin-password
openssl rand -hex 32 > /opt/usurp-data/secrets/app-password
openssl rand -hex 48 > /opt/usurp-data/secrets/backup-passphrase
chown 999:999 /opt/usurp-data/secrets/app-password
# All values below are nonsecret. Bind remains private throughout rehearsal.
printf '%s\n' 'USURP_POSTGRES_IMAGE=postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0' 'USURP_DB_BIND=127.0.0.1' > /opt/usurp-data/.env
install -d -m 755 /var/lib/usurp-acme/.well-known/acme-challenge
install -m 644 nginx-acme.conf /etc/nginx/sites-enabled/usurp-db-acme.conf
if ! nginx -t >/dev/null 2>&1; then
    mv /etc/nginx/sites-enabled/usurp-db-acme.conf /opt/usurp-data/nginx-acme.failed
    echo 'Nginx validation failed; new site withdrawn without reload'; exit 1
fi
systemctl reload nginx
install -m 755 renew-certificate.sh /etc/letsencrypt/renewal-hooks/deploy/usurp-postgres
echo 'Usurp configuration staged, HTTP challenge route loaded; database not started.'
