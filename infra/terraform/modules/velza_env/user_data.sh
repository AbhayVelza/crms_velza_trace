#!/bin/bash
# First boot of a Velza server (Ubuntu 24.04 on Lightsail): Docker Engine + Compose plugin, a 2 GB swap file,
# automatic security updates, fail2ban, and /srv/velza for the deploy workflow. Logs: /var/log/velza-bootstrap.log
set -euxo pipefail
exec > /var/log/velza-bootstrap.log 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get install -y ca-certificates curl gnupg unattended-upgrades fail2ban

# Docker Engine from Docker's own repository (Ubuntu's docker.io lags behind).
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

# Swap: headroom for memory spikes on the small bundles (not a substitute for RAM).
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Security updates install themselves; SSH brute force gets banned.
dpkg-reconfigure -f noninteractive unattended-upgrades
systemctl enable --now fail2ban

# Deploy target: compose.yml, Caddyfile, roles.sql and .env land here (the .env only readable by ubuntu).
install -d -m 0750 -o ubuntu -g ubuntu /srv/velza
echo "velza bootstrap complete"
