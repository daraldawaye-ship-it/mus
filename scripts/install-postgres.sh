#!/usr/bin/env bash
set -euo pipefail
# Packages are verified against the signed Debian repository; no trust/TLS bypass.
pg_root=/workspace/.tools/postgresql
apt_root=/workspace/.tools/pg-apt
if [[ -x "$pg_root/usr/lib/postgresql/17/bin/postgres" ]]; then exit 0; fi
mkdir -p "$apt_root/lists/partial" "$apt_root/archives/partial" "$apt_root/empty" "$pg_root"
cat > "$apt_root/apt.conf" <<CONFIG
Dir::Etc::parts "$apt_root/empty";
Dir::Etc::main "$apt_root/empty/main";
Dir::Etc::sourcelist "$apt_root/sources.list";
Dir::Etc::sourceparts "$apt_root/empty";
Dir::State::lists "$apt_root/lists";
Dir::Cache::archives "$apt_root/archives";
APT::Sandbox::User "$(id -un)";
CONFIG
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main' > "$apt_root/sources.list"
APT_CONFIG="$apt_root/apt.conf" /usr/bin/apt-get update
cd "$apt_root/archives"
APT_CONFIG="$apt_root/apt.conf" /usr/bin/apt-get download postgresql-17 postgresql-client-17
for package_file in postgresql-17_*.deb postgresql-client-17_*.deb; do
  dpkg-deb --extract "$package_file" "$pg_root"
done
"$pg_root/usr/lib/postgresql/17/bin/postgres" --version
