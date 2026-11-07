#!/bin/sh
set -eu
cat >/dev/null
test -z "${IDAS_TEST_SECRET:-}"
test "$(ls /sys/class/net)" = lo
test ! -e /var/run/docker.sock
if (echo forbidden > /tmp/idas-test) 2>/dev/null; then exit 2; fi
printf '%s\n' '{"readOnly":true,"noNetwork":true,"noSecret":true}'
