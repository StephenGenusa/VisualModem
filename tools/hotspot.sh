#!/usr/bin/env bash
# Visual Modem hotspot: runs this computer's Wi-Fi card as an access point
# that hands out addresses and routes traffic out the wired connection.
#
# It wraps create_ap from https://github.com/lakinduakash/linux-wifi-hotspot,
# which runs hostapd and dnsmasq and sets up NAT. NetworkManager's own hotspot
# fails with some Wi-Fi drivers, which drop the replies to a joining phone.
# hostapd does not hit that problem.
#
# Usage:
#   sudo tools/hotspot.sh start    asks for the Wi-Fi password, or reads VM_PASS
#   sudo tools/hotspot.sh stop
#   tools/hotspot.sh status        no sudo needed
#
# The computer is at 192.168.12.1 on the hotspot. Settings can be changed with
# environment variables, for example: sudo VM_CHANNEL=11 tools/hotspot.sh start
set -euo pipefail

IFACE=${VM_IFACE:-wlan0}
UPLINK=${VM_UPLINK:-eth0}
SSID=${VM_SSID:-VisualModem}
CHANNEL=${VM_CHANNEL:-6}
COUNTRY=${VM_COUNTRY:-US}
GATEWAY=${VM_GATEWAY:-192.168.12.1}

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run this with sudo." >&2
    exit 1
  fi
}

need_create_ap() {
  command -v create_ap >/dev/null || {
    echo "create_ap is not installed. See the hotspot section of the README." >&2
    exit 1
  }
}

start() {
  need_root
  need_create_ap
  if create_ap --list-running 2>/dev/null | grep -q "$IFACE"; then
    echo "A hotspot is already running on $IFACE. Stop it first." >&2
    exit 1
  fi

  local pass=${VM_PASS:-}
  if [ -z "$pass" ]; then
    read -r -s -p "Wi-Fi password for $SSID (8 to 63 characters): " pass
    echo
  fi
  if [ ${#pass} -lt 8 ] || [ ${#pass} -gt 63 ]; then
    echo "The password must be 8 to 63 characters." >&2
    exit 1
  fi

  # A NetworkManager hotspot left running would hold the card.
  nmcli connection down Hotspot >/dev/null 2>&1 || true

  create_ap --daemon --no-virt --freq-band 2.4 -c "$CHANNEL" --country "$COUNTRY" \
    --ieee80211n -g "$GATEWAY" "$IFACE" "$UPLINK" "$SSID" "$pass"

  echo "Hotspot $SSID starting on channel $CHANNEL. This computer is $GATEWAY."
  echo "Check it with: tools/hotspot.sh status"
}

stop() {
  need_root
  need_create_ap
  create_ap --stop "$IFACE"
  echo "Hotspot stopped."
}

status() {
  if command -v iw >/dev/null && iw dev "$IFACE" info 2>/dev/null | grep -q 'type AP'; then
    echo "Access point: up on $IFACE"
    iw dev "$IFACE" info | grep -E 'ssid|channel' | sed 's/^\s*/  /'
  else
    echo "Access point: not running on $IFACE"
  fi
  echo "Address: $(ip -4 -o addr show "$IFACE" 2>/dev/null | awk '{print $4}')"
  echo "Joined devices:"
  if command -v iw >/dev/null; then
    iw dev "$IFACE" station dump 2>/dev/null |
      awk '/^Station/{mac=$2} /signal:/{sig=$2} /connected time/{print "  " mac "  signal " sig " dBm  connected " $3 " s"}'
  fi
  echo "Addresses handed out:"
  ip neigh show dev "$IFACE" 2>/dev/null | sed 's/^/  /'
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "Usage: sudo $0 start|stop, or $0 status" >&2; exit 2 ;;
esac
