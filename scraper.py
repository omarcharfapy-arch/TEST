import sys
import os
import json
import time
import cloudscraper
from urllib.parse import urljoin
import re

class APKDownloader:
    def __init__(self):
        self.scraper = cloudscraper.create_scraper(
            browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False}
        )
        self.scraper.headers.update({
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        self.base_url = 'https://apkpure.com'
        self.download_dir = 'downloads'
        
        if not os.path.exists(self.download_dir):
            os.makedirs(self.download_dir)
    
    def api_search(self, query):
        try:
            search_url = f"{self.base_url}/search?q={query.replace(' ', '+')}"
            response = self.scraper.get(search_url, timeout=10)
            
            if response.status_code != 200:
                return None
            
            link_pattern = r'<a[^>]*href="(/[^"]+/[^"]+)"[^>]*class="[^"]*first-info[^"]*"'
            matches = re.findall(link_pattern, response.text)
            
            if matches:
                app_path = matches[0]
                if not app_path.startswith('http'):
                    app_url = urljoin(self.base_url, app_path)
                else:
                    app_url = app_path
                return app_url
            
            title_pattern = r'<div[^>]*class="[^"]*title[^"]*"[^>]*>.*?<a[^>]*href="(/[^"]+)"'
            matches = re.findall(title_pattern, response.text, re.DOTALL)
            
            if matches:
                app_path = matches[0]
                if not app_path.startswith('http'):
                    app_url = urljoin(self.base_url, app_path)
                else:
                    app_url = app_path
                return app_url
            
            return None
            
        except Exception as e:
            print(f"API search error: {str(e)}", file=sys.stderr)
            return None
    
    def quick_search(self, query):
        try:
            common_apps = {
                'facebook': 'com.facebook.katana',
                'facebook lite': 'com.facebook.lite',
                'whatsapp': 'com.whatsapp',
                'instagram': 'com.instagram.android',
                'instagram lite': 'com.instagram.lite',
                'twitter': 'com.twitter.android',
                'x': 'com.twitter.android',
                'tiktok': 'com.zhiliaoapp.musically',
                'tiktok lite': 'com.zhiliaoapp.musically.go',
                'snapchat': 'com.snapchat.android',
                'telegram': 'org.telegram.messenger',
                'youtube': 'com.google.android.youtube',
                'spotify': 'com.spotify.music',
                'spotify lite': 'com.spotify.lite',
                'netflix': 'com.netflix.mediaclient',
                'messenger': 'com.facebook.orca',
                'messenger lite': 'com.facebook.mlite',
                'chrome': 'com.android.chrome',
                'gmail': 'com.google.android.gm',
                'pubg': 'com.tencent.ig',
                'pubg mobile': 'com.tencent.ig',
                'pubg mobile lite': 'com.tencent.iglite',
                'free fire': 'com.dts.freefireth',
                'cod': 'com.activision.callofduty.shooter',
                'call of duty': 'com.activision.callofduty.shooter',
                'clash of clans': 'com.supercell.clashofclans',
                'candy crush': 'com.king.candycrushsaga',
                'subway surfers': 'com.kiloo.subwaysurf',
                'minecraft': 'com.mojang.minecraftpe',
                'roblox': 'com.roblox.client',
                'zoom': 'us.zoom.videomeetings',
                'discord': 'com.discord',
                'viber': 'com.viber.voip',
                'skype': 'com.skype.raider',
            }
            
            query_lower = query.lower().strip()
            
            if query_lower in common_apps:
                package = common_apps[query_lower]
                app_slug = query_lower.replace(' ', '-')
                url = f"{self.base_url}/{app_slug}/{package}"
                
                try:
                    response = self.scraper.get(url, timeout=5)
                    if response.status_code == 200:
                        return url
                except:
                    pass
            
            if '.' in query:
                package_parts = query.split('.')
                app_slug = package_parts[-1]
                
                possible_urls = [
                    f"{self.base_url}/{app_slug}/{query}",
                    f"{self.base_url}/{query.replace('.', '-')}/{query}",
                ]
                
                for url in possible_urls:
                    try:
                        response = self.scraper.get(url, timeout=5)
                        if response.status_code == 200 and 'download' in response.text.lower():
                            return url
                    except:
                        continue
            
            search_url = f"{self.base_url}/{query_lower.replace(' ', '-')}"
            try:
                response = self.scraper.get(search_url, timeout=8)
                if response.status_code == 200 and 'download' in response.text.lower():
                    return search_url
            except:
                pass
            
            api_result = self.api_search(query)
            if api_result:
                return api_result
            
            return None
            
        except Exception as e:
            print(f"Search error: {str(e)}", file=sys.stderr)
            return None
    
    def get_download_link_fast(self, app_url):
        try:
            download_page = f"{app_url}/download"
            response = self.scraper.get(download_page, timeout=8)
            
            if response.status_code != 200:
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
            
            return None
            
        except Exception as e:
            print(f"Download link error: {str(e)}", file=sys.stderr)
            return None
    
    def download_apk(self, package_name):
        try:
            app_url = self.quick_search(package_name)
            
            if not app_url:
                return {'error': 'لم يتم العثور على التطبيق'}
            
            download_info = self.get_download_link_fast(app_url)
            
            if not download_info:
                return {'error': 'فشل الحصول على رابط التحميل'}
            
            download_url = download_info['url']
            is_xapk = download_info['is_xapk']
            
            response = self.scraper.get(download_url, timeout=180, stream=True)
            
            if response.status_code != 200:
                return {'error': f'فشل التحميل: HTTP {response.status_code}'}
            
            content_disposition = response.headers.get('content-disposition', '')
            if 'filename=' in content_disposition:
                filename = content_disposition.split('filename=')[1].strip('"\'')
            else:
                ext = '.xapk' if is_xapk else '.apk'
                filename = f"{package_name.replace(' ', '_')}{ext}"
            
            if is_xapk and not filename.endswith(('.xapk', '.apks')):
                filename = filename.rsplit('.', 1)[0] + '.xapk'
            elif not is_xapk and not filename.endswith('.apk'):
                filename = filename.rsplit('.', 1)[0] + '.apk'
            
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

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'لا يوجد اسم تطبيق'}))
        sys.exit(1)
    
    package_name = sys.argv[1]
    
    downloader = APKDownloader()
    result = downloader.download_apk(package_name)
    
    print(json.dumps(result))

if __name__ == '__main__':
    main()
