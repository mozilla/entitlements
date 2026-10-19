#!/usr/bin/env bash

set -e

COMPOSE_FILE="./docker-compose-development.yaml"
APP_SERVICES="api metering-subscriber metering-sweep"
INFRA_SERVICES="clickhouse redis firebase"

case "${1:-}" in
  logs)
    shift
    docker compose -f "$COMPOSE_FILE" logs "$@"
    ;;

  logs-apps)
    docker compose -f "$COMPOSE_FILE" logs -f $APP_SERVICES
    ;;

  logs-infra)
    docker compose -f "$COMPOSE_FILE" logs -f $INFRA_SERVICES
    ;;

  up)
    docker compose -f "$COMPOSE_FILE" stop
    docker compose -f "$COMPOSE_FILE" build api
    docker compose -f "$COMPOSE_FILE" up -d
    ;;

  infra)
    docker compose -f "$COMPOSE_FILE" up -d clickhouse-migrate $INFRA_SERVICES
    ;;

  migrate)
    docker compose -f "$COMPOSE_FILE" run --rm clickhouse-migrate
    ;;

  cms-codegen)
    docker compose -f "$COMPOSE_FILE" run --rm --no-deps api pnpm nx run shared-cms:codegen
    ;;

  down)
    docker compose -f "$COMPOSE_FILE" down
    ;;

  stop)
    docker compose -f "$COMPOSE_FILE" stop
    ;;

  restart)
    shift
    docker compose -f "$COMPOSE_FILE" restart "$@"
    ;;

  ps)
    docker compose -f "$COMPOSE_FILE" ps
    ;;

  exec)
    shift
    docker compose -f "$COMPOSE_FILE" exec "$@"
    ;;

  *)
    echo "Usage: $0 {logs|logs-apps|logs-infra|up|infra|migrate|cms-codegen|down|stop|restart|ps|exec}"
    echo ""
    echo "Commands:"
    echo "  logs <args>       - Show logs for a service or services"
    echo "  logs-apps         - Follow logs for the api, subscriber, and sweep"
    echo "  logs-infra        - Follow logs for ClickHouse, Redis, and the Firebase emulators"
    echo "  up                - Build the dev image and start everything"
    echo "  infra             - Start only infrastructure and run ClickHouse migrations"
    echo "  migrate           - Run ClickHouse migrations"
    echo "  cms-codegen       - Regenerate Strapi GraphQL types using STRAPI_* settings from dev.env/dev.local.env"
    echo "  down              - Stop and remove containers"
    echo "  stop              - Stop containers"
    echo "  restart [svc...]  - Restart all or the given services"
    echo "  ps                - Show running containers"
    echo "  exec <args>       - Execute command in container"
    exit 1
    ;;
esac
