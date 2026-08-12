# Linux forensic worker image (misc solver tools).
# Used by the Tool Runtime when Docker is available; the control plane
# itself runs natively on Windows/macOS/Linux.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      file binutils unzip p7zip-full xz-utils \
      tshark tcpdump netcat-openbsd curl \
      imagemagick exiftool ffmpeg \
      && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      pycryptodome pwntools z3-solver pillow numpy

WORKDIR /workspace
# Only the current challenge workspace is mounted here.
ENTRYPOINT ["/bin/bash"]
