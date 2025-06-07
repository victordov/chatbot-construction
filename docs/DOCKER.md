# Docker Setup for MongoDB

This document explains how to use Docker to run MongoDB instances for the Chatbot Construction application.

## Overview

The project includes a Docker Compose configuration that sets up two MongoDB containers:

1. **Main MongoDB** - For application development and production use
2. **Test MongoDB** - For running tests

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

## Container Details

### Main MongoDB Container
- **Container Name**: chatbot-mongodb
- **Port**: 27017 (mapped to host port 27017)
- **Database**: chatbot
- **Connection String**: `mongodb://localhost:27017/chatbot`

### Test MongoDB Container
- **Container Name**: chatbot-mongodb-test
- **Port**: 27017 (mapped to host port 27018)
- **Database**: chatbot-test
- **Connection String**: `mongodb://localhost:27018/chatbot-test`

## Usage

### Starting the Containers

To start both MongoDB containers:

```bash
docker-compose up -d
```

This will start the containers in detached mode (running in the background).

### Stopping the Containers

To stop the containers:

```bash
docker-compose down
```

To stop the containers and remove the volumes (this will delete all data):

```bash
docker-compose down -v
```

### Checking Container Status

To see if the containers are running:

```bash
docker-compose ps
```

### Viewing Container Logs

To view logs from the containers:

```bash
# For main MongoDB
docker-compose logs mongodb

# For test MongoDB
docker-compose logs mongodb-test
```

## Connecting to MongoDB

### From the Application

The application should use the following connection strings:

- **Main Database**: `mongodb://localhost:27017/chatbot`
- **Test Database**: `mongodb://localhost:27018/chatbot-test`

These are already configured in the `.env.example` file.

### Using MongoDB CLI

To connect to the MongoDB instances using the MongoDB shell:

```bash
# Connect to main MongoDB
docker exec -it chatbot-mongodb mongosh

# Connect to test MongoDB
docker exec -it chatbot-mongodb-test mongosh
```

## Data Persistence

The Docker Compose configuration uses named volumes to persist data:

- `mongodb_data`: Stores data for the main MongoDB instance
- `mongodb_test_data`: Stores data for the test MongoDB instance

This means your data will be preserved even if you stop and restart the containers.

## Troubleshooting

### Port Conflicts

If you already have MongoDB running on your host machine on port 27017, you may see port conflict errors. You can either:

1. Stop your local MongoDB service before starting the containers
2. Modify the `docker-compose.yml` file to use different host ports

### Connection Issues

If your application cannot connect to MongoDB, check that:

1. The containers are running (`docker-compose ps`)
2. You're using the correct connection strings
3. There are no network issues or firewall rules blocking the connections