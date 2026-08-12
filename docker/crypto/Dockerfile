# Crypto worker image (python crypto tooling).
FROM python:3.12-slim

RUN pip install --no-cache-dir \
      pycryptodome pwntools z3-solver sympy gmpy2

WORKDIR /workspace
ENTRYPOINT ["/bin/bash"]
