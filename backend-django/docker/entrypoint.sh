#!/bin/sh
# Usage: entrypoint.sh api | worker | beat | migrate | <any command>
# Migrations run as a separate one-off step ("migrate"), never on every API start, so several
# API instances can start at once and a failed migration stops the release, not the running app.
set -e

case "$1" in
  api)
    exec uvicorn config.asgi:application \
      --host 0.0.0.0 --port 8000 \
      --workers "${WEB_CONCURRENCY:-2}" \
      --proxy-headers --forwarded-allow-ips="${FORWARDED_ALLOW_IPS:-*}" \
      --no-server-header
    ;;
  worker)
    exec celery -A config worker --loglevel "${LOG_LEVEL:-INFO}" --concurrency "${CELERY_CONCURRENCY:-2}"
    ;;
  beat)
    # Exactly one beat process per environment.
    exec celery -A config beat --loglevel "${LOG_LEVEL:-INFO}" --schedule /tmp/celerybeat-schedule
    ;;
  migrate)
    exec python manage.py migrate --noinput
    ;;
  *)
    exec "$@"
    ;;
esac
