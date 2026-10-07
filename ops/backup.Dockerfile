# PostgreSQL client tools (pg_dump / pg_restore) plus the AWS CLI for optional off-site copies to S3-compatible storage.
FROM postgres:16
RUN apt-get update \
 && apt-get install -y --no-install-recommends awscli ca-certificates \
 && rm -rf /var/lib/apt/lists/*
