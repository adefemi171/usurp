#!/bin/bash
set -euo pipefail
# Certbot invokes all deploy hooks; never copy another service's certificate.
[[ "${RENEWED_LINEAGE:-}" == /etc/letsencrypt/live/usurp.fi-techconsulting.com ]] || exit 0
install -d -m 750 -o 999 -g 999 /opt/usurp-data/tls
install -m 644 -o 999 -g 999 "$RENEWED_LINEAGE/fullchain.pem" /opt/usurp-data/tls/fullchain.pem.new
install -m 600 -o 999 -g 999 "$RENEWED_LINEAGE/privkey.pem" /opt/usurp-data/tls/privkey.pem.new
mv /opt/usurp-data/tls/fullchain.pem.new /opt/usurp-data/tls/fullchain.pem
mv /opt/usurp-data/tls/privkey.pem.new /opt/usurp-data/tls/privkey.pem
if [[ -f /opt/usurp-data/.env ]] && [[ -n $(docker compose --project-directory /opt/usurp-data ps -q postgres) ]]; then
    docker compose --project-directory /opt/usurp-data exec -T postgres psql -U usurp_admin -d usurp -v ON_ERROR_STOP=1 -c 'SELECT pg_reload_conf();'
fi
