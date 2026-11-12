# BiteBox API (Django, ASGI). One image runs the API, the Celery worker and Celery beat;
# docker-compose picks the command. Python 3.12 matches CI and requires-python.
# No GDAL/GEOS needed: points are PostGIS geography columns handled in SQL (common/geo.py).

FROM python:3.12-slim-bookworm AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
WORKDIR /build
COPY requirements/ requirements/
RUN python -m venv /opt/venv && /opt/venv/bin/pip install -r requirements/prod.txt

FROM python:3.12-slim-bookworm
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=config.settings.production
RUN useradd --system --create-home --uid 10001 bitebox
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY --chown=bitebox:bitebox . .
USER bitebox
EXPOSE 8000
# Liveness only: readiness (database, Redis) is the orchestrator's /api/v1/health/ready check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/live', timeout=4).status == 200 else 1)"
ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["api"]
