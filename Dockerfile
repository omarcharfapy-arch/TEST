FROM node:18-slim

# Install Python and dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY requirements.txt ./

# Install dependencies
RUN npm install
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Create necessary directories
RUN mkdir -p downloads auth_info_baileys

# Expose port for scraper server
EXPOSE 8001

# Set environment variables
ENV NODE_ENV=production
ENV SCRAPER_SERVER_URL=http://127.0.0.1:8001

# Start script
CMD ["./start.sh"]
