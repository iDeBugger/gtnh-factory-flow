# Base images by digest and Node by version and checksum: the image is rebuilt on every
# build-datasets.mjs run, and a drifting zlib or Node would change the datasets' gzip bytes.
FROM azul/zulu-openjdk:17@sha256:67d8dffdd0efed237b51ac931eb9812bb2397b4c554a60df2a5e9819f340acb2 AS jdk17
FROM eclipse-temurin:25-jdk-jammy@sha256:07a4ee373cd86f337e62cb8149f1e0a9f08aaf3a18c27509a493dda119fb480c AS jdk25

FROM eclipse-temurin:21-jdk-jammy@sha256:742daacb9316be4b6fc60258f6e4ac2a11882f6c597373c92290a57bfad0d2e0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    libasound2 \
    libegl1 \
    libgl1 \
    libgl1-mesa-dri \
    libglx-mesa0 \
    libopenal1 \
    libx11-6 \
    libxcursor1 \
    libxext6 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxtst6 \
    libxxf86vm1 \
    mesa-utils \
    unzip \
    xauth \
    xvfb \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=22.23.4
ARG NODE_SHA256_ARM64=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b
ARG NODE_SHA256_X64=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
RUN set -eu; \
  case "$(dpkg --print-architecture)" in \
    arm64) arch=arm64; sum="$NODE_SHA256_ARM64" ;; \
    amd64) arch=x64; sum="$NODE_SHA256_X64" ;; \
    *) echo "no Node build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac; \
  file="node-v${NODE_VERSION}-linux-${arch}.tar.xz"; \
  curl -fsSLo "/tmp/$file" "https://nodejs.org/dist/v${NODE_VERSION}/$file"; \
  echo "$sum  /tmp/$file" | sha256sum -c -; \
  tar -xJf "/tmp/$file" -C /usr/local --strip-components=1 --exclude CHANGELOG.md --exclude LICENSE --exclude README.md; \
  rm "/tmp/$file"; \
  node --version

WORKDIR /workspace
COPY --from=jdk17 /usr/lib/jvm /opt/java/jvm17
COPY --from=jdk25 /opt/java/openjdk /opt/java/jdk-25
CMD ["bash"]
