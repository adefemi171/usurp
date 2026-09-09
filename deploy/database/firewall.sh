#!/bin/bash
# Touch only the Usurp chain and the exact public IP/port jump. Never flush
# DOCKER-USER, alter host SSH rules, or change other services' traffic.
set -euo pipefail
iptables -w -N DOCKER-USER 2>/dev/null || iptables -w -S DOCKER-USER >/dev/null
iptables -w -N USURP_PG_INGRESS 2>/dev/null || iptables -w -S USURP_PG_INGRESS >/dev/null
for source in 74.220.48.0/24 74.220.56.0/24; do
    iptables -w -C USURP_PG_INGRESS -s "$source" -j ACCEPT 2>/dev/null ||
      iptables -w -I USURP_PG_INGRESS 1 -s "$source" -j ACCEPT
done
iptables -w -C USURP_PG_INGRESS -j DROP 2>/dev/null || iptables -w -A USURP_PG_INGRESS -j DROP
iptables -w -C DOCKER-USER -i ens3 -p tcp -m conntrack --ctorigdst 51.210.106.93 --ctorigdstport 15433 -j USURP_PG_INGRESS 2>/dev/null ||
  iptables -w -I DOCKER-USER 1 -i ens3 -p tcp -m conntrack --ctorigdst 51.210.106.93 --ctorigdstport 15433 -j USURP_PG_INGRESS
# No AAAA record or IPv6 Docker binding is configured. Defense in depth for
# this exact port if a future Docker change accidentally publishes it on v6.
ip6tables -w -N DOCKER-USER 2>/dev/null || ip6tables -w -S DOCKER-USER >/dev/null
ip6tables -w -C DOCKER-USER -i ens3 -p tcp -m conntrack --ctorigdstport 15433 -j DROP 2>/dev/null ||
  ip6tables -w -I DOCKER-USER 1 -i ens3 -p tcp -m conntrack --ctorigdstport 15433 -j DROP
echo 'Usurp-only Docker ingress rules installed.'
