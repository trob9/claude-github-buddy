#!/bin/bash

# Change to the directory containing this script
cd "$(dirname "$0")"

PID_FILE="server/server.pid"
STOPPED_ANY=false

# Try to stop daemon server (via PID file)
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")

    if ps -p "$PID" > /dev/null 2>&1; then
        echo "🛑 Stopping daemon server (PID: $PID)..."
        kill "$PID"

        # Wait up to 5 seconds for graceful shutdown
        for i in {1..5}; do
            if ! ps -p "$PID" > /dev/null 2>&1; then
                break
            fi
            sleep 1
        done

        # Force kill if still running
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "⚠️  Forcing shutdown..."
            kill -9 "$PID"
        fi

        rm "$PID_FILE"
        echo "✅ Daemon server stopped"
        STOPPED_ANY=true
    else
        echo "⚠️  Daemon server was not running (cleaning up stale PID file)"
        rm "$PID_FILE"
    fi
fi

# Also try to stop any node server.js process on the HTTP port.
# Default to the extension's port (47382); honour an .env override.
HTTP_PORT=47382
ENV_FILE="$(dirname "$0")/.env"
if [ -f "$ENV_FILE" ]; then
    _p=$(grep -E '^HTTP_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '[:space:]')
    [ -n "$_p" ] && HTTP_PORT="$_p"
fi
NODE_PIDS=$(lsof -ti :"$HTTP_PORT" 2>/dev/null)
if [ ! -z "$NODE_PIDS" ]; then
    for NODE_PID in $NODE_PIDS; do
        # Check if it's our server.js
        if ps -p "$NODE_PID" -o command= | grep -q "server.js"; then
            echo "🛑 Stopping non-daemon server (PID: $NODE_PID)..."
            kill "$NODE_PID"
            sleep 1
            if ps -p "$NODE_PID" > /dev/null 2>&1; then
                kill -9 "$NODE_PID"
            fi
            echo "✅ Non-daemon server stopped"
            STOPPED_ANY=true
        fi
    done
fi

if [ "$STOPPED_ANY" = false ]; then
    echo "⚠️  No server is running"
fi
