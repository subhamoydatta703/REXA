# sandbox.Dockerfile
FROM ubuntu:22.04

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        git \
        nodejs \
        npm \
        python3 \
        ca-certificates \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root sandbox user
RUN useradd -m -u 1000 -s /bin/bash sandbox

USER sandbox
# Configure Git to trust the mounted workspace directory
RUN git config --global --add safe.directory /app

RUN curl -fsSL https://bun.com/install | bash
ENV PATH="/home/sandbox/.bun/bin:${PATH}"

WORKDIR /app

CMD ["tail", "-f", "/dev/null"]
