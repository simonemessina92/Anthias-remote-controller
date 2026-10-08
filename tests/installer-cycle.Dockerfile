ARG BASE_IMAGE=debian:trixie
FROM ${BASE_IMAGE}
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d \
 && apt-get update && apt-get install -y systemd-sysv dbus python3 curl iproute2 \
 && rm -f /usr/sbin/policy-rc.d
COPY . /src
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
