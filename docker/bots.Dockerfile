# Every bot in bots/. Dependencies only: the repo is bind-mounted read-only
# at /app, and the client is imported from clients/python.
FROM python:3.12-slim-bookworm
COPY bots/featurebot/requirements.txt /tmp/featurebot.txt
COPY bots/segmentbot/requirements.txt /tmp/segmentbot.txt
RUN pip install --no-cache-dir -r /tmp/featurebot.txt -r /tmp/segmentbot.txt
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/clients/python \
    NUMBA_CACHE_DIR=/tmp/numba
WORKDIR /app
