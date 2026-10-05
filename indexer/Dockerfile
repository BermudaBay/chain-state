FROM oven/bun:1.3.5-debian AS installer
WORKDIR /indexer

ARG GLOBAL_CHECKOUT_TOKEN

RUN apt update && \
  apt install -y git

COPY package.json bun.lock ./

# update git urls so bun can download our private repositories
RUN git config --global url."https://$GLOBAL_CHECKOUT_TOKEN:x-oauth-basic@github.com/".insteadOf "https://github.com/" && \
  git config --global url."https://$GLOBAL_CHECKOUT_TOKEN:x-oauth-basic@github.com/".insteadOf "ssh://git@github.com/"

RUN bun install --frozen-lockfile --ignore-scripts --production

FROM oven/bun:1.3.5-debian
WORKDIR /indexer
COPY --from=installer /indexer/node_modules node_modules
COPY package.json ./
COPY src src

# The database lives on a volume. Docker seeds a fresh named volume's ownership from the image
# directory, so the directory is owned by the non-root user before VOLUME; otherwise sqlite
# cannot create its file there.
RUN mkdir -p /data && \
  chown -R bun:bun /data
VOLUME /data

ENV DB_PATH=/data/indexer.sqlite \
  PORT=4200

USER bun
EXPOSE 4200/tcp
ENTRYPOINT [ "bun", "run", "src/main.ts" ]
