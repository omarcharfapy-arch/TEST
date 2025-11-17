#!/bin/bash

# Start scraper server in background
python3 scraper_server.py &
SCRAPER_PID=$!
echo "✓ Scraper server started (PID: $SCRAPER_PID)"

# Wait for scraper to be ready
sleep 2

# Start the bot
echo "✓ Starting WhatsApp bot..."
node bot.js

# When bot stops, kill scraper too
kill $SCRAPER_PID 2>/dev/null
