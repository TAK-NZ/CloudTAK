# https://hub.docker.com/_/nginx
FROM nginx:alpine3.24

EXPOSE 5000

ENV HOME=/home/etl
WORKDIR $HOME

# Data source configuration
ARG DATA_SOURCE_URL=https://github.com/dfpc-coe/CloudTAK-Data/archive/refs/tags/v1.2.0.zip
ARG API_URL
ARG USE_LOCAL_ZIP=false
ARG WEB_PLUGINS

RUN apk add --no-cache git nodejs-current npm python3 make bash g++ openssl postgresql-client grep wget unzip perf

WORKDIR $HOME/api

ADD package.json ./
ADD package-lock.json ./

# `npm ci` rather than `npm install`, here and for web/ below.
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
RUN npm ci

COPY ./ $HOME/api

RUN WEB_PLUGINS="$WEB_PLUGINS" node bin/plugin.ts

RUN cd web \
    && npm ci \
    && npm run lint \
    && npm run check \
    && npm run build \
    && cd ..

RUN npm run lint \
    && npm run build \
    && if [ "$USE_LOCAL_ZIP" = "true" ]; then \
        cp data.zip data.zip.tmp; \
    else \
        wget -O data.zip.tmp "$DATA_SOURCE_URL"; \
    fi \
    && unzip data.zip.tmp \
    && mkdir -p dist/data \
    && cp -r CloudTAK-Data-*/* dist/data/ \
    && rm -rf data.zip.tmp CloudTAK-Data-*

CMD ["./start"]
