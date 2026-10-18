FROM rust:1.90.0-bookworm AS builder
RUN apt-get update && apt-get install -y git cmake protobuf-compiler && rm -rf /var/lib/apt/lists/*
WORKDIR /source
RUN git init && git remote add origin https://github.com/scsibug/nostr-rs-relay.git && git fetch --depth 1 origin b5c1f642e4f4c3b9c54f5d18d66f4c53642076b4 && git checkout --detach FETCH_HEAD
COPY community-policy.patch /policy.patch
COPY backup-policy.patch /backup.patch
COPY onboarding-policy.patch /onboarding.patch
RUN git apply --check /policy.patch && git apply /policy.patch && git apply --check /backup.patch && git apply /backup.patch && git apply --check /onboarding.patch && git apply /onboarding.patch && cargo build --release --locked
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home relay && mkdir /data && chown relay /data
COPY --from=builder /source/target/release/nostr-rs-relay /usr/local/bin/nostr-rs-relay
USER 10001
WORKDIR /data
ENV RUST_LOG=off
ENTRYPOINT ["nostr-rs-relay", "--config", "/etc/relay/config.toml", "--db", "/data"]
