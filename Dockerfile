FROM alpine:3.24 AS data

ARG DATA_SOURCE_URL=https://github.com/dfpc-coe/CloudTAK-Data/archive/refs/tags/v1.2.0.zip
ARG USE_LOCAL_ZIP=false

WORKDIR /tmp/data

COPY api/data.zip* ./

RUN if [ "$USE_LOCAL_ZIP" != "true" ]; then wget -O data.zip "$DATA_SOURCE_URL"; fi \
    && unzip data.zip \
    && mkdir /data \
    && cp -r CloudTAK-Data-*/* /data/

# https://hub.docker.com/_/nginx
FROM nginx:alpine3.24

EXPOSE 5000

ENV HOME=/home/etl
WORKDIR $HOME

ARG API_URL
ARG WEB_PLUGINS

RUN apk add --no-cache git nodejs-current npm python3 make bash g++ openssl postgresql-client grep wget unzip perf

# TAK-NZ: `npm ci` rather than upstream's `npm install`, for both api/ and app/.
#
# The lockfiles are committed, but `npm install` is free to resolve newer
# versions inside the declared ranges and rewrite the lock during the build - so
# the committed lock was not authoritative and two builds of the same commit
# could differ. That is how maplibre-gl 6.4.1 arrived under `^6.0.0` and broke
# vector-basemap hillshading and flooded the console with source-layer warnings,
# with no commit of ours to point at.
#
# `npm ci` installs exactly the lockfile, so a commit always builds the same way,
# while upstream stays free to bump ranges whenever it likes. It also fails the
# build if the lock and package.json disagree, which is where we want to find
# that out.
WORKDIR $HOME/api

ADD api/package.json ./
ADD api/package-lock.json ./

RUN npm ci

WORKDIR $HOME/app

ADD app/package.json ./
ADD app/package-lock.json ./

RUN npm ci

COPY api/ $HOME/api/
COPY app/ $HOME/app/

WORKDIR $HOME/api

RUN WEB_PLUGINS="$WEB_PLUGINS" node bin/plugin.ts

RUN cd ../app \
    && npm run lint \
    && npm run check \
    && npm run build

RUN npm run lint \
    && npm run build

COPY --from=data /data/ dist/data/

CMD ["./start"]
