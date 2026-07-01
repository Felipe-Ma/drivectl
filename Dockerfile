FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml requirements.txt ./
COPY backend/ backend/
RUN pip install --no-cache-dir .

ENV DRIVECTL_HOST=0.0.0.0 \
    DRIVECTL_PORT=8722 \
    DRIVECTL_DATA_DIR=/data

VOLUME /data
EXPOSE 8722

CMD ["python", "-m", "drivectl"]
