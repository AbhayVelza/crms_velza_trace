# Nightly off-site backups (the `backup` container): pg_dump of the database and a copy of the damage photos to the
# object-storage bucket. The managed database keeps its own automatic backups; this is the copy we control.
# pg_dump must be at least the server's major version, so this follows the database (PostgreSQL 16 on Lightsail).
FROM postgres:16-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends awscli curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/aws/rds-global-bundle.pem
RUN chmod 644 /etc/ssl/aws/rds-global-bundle.pem
COPY backup.sh /usr/local/bin/velza-backup
RUN chmod 755 /usr/local/bin/velza-backup

USER postgres
ENTRYPOINT ["velza-backup"]
CMD ["loop"]
