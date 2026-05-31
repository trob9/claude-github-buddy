#!/bin/bash

# Change to the directory containing this script
cd "$(dirname "$0")"

PID_FILE="server/server.pid"

# HTTP port: default to the extension's (47382); honour an .env override.
HTTP_PORT=47382
ENV_FILE="$(dirname "$0")/.env"
if [ -f "$ENV_FILE" ]; then
    _p=$(grep -E '^HTTP_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '[:space:]')
    [ -n "$_p" ] && HTTP_PORT="$_p"
fi

if [ ! -f "$PID_FILE" ]; then
    echo "❌ Server is not running"
    exit 1
fi

PID=$(cat "$PID_FILE")

if ps -p "$PID" > /dev/null 2>&1; then
    echo "✅ Server is running (PID: $PID)"

    # Show process info
    echo ""
    echo "Process info:"
    ps -p "$PID" -o pid,etime,rss,command

    # Try to check if the HTTP port is listening
    if lsof -i :"$HTTP_PORT" > /dev/null 2>&1; then
        echo ""
        echo "✅ Listening on port $HTTP_PORT"
    else
        echo ""
        echo "⚠️  Port $HTTP_PORT is not listening (server may have issues)"
    fi

    exit 0
else
    echo "❌ Server is not running (stale PID file)"
    echo "Run ./stop_server.command to clean up"
    exit 1
fi
