from fastapi import FastAPI, HTTPException
import time
from pydantic import BaseModel
import uvicorn
import asyncio
import os
import sys
import json
from scraper import APKDownloader

app = FastAPI(title='APK Scraper Server')

# Limit concurrent downloads/processing inside the server
MAX_CONCURRENT = int(os.environ.get('SCRAPER_SERVER_CONCURRENCY', 200))
sem = asyncio.Semaphore(MAX_CONCURRENT)
DL_CONCURRENT = int(os.environ.get('SCRAPER_SERVER_DOWNLOAD_CONCURRENCY', 10))
dl_sem = asyncio.Semaphore(DL_CONCURRENT)

# Use a single global downloader instance to reuse session and headers
global_downloader = APKDownloader()

# Simple in-memory cache for link-only requests to reduce repeat lookups
LINK_CACHE_TTL = int(os.environ.get('LINK_CACHE_TTL', 15 * 60))  # seconds
link_cache = {}  # package -> (timestamp, data)

# In-flight dedupe for the same package
inflight = {}

@app.get('/health')
async def health():
    return {'status':'ok', 'concurrency': MAX_CONCURRENT}

class LinkResult(BaseModel):
    success: bool = False
    package: str | None = None
    url: str | None = None
    is_xapk: bool | None = None
    error: str | None = None

@app.get('/link', response_model=LinkResult)
async def get_link(package: str):
    async with sem:
        now = int(time.time())
        # return cached
        if package in link_cache:
            ts, data = link_cache[package]
            if now - ts < LINK_CACHE_TTL:
                return data
            else:
                del link_cache[package]

        # dedupe in-flight
        if package in inflight:
            # wait for inflight
            future = inflight[package]
            result = await future
            return result

        # create future and perform fetch
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        inflight[package] = future
        try:
            result = await global_downloader.fetch_download_info(package)
            # cache success responses only
            if result.get('success'):
                link_cache[package] = (now, result)
            future.set_result(result)
            return result
        except Exception as e:
            future.set_result({'error': str(e)})
            return {'error': str(e)}
        finally:
            inflight.pop(package, None)


class DownloadResult(BaseModel):
    success: bool = False
    package: str | None = None
    file_path: str | None = None
    filename: str | None = None
    size: int | None = None
    is_xapk: bool | None = None
    error: str | None = None


@app.get('/download', response_model=DownloadResult)
async def download_package(package: str):
    async with dl_sem:
        try:
            result = await global_downloader.download_apk(package)
            return result
        except Exception as e:
            return {'error': str(e)}

if __name__ == '__main__':
    workers = int(os.environ.get('SCRAPER_WORKERS', 2))
    uvicorn.run('scraper_server:app', host='127.0.0.1', port=8001, log_level='info', workers=workers)
