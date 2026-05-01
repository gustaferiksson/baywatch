# Shared image used for every baywatch agent run, regardless of which target repo
# is bind-mounted in. Build once with: `podman build -t baywatch-agent .`
#
# UID 1000 / GID 1000 must match the Podman --userns=keep-id assumption in
# sandcastle's podman provider. Don't change without also setting the matching
# containerUid/containerGid in podman({...}) on the JS side.

FROM node:22-bookworm

# System deps
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (read-only at runtime via GITHUB_TOKEN with restricted scopes)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Rename the base image's "node" user (UID 1000) to "agent" so --userns=keep-id
# in Podman maps host UID → container "agent" with the right home dir owner.
RUN usermod -d /home/agent -m -l agent node
USER agent
WORKDIR /home/agent

# Claude Code CLI (the agent the run uses)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Bun — many of the maintainer's repos use it for install / dev / test
RUN curl -fsSL https://bun.sh/install | bash

ENV PATH="/home/agent/.local/bin:/home/agent/.bun/bin:$PATH"

# In bind-mount mode (head strategy), sandcastle overrides cwd to the worktree
# at container start. Sleep here keeps the container alive for sandcastle to exec into.
ENTRYPOINT ["sleep", "infinity"]
