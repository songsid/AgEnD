# Build the application first, then build this image explicitly from the checkout root.
# No image is built or pulled when a Hub question arrives.
FROM node:22-bookworm
RUN npm install --prefix /opt/cli --ignore-scripts --no-audit --no-fund \
    @anthropic-ai/claude-code@2.1.316 @openai/codex@0.166.0 \
    && rm -rf /root/.npm
COPY dist/hub/execution/sandbox-runner.js /opt/agend/sandbox-runner.js
COPY dist/child-process.js /child-process.js
RUN printf '{"type":"module"}\n' > /opt/package.json && printf '{"type":"module"}\n' > /package.json
LABEL org.agend.hub.protocol="1" org.agend.hub.claude="2.1.316" org.agend.hub.codex="0.166.0"
USER 65532:65532
WORKDIR /scratch
ENTRYPOINT ["/usr/local/bin/node", "/opt/agend/sandbox-runner.js"]
