# WhatsApp Bot - APK Downloader

🤖 بوت واتساب لتحميل التطبيقات من APKPure

## 🚀 طرق التشغيل

### 1️⃣ تشغيل عادي
```bash
./start.sh
```

### 2️⃣ تشغيل مباشر
```bash
node bot.js
```

### 3️⃣ تشغيل باستخدام Docker
```bash
docker build -t whatsapp-bot .
docker run -it --env PHONE_NUMBER=YOUR_PHONE whatsapp-bot
```

### 4️⃣ تشغيل باستخدام Docker Compose
```bash
docker-compose up -d
```

## 📋 المتطلبات

- Node.js 18+
- Python 3.10+
- npm packages (انظر package.json)
- Python packages (انظر requirements.txt)

## ⚙️ الإعداد

1. انسخ المشروع:
```bash
git clone <repository-url>
cd TEST
```

2. ثبت المتطلبات:
```bash
npm install
pip install -r requirements.txt
```

3. أضف رقم هاتفك:
```bash
export PHONE_NUMBER=YOUR_PHONE_NUMBER
```

4. شغل البوت:
```bash
./start.sh
```

## 🔧 GitHub Actions

لتفعيل GitHub Actions:
1. اذهب إلى Settings → Secrets → Actions
2. أضف secret جديد: `PHONE_NUMBER` مع رقم هاتفك
3. البوت سيشتغل تلقائياً عند كل push

## 📸 المطور

**Omar Xaraf**
- Instagram: [@Omarxarafp](https://instagram.com/Omarxarafp)

## 📝 الميزات

- ✅ تحميل سريع من APKPure
- ✅ دعم APK و XAPK
- ✅ حذف تلقائي للملفات بعد الإرسال
- ✅ نظام Cache ذكي
- ✅ معالجة 100 طلب متزامن
- ✅ ترجمة تلقائية من العربية للإنجليزية

## 🛡️ License

MIT License
