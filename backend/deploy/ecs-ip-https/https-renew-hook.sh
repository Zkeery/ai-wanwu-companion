#!/bin/sh
set -eu
lineage=/opt/wanwu-partner/private/acme/production/config/live/101.96.210.187
[ "${RENEWED_LINEAGE:-}" = "$lineage" ] || exit 2
/usr/bin/openssl verify -verify_ip 101.96.210.187 -untrusted "$lineage/chain.pem" "$lineage/cert.pem" >/dev/null
/usr/bin/openssl x509 -in "$lineage/fullchain.pem" -noout -checkend 7200 >/dev/null
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
