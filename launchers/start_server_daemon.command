#!/bin/bash

# Change to the directory containing this script
cd "$(dirname "$0")"

SCRIPT_DIR="$(pwd)"
PID_FILE="$SCRIPT_DIR/server/server.pid"
LOG_FILE="$SCRIPT_DIR/server/server.log"

# Load environment variables from .env if it exists.
# Parse line-by-line (NOT `export $(... | xargs)`, which mangles values that
# contain spaces — e.g. a PROJECTS_DIR like "/Users/me/My Projects").
if [ -f "$SCRIPT_DIR/.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ''|\#*) continue ;;            # skip blanks and comments
        esac
        key="${line%%=*}"
        value="${line#*=}"
        # trim surrounding whitespace from the key only
        key="$(echo "$key" | xargs)"
        [ -n "$key" ] && export "$key=$value"
    done < "$SCRIPT_DIR/.env"
fi

# Set defaults if not in .env. These ports MUST match the Chrome extension
# (47382 HTTP / 47383 WS) so the tool works with no .env at all.
NODE_PATH=${NODE_PATH:-$(which node)}
HTTP_PORT=${HTTP_PORT:-47382}
WS_PORT=${WS_PORT:-47383}

# Check if server is already running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "✅ Server is already running (PID: $PID)"
        exit 0
    else
        # Stale PID file, remove it
        rm "$PID_FILE"
    fi
fi

# Change to server directory
cd server

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Start server in background
echo "🤖 Starting GitHub Buddy Server (daemon mode)..."
echo "📍 Using Node.js: $NODE_PATH"
echo "🔌 HTTP Port: $HTTP_PORT, WebSocket Port: $WS_PORT"
nohup "$NODE_PATH" server.js > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

# Save PID
echo "$SERVER_PID" > "$PID_FILE"

# Wait a moment to check if it started successfully
sleep 1

if ps -p "$SERVER_PID" > /dev/null 2>&1; then
    echo "✅ Server started successfully (PID: $SERVER_PID)"
    echo "🌐 Running at: http://localhost:$HTTP_PORT"
    echo "📝 Logs: $LOG_FILE"
    echo ""
    echo "Commands:"
    echo "  ./stop_server.command     - Stop the server"
    echo "  ./server_status.command   - Check server status"
    echo "  ./server_logs.command     - View server logs"
else
    echo "❌ Failed to start server"
    echo "Check logs: $LOG_FILE"
    rm "$PID_FILE"
    exit 1
fi
