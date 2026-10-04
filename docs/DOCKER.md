# Running with Docker

`docker-compose.yml` runs the application and its database. There is no
separate test database any more: `npm test` starts an in-memory MongoDB by
itself (`mongodb-memory-server`), so nothing in Compose is needed for tests.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin
  (`docker compose`, v2).

## Services

| Service   | Image                     | Purpose |
| --------- | ------------------------- | ------- |
| `app`     | built from `./Dockerfile` | The platform, on host port 3000. |
| `mongodb` | `mongo:7`                 | The database, on host port 27017, data in the `mongodb_data` volume. |
| `redis`   | `redis:7-alpine`          | Optional, profile `redis`. Only needed with more than one app instance. |

The `app` service:

- reads `.env` (`env_file`), then overrides `MONGODB_URI` with
  `mongodb://mongodb:27017/chatbot` so it finds the container rather than
  localhost;
- waits for MongoDB's healthcheck before starting;
- mounts the `uploads` and `backups` volumes over `/app/uploads` and
  `/app/backups`, because chat attachments and backups are written to local
  disk and a rebuild would otherwise discard them;
- restarts unless stopped.

## Usage

```sh
cp .env.example .env        # fill in JWT_SECRET, SESSION_SECRET, OPENAI_API_KEY ...
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

Stop with `docker compose down`; add `-v` to delete the volumes (database,
uploads and backups) as well.

To run with Redis for a multi-instance setup, start the profile and set
`REDIS_URL` on the app:

```sh
# in .env, or uncomment the line in docker-compose.yml
REDIS_URL=redis://redis:6379

docker compose --profile redis up -d --build
```

`REDIS_URL` switches socket.io to its Redis adapter so operators and visitors
connected to different instances can reach each other. Scale the app with
`docker compose up -d --scale app=3` only after removing the fixed
`container_name` and host port from the `app` service, and set
`SCHEDULER_ENABLED=false` on all but one instance (see the README).

## The image

`Dockerfile` is a two-stage build on `node:20-alpine`:

1. `deps` runs `npm ci --omit=dev`. `bcrypt` and `pdf-parse` ship prebuilt
   musl binaries, so no compiler is installed; a commented `apk add` line is
   there if a future dependency needs one.
2. `runtime` copies the source and `node_modules`, creates `logs/`,
   `uploads/` and `backups/` owned by the unprivileged `node` user, sets
   `NODE_ENV=production`, exposes 3000, and declares a `HEALTHCHECK` that
   fetches `/health` with `wget`.

`.dockerignore` keeps `.env`, `node_modules`, tests, docs, logs, uploads and
backups out of the build context. The image never contains a real `.env`;
configuration is passed at run time.

Whole-database backups (`BACKUPS_ENABLED=true`) shell out to `mongodump`,
which is not in the image. Uncomment `RUN apk add --no-cache mongodb-tools` in
the Dockerfile if you use them. Per-tenant backups
(`TENANT_BACKUPS_ENABLED=true`) are document exports and need nothing extra.

Build the image on its own with `npm run docker:build`.

## Connecting to MongoDB

- From the app container: `mongodb://mongodb:27017/chatbot` (set by Compose).
- From the host, for example with a GUI or `mongosh`:
  `mongodb://localhost:27017/chatbot`.
- Shell: `docker exec -it chatbot-mongodb mongosh chatbot`.

## Troubleshooting

- **Port 27017 or 3000 already in use**: stop the local service or change the
  host side of the port mapping in `docker-compose.yml`.
- **`app` exits immediately**: `docker compose logs app`. In production mode
  the server refuses to start without `JWT_SECRET`, `SESSION_SECRET` (32+
  characters) and `OPENAI_API_KEY`; the message names the variable.
- **`app` is up but `/ready` returns 503**: MongoDB is not reachable yet, or
  `MONGODB_URI` was overridden to something other than the container name.
- **Uploads vanish after `docker compose down -v`**: `-v` deletes the
  volumes. Omit it, or back the volumes up first.
