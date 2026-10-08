#!/usr/bin/env bash
set -Eeuo pipefail
image=$1
kind=$2
label=${image//[:\/]/-}-${kind}
container=anthias-cycle-${label}
docker build -f tests/installer-cycle.Dockerfile --build-arg "BASE_IMAGE=$image" -t "anthias-cycle:$label" .
cleanup(){ docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$container" --privileged --cgroupns=host --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw "anthias-cycle:$label"
for attempt in {1..120}; do
 if [[ $(docker exec "$container" systemctl show basic.target -p ActiveState --value 2>/dev/null) == active ]]; then break; fi
 sleep 1
done
docker exec "$container" systemctl show basic.target -p ActiveState --value | grep -qx active
docker exec -e "AR_CYCLE_KIND=$kind" "$container" python3 /src/tests/test_install_cycle.py
