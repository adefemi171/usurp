#!/bin/sh
set -eu
# Pass the generated password through a private environment, not argv/logs.
USURP_APP_PASSWORD=$(cat /run/secrets/app_password)
export USURP_APP_PASSWORD
psql -v ON_ERROR_STOP=1 --username usurp_admin --dbname usurp <<'SQL'
\getenv app_password USURP_APP_PASSWORD
CREATE ROLE usurp LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
ALTER DATABASE usurp OWNER TO usurp;
REVOKE ALL ON DATABASE usurp FROM PUBLIC;
ALTER SCHEMA public OWNER TO usurp;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
unset USURP_APP_PASSWORD
