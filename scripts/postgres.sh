#!/usr/bin/env bash
set -euo pipefail
pg_root=/workspace/.tools/postgresql
pg_bin="$pg_root/usr/lib/postgresql/17/bin"
pg_data="$pg_root/data"
pg_socket="$pg_root/socket"
pg_port=55432
pg_user="$(id -un)"
if [[ ! -x "$pg_bin/pg_ctl" ]]; then
  bash "$(dirname "$0")/install-postgres.sh"
fi
mkdir -p "$pg_socket"
chmod 700 "$pg_socket"
case "${1:-start}" in
  start)
    if [[ ! -f "$pg_data/PG_VERSION" ]]; then
      "$pg_bin/initdb" -D "$pg_data" -L "$pg_root/usr/share/postgresql/17" --encoding=UTF8 --locale=C.UTF-8 --auth-local=trust --auth-host=reject --username="$pg_user" > "$pg_root/init.log"
    fi
    if ! "$pg_bin/pg_ctl" -D "$pg_data" status > /dev/null 2>&1; then
      "$pg_bin/pg_ctl" -D "$pg_data" -l "$pg_root/server.log" -o "-k $pg_socket -p $pg_port -c listen_addresses=''" -w start
    fi
    if [[ $("$pg_bin/psql" -h "$pg_socket" -p "$pg_port" -U "$pg_user" -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname='tijara'") == 0 ]]; then
      "$pg_bin/createdb" -h "$pg_socket" -p "$pg_port" -U "$pg_user" tijara
    fi
    "$pg_bin/psql" -h "$pg_socket" -p "$pg_port" -U "$pg_user" -d tijara -Atc 'SELECT 1'
    ;;
  stop)
    if "$pg_bin/pg_ctl" -D "$pg_data" status > /dev/null 2>&1; then
      "$pg_bin/pg_ctl" -D "$pg_data" -m fast -w stop
    fi
    ;;
  status)
    "$pg_bin/pg_ctl" -D "$pg_data" status
    ;;
  *) printf '%s\n' 'Usage: postgres.sh start|stop|status' >&2; exit 2;;
esac
