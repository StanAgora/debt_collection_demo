#!/bin/sh
set -eu
# Limit replacements to characters safe in XML and sed. No default passwords.
check_value() {
  case "$2" in ''|*[!A-Za-z0-9._/-]*) echo "Invalid or missing $1" >&2; exit 1;; esac
}
ESL_LISTEN_IP=${ESL_LISTEN_IP:-0.0.0.0}
check_value ESL_LISTEN_IP "$ESL_LISTEN_IP"
check_value SIP_DOMAIN "${SIP_DOMAIN:-}"
check_value FREESWITCH_PUBLIC_IP "${FREESWITCH_PUBLIC_IP:-}"
check_value ESL_ALLOWED_CIDR "${ESL_ALLOWED_CIDR:-}"
check_value FREESWITCH_ESL_PASSWORD "${FREESWITCH_ESL_PASSWORD:-}"
check_value SIP_EXTENSION_PASSWORD "${SIP_EXTENSION_PASSWORD:-}"
umask 077
mkdir -p /tmp/demo-freeswitch-conf /var/log/freeswitch /var/lib/freeswitch/db /var/run/freeswitch
sed -e "s|@ESL_LISTEN_IP@|$ESL_LISTEN_IP|g" \
    -e "s|@SIP_DOMAIN@|$SIP_DOMAIN|g" \
    -e "s|@FREESWITCH_PUBLIC_IP@|$FREESWITCH_PUBLIC_IP|g" \
    -e "s|@ESL_ALLOWED_CIDR@|$ESL_ALLOWED_CIDR|g" \
    -e "s|@FREESWITCH_ESL_PASSWORD@|$FREESWITCH_ESL_PASSWORD|g" \
    -e "s|@SIP_EXTENSION_PASSWORD@|$SIP_EXTENSION_PASSWORD|g" \
    /opt/demo/freeswitch.xml.template > /tmp/demo-freeswitch-conf/freeswitch.xml
exec freeswitch -nf -nonat -conf /tmp/demo-freeswitch-conf \
  -log /var/log/freeswitch -db /var/lib/freeswitch/db -run /var/run/freeswitch
