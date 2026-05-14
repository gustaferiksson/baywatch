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
    tmux \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (read-only at runtime via GITHUB_TOKEN with restricted scopes)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# UTF-8 locale so claude's TUI renders block/box-drawing chars instead of
# falling back to ASCII. C.UTF-8 is built into Debian 11+ — no `locale-gen`
# needed. Applies to every process in the container (incl. tmux + claude).
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# Rename the base image's "node" user (UID 1000) to "agent" so --userns=keep-id
# in Podman maps host UID → container "agent" with the right home dir owner.
RUN usermod -d /home/agent -m -l agent node
USER agent
WORKDIR /home/agent

# Make ~/.claude/ exist so baywatch can bind-mount settings.json into it at runtime.
# Sessions claude-code writes (~/.claude/projects/...) stay in the container's writable
# filesystem alongside the read-only settings.json mount.
RUN mkdir -p /home/agent/.claude

# Minimal tmux config so `baywatch session attach` drops into a clean claude TUI:
#   - status bar off (claude has its own status line; the tmux green/yellow bar
#     would clash and waste a screen row)
#   - default-terminal screen-256color (widely supported, gives 256 colors)
#   - terminal-overrides forwarding truecolor (`Tc`) when the outer terminal
#     supports it, so claude's syntax highlighting renders correctly
#   - mouse on for scroll/copy convenience
RUN printf '%s\n' \
    'set -g status off' \
    '# xterm-256color advertises mouse + scroll-wheel terminfo so trackpad' \
    '# scrolling actually reaches tmux. screen-256color silently swallows it.' \
    'set -g default-terminal "xterm-256color"' \
    'set -ga terminal-overrides ",xterm-256color:Tc"' \
    'set -g mouse on' \
    'set -g history-limit 50000' \
    '' \
    '# Ctrl+C detaches the tmux client without killing claude. The session stays' \
    '# alive in the container; reattach with `baywatch session attach <id>`. Use' \
    '# `baywatch session stop` / `rm` from outside to actually end a session.' \
    '# Inside claude, ESC still cancels in-flight generation.' \
    'bind-key -n C-c detach-client' \
    > /home/agent/.tmux.conf

# Claude Code CLI (the agent the run uses)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Bun — many of the maintainer's repos use it for install / dev / test
RUN curl -fsSL https://bun.sh/install | bash

ENV PATH="/home/agent/.local/bin:/home/agent/.bun/bin:$PATH"

# In bind-mount mode (head strategy), sandcastle overrides cwd to the worktree
# at container start. Sleep here keeps the container alive for sandcastle to exec into.
ENTRYPOINT ["sleep", "infinity"]
