# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel, gitnexus): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.
#
# Illysium additions on top of upstream/v2:
#   - GitHub CLI (gh) — used by git-worktree MCP tools for `gh pr create`
#   - PostgreSQL + Redis clients, Python + dbt + snowflake-cli — data-team tooling
#   - gitnexus CLI (global) — code intelligence used by agents

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.119
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=latest
ARG GITNEXUS_VERSION=latest
ARG BUN_VERSION=1.3.13
ARG MMDC_VERSION=11.12.0
ARG GWS_VERSION=0.22.5
ARG CODEX_VERSION=0.124.0

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        jq \
        less \
        tini \
        unzip \
        postgresql-client \
        redis-tools \
        python3 \
        python3-pip \
        python3-venv \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi

# GitHub CLI (official apt repo). Kept in a separate layer so the dep cache
# above still hits when only gh bumps.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Data tools via isolated venvs (PEP 668 — Debian disallows system-wide pip).
# snow and dbt have conflicting transitive deps (notably on click + urllib3),
# so they live in separate venvs with symlinks on PATH. Layout mirrors v1:
#   /opt/snow-venv/bin/snow → /usr/local/bin/snow
#   /opt/dbt-venv/bin/dbt → /usr/local/bin/dbt
RUN python3 -m venv /opt/snow-venv \
    && /opt/snow-venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/snow-venv/bin/pip install --no-cache-dir snowflake-cli==3.16.0 \
    && ln -sf /opt/snow-venv/bin/snow /usr/local/bin/snow

RUN python3 -m venv /opt/dbt-venv \
    && /opt/dbt-venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/dbt-venv/bin/pip install --no-cache-dir dbt-core==1.11.8 dbt-snowflake==1.11.4 \
    && ln -sf /opt/dbt-venv/bin/dbt /usr/local/bin/dbt

# AWS CLI v2 (isolated from pip to avoid version churn)
RUN ARCH=$(uname -m) \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscli.zip /tmp/aws

# Google Cloud SDK (gcloud, gsutil) — needs gpg to verify apt repo signature
RUN apt-get update && apt-get install -y --no-install-recommends gnupg \
    && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
      > /etc/apt/sources.list.d/google-cloud-sdk.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-cloud-cli \
    && rm -rf /var/lib/apt/lists/*

# Render / Railway / Supabase CLIs (released as prebuilt binaries)
ARG RENDER_VERSION=2.15.1
ARG RAILWAY_VERSION=4.42.0
ARG SUPABASE_VERSION=2.90.0
RUN DPKG_ARCH=$(dpkg --print-architecture) && UARCH=$(uname -m) \
    && curl -fsSL "https://github.com/render-oss/cli/releases/download/v${RENDER_VERSION}/cli_${RENDER_VERSION}_linux_${DPKG_ARCH}.zip" \
       -o /tmp/render.zip \
    && unzip -q /tmp/render.zip -d /tmp/render \
    && mv /tmp/render/cli_v${RENDER_VERSION} /usr/local/bin/render \
    && chmod +x /usr/local/bin/render \
    && curl -fsSL "https://github.com/railwayapp/cli/releases/download/v${RAILWAY_VERSION}/railway-v${RAILWAY_VERSION}-${UARCH}-unknown-linux-musl.tar.gz" \
       | tar xz -C /usr/local/bin railway \
    && chmod +x /usr/local/bin/railway \
    && curl -fsSL "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_${SUPABASE_VERSION}_linux_${DPKG_ARCH}.deb" \
       -o /tmp/supabase.deb \
    && dpkg -i /tmp/supabase.deb \
    && rm -rf /tmp/render.zip /tmp/render /tmp/supabase.deb

# Chromium path for agent-browser / Playwright / mmdc consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# mmdc reuses the system Chromium instead of downloading its own.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    echo "only-built-dependencies[]=@googleworkspace/cli" >> /root/.npmrc && \
    pnpm install -g "vercel@${VERCEL_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Illysium additions: code-intelligence + diagram + Google Workspace CLIs.
# Codex CLI (@openai/codex) is invoked by /team-qa Validator E for
# cross-model adversarial review; authenticated via the host's ~/.codex
# mount (see src/container-runner.ts:581).
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "gitnexus@${GITNEXUS_VERSION}" \
        "@mermaid-js/mermaid-cli@${MMDC_VERSION}" \
        "@googleworkspace/cli@${GWS_VERSION}" \
        "@openai/codex@${CODEX_VERSION}"

# Puppeteer config used by mmdc — points at the system Chromium and passes
# --no-sandbox, without which mmdc launches and silently exits 0 producing no
# output on Debian containers that lack unprivileged user namespaces.
COPY puppeteer-config.json /app/puppeteer-config.json

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
# Remap the `node` user+group to UID/GID 1001 before any chowns so the
# container's runtime UID matches the host's non-root user. Host-side
# processes (setup scripts, group-init, systemd unit user) run as UID 1001,
# and host-owned bind mounts — notably `.claude-shared/` at /home/node/.claude
# — arrive in the container at UID 1001. Without this remap, the container's
# `node` (UID 1000) can *read* those dirs under 755 perms but can't *write*,
# which silently freezes Claude Code auto-memory and autodream pruning. The
# base image's UID 1000 is arbitrary; no baked dir hard-codes it.
ARG HOST_UID=1001
ARG HOST_GID=1001
RUN groupmod -g ${HOST_GID} node && usermod -u ${HOST_UID} -g ${HOST_GID} node && \
    mkdir -p /workspace/group /workspace/global /workspace/extra && \
    chown -R ${HOST_UID}:${HOST_GID} /workspace /home/node && \
    chmod 755 /home/node

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
