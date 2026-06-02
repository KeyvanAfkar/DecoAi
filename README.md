# DecoBot — مشاور هوشمند دکور داخلی

## راه‌اندازی روی Render

### متغیرهای محیطی (Environment Variables)
این مقادیر را در داشبورد Render تنظیم کنید:

| Key | Value |
|-----|-------|
| `OPENAI_API_KEY` | کلید API شما |
| `OPENAI_BASE_URL` | `https://apihub.agnes-ai.com/v1` |
| `AI_ENDPOINT_PATH` | `/chat/completions` |
| `AI_MODEL` | `agnes-1.5-flash` |
| `AI_PROVIDER` | `agnes` |
| `AI_ALLOWED_HOST` | `apihub.agnes-ai.com` |
| `MAX_TOKENS` | `500` |
| `RATE_LIMIT_REQUESTS` | `30` |
| `RATE_LIMIT_MINUTES` | `60` |

> ⚠️ هرگز فایل `KEY-API.env` را در گیت‌هاب آپلود نکنید.

## اجرای محلی (Local)
```bash
node server.js
```
سپس مرورگر را روی `http://localhost:3000` باز کنید.
