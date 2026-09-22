# Build context: pinned checkout of https://github.com/NousResearch/hermes-agent
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates curl util-linux procps && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/uv && /opt/uv/bin/pip install --no-cache-dir uv==0.12.17
COPY . /opt/hermes
WORKDIR /opt/hermes
RUN /opt/uv/bin/uv sync --frozen --no-dev --extra messaging --python /usr/bin/python3 && ln -s /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes
ENV HERMES_HOME=/home/node/.hermes HERMES_GATEWAY_NO_SUPERVISE=1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER node
WORKDIR /home/node/workspace
CMD ["/bin/sleep", "infinity"]
