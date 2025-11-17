import sys
import os
import json
import time
import cloudscraper
from urllib.parse import urljoin
import re
import asyncio

class APKDownloader:
    def __init__(self):
        self.scraper = cloudscraper.create_scraper(
            browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False}
        )
        self.scraper.headers.update({
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive'
        })
        self.base_url = 'https://apkpure.com'
        self.download_dir = 'downloads'
        
        if not os.path.exists(self.download_dir):
            os.makedirs(self.download_dir)

    async def async_get(self, url, timeout=10):
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, lambda: self.scraper.get(url, timeout=timeout))

    async def api_search(self, query):
        try:
            search_url = f"{self.base_url}/search?q={query.replace(' ', '+')}"
            response = await self.async_get(search_url, timeout=10)
            
            if response.status_code != 200:
                return None
            
            link_pattern = r'<a[^>]*href="(/[^\"]+/[^\"]+)"[^>]*class="[^\"]*first-info[^\"]*"'
            matches = re.findall(link_pattern, response.text)
            
            if matches:
                app_path = matches[0]
                app_url = urljoin(self.base_url, app_path)
                return app_url
            
            return None
        
        except Exception as e:
            print(f"API search error: {str(e)}", file=sys.stderr)
            return None

    async def quick_search(self, query):
        try:
            common_apps = {
                'facebook': 'com.facebook.katana',
                'facebook lite': 'com.facebook.lite',
                'whatsapp': 'com.whatsapp',
                'instagram': 'com.instagram.android',
                'instagram lite': 'com.instagram.lite',
                'free fire': 'com.dts.freefireth',
                'pubg': 'com.tencent.ig',
                'tiktok': 'com.zhiliaoapp.musically',
                'snapchat': 'com.snapchat.android',
                'telegram': 'org.telegram.messenger',
                'youtube': 'com.google.android.youtube',
                'spotify': 'com.spotify.music',
                'netflix': 'com.netflix.mediaclient',
                'discord': 'com.discord',
            }
            
            query_lower = query.lower().strip()
            
            if query_lower in common_apps:
                package = common_apps[query_lower]
                app_slug = query_lower.replace(' ', '-')
                url = f"{self.base_url}/{app_slug}/{package}"
                response = await self.async_get(url, timeout=5)
                if response.status_code == 200:
                    return url
            
            # Check if query is a package ID (contains dots)
            if '.' in query_lower and query_lower.count('.') >= 2:
                # Try direct package URL
                app_slug = query_lower.split('.')[-1]
                url = f"{self.base_url}/{app_slug}/{query_lower}"
                response = await self.async_get(url, timeout=5)
                if response.status_code == 200:
                    return url
            
            api_result = await self.api_search(query)
            if api_result:
                return api_result
            
            return None
        
        except Exception as e:
            print(f"Search error: {str(e)}", file=sys.stderr)
            return None

    async def get_download_link_fast(self, app_url):
        try:
            download_page = f"{app_url}/download"
            response = await self.async_get(download_page, timeout=8)
            
            if response.status_code != 200:
                print(f"Download page status: {response.status_code}", file=sys.stderr)
                return None
            
            patterns = [
                r'href="(https://d\.apkpure\.com/b/XAPK/[^"]+)"',
                r'href="(https://d\.apkpure\.com/b/APK/[^"]+)"',
                r'data-dt-file="([^"]+)"',
                r'"(https://download\.apkpure\.com/[^"]+)"'
            ]
            
            for pattern in patterns:
                match = re.search(pattern, response.text, re.IGNORECASE)
                if match:
                    download_url = match.group(1)
                    if not download_url.startswith('http'):
                        download_url = 'https:' + download_url if download_url.startswith('//') else urljoin(self.base_url, download_url)
                    
                    is_xapk = 'xapk' in download_url.lower() or 'XAPK' in download_url
                    return {'url': download_url, 'is_xapk': is_xapk}
            
            print("No download link patterns matched", file=sys.stderr)
            return None
            
        except Exception as e:
            print(f"Download link error: {str(e)}", file=sys.stderr)
            return None

    async def download_apk(self, package_name):
        try:
            app_url = await self.quick_search(package_name)
            
            if not app_url:
                return {'error': 'لم يتم العثور على التطبيق'}
            
            download_info = await self.get_download_link_fast(app_url)
            
            if not download_info:
                return {'error': 'فشل الحصول على رابط التحميل'}
            
            download_url = download_info['url']
            is_xapk = download_info['is_xapk']
            
            response = await self.async_get(download_url, timeout=180)
            
            if response.status_code != 200:
                return {'error': f'فشل التحميل: HTTP {response.status_code}'}
            
            content_disposition = response.headers.get('content-disposition', '')
            if 'filename=' in content_disposition:
                filename = content_disposition.split('filename=')[1].strip('"\'')
            else:
                ext = '.xapk' if is_xapk else '.apk'
                filename = f"{package_name.replace(' ', '_')}{ext}"
            
            file_path = os.path.join(self.download_dir, filename)
            
            with open(file_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=4194304):
                    if chunk:
                        f.write(chunk)
            
            file_size = os.path.getsize(file_path)
            
            return {
                'success': True,
                'file_path': file_path,
                'filename': filename,
                'size': file_size,
                'is_xapk': is_xapk
            }
            
        except Exception as e:
            return {'error': f'خطأ: {str(e)}'}

    async def fetch_download_info(self, package_name):
        """Fetch only the download link and metadata without downloading the file.

        Returns a dict similar to get_download_link_fast result or an error.
        """
        try:
            app_url = await self.quick_search(package_name)
            if not app_url:
                return {'error': 'لم يتم العثور على التطبيق'}

            download_info = await self.get_download_link_fast(app_url)
            if not download_info:
                return {'error': 'فشل الحصول على رابط التحميل'}

            return {'success': True, 'package': package_name, **download_info}
        except Exception as e:
            return {'error': f'خطأ: {str(e)}'}

async def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'لا يوجد اسم تطبيق'}))
        sys.exit(1)
    
    # Usage: python3 scraper.py "app name or package" [--link-only]
    package_name = sys.argv[1]
    link_only = False
    if len(sys.argv) > 2 and sys.argv[2] in ('--link-only', '-l'):
        link_only = True

    downloader = APKDownloader()
    if link_only:
        result = await downloader.fetch_download_info(package_name)
    else:
        result = await downloader.download_apk(package_name)

    print(json.dumps(result))

if __name__ == '__main__':
    asyncio.run(main())
