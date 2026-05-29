# Cloud Run Job image for the dashboard refresh pipeline.
# Build context = the leadsquared project ROOT (so _dm_*.py + template are included).
# .gcloudignore MUST exclude .env, **/_sa.json, snapshots/, dm_site/, /tmp (secrets/PII).
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir google-api-python-client google-auth google-cloud-storage
# copy pipeline code (root scripts + automation helpers + engine template)
COPY _dm_extract_lsq.py _dm_engine.py _dm_dashdata.py _dm_enrich.py _dm_build_authsite.py dashboard_template.html /app/
COPY automation/ /app/automation/
ENV MODE=hourly
ENTRYPOINT ["python", "automation/cloudrun/run.py"]
