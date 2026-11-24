# featurebot (bots/featurebot). Dependencies only: the repo is bind-mounted
# read-only at /app, and the client is imported from clients/python.
FROM python:3.12-slim-bookworm
COPY bots/featurebot/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/clients/python \
    NUMBA_CACHE_DIR=/tmp/numba
WORKDIR /app
