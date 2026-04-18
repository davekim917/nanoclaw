# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium + agent tooling
# (Phase 1.5 base image: Illysium critical-path tools. Niche tools like
# gcloud, AWS, mermaid-cli, ffmpeg go in per-group container.json via
# install_packages.)
RUN apt-get update && apt-get install -y \
    # Chromium runtime
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
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
    # Core CLI tooling
    curl \
    git \
    jq \
    less \
    ca-certificates \
    # Data platform clients
    postgresql-client \
    redis-tools \
    # Python runtime (for dbt, snowflake-cli, data analysis)
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (official apt repo)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Data tools via isolated venv (PEP 668 — Debian disallows system-wide pip).
# Exposed on PATH so agents use `dbt` / `snow` without activating the venv.
ENV DATA_TOOLS_VENV=/opt/data-tools
ENV PATH="${DATA_TOOLS_VENV}/bin:${PATH}"
RUN python3 -m venv "${DATA_TOOLS_VENV}" \
    && "${DATA_TOOLS_VENV}/bin/pip" install --no-cache-dir --upgrade pip setuptools wheel \
    && "${DATA_TOOLS_VENV}/bin/pip" install --no-cache-dir \
        dbt-core \
        dbt-snowflake \
        snowflake-cli-labs

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, and platform CLIs globally (npm)
RUN npm install -g \
        agent-browser \
        @anthropic-ai/claude-code \
        vercel \
        gitnexus

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra

# Install entrypoint script.
# The host mounts container/agent-runner/src at /app/src and the entrypoint
# recompiles on startup — this lets host source edits and skill installs
# take effect without rebuilding the image. All IO goes through the session
# DBs (inbound.db / outbound.db) mounted into /workspace.
#
# Lives at container/entrypoint.sh so behavior changes don't require
# editing a RUN printf in the Dockerfile.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]
