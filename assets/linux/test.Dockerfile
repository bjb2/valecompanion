FROM oven/bun:1.4.0-debian AS bun
FROM node:22-bookworm-slim AS node
FROM ubuntu:22.04 AS build

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip xz-utils python3 make g++ \
    libpcap0.8 libcap2-bin libarchive-tools rpm xvfb xauth \
    libgtk-3-0 libnss3 libasound2 libgbm1 libdrm2 \
    wireshark-common sudo file dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN useradd --create-home --uid 1000 tester
WORKDIR /workspace
COPY package.json bun.lock tsconfig.json LICENSE NOTICE SOURCE-OFFER.txt ./
COPY src ./src
COPY packages ./packages
COPY test ./test
COPY assets ./assets
COPY docs ./docs
RUN bun install --frozen-lockfile && bun run check && bun run package:linux && bun run src/verify-release.ts

CMD ["bash", "assets/linux/test-packages.sh"]
