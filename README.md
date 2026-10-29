# KodVani

Learn a programming language, practise interview questions, and ask by **voice, text, image or video**. Node/Express backend, single-page frontend.

Tabs: Learning · Interview Questions · Video Explanation · **Ask Anything** · Other Videos · Mock Interview / 1:1 (opens https://pvdprakash.com/mentor/) · My Account.
Register/login required. 1-day free trial from registration, then ₹500 / year via Razorpay.

## Which model handles what (all on Meta Model API, https://api.meta.ai/v1)
| Input | Model | What happens |
|---|---|---|
| Text, and every answer | `muse-spark-1.3` | Writes the answer |
| Voice | `muse-voice-transcribe-1.0` | Speech to text (browser converts to 16 kHz mono WAV), then muse-spark answers the transcript |
| Image + text | `muse-image-1.0` | "Add a picture" draws a labeled diagram (or redraws the uploaded image). muse-spark reads the image to answer |
| Video | `sam-3.1` | Optional "Highlight objects" finds and tracks e.g. "laptop" (boxes per frame). muse-spark explains the video |

`sam-3.1` is a segmentation model: it returns object boxes and masks, not explanations, so muse-spark writes the explanation. Change any model name in `.env`.

## Run
```
npm install
cp .env.example .env     # add MODEL_API_KEY (dev.meta.ai), Razorpay keys, APP_SECRET
npm start                # http://localhost:3000
```
Voice recording needs HTTPS or localhost.

## Deploy notes
- nginx: add `client_max_body_size 50m;` (uploads are sent as base64) and keep HTTPS on.
- Razorpay webhook: `https://YOUR-DOMAIN/api/pay/webhook`, events `payment.captured`, `order.paid`.
- Limits: voice up to 90 s, video MP4 up to 20 MB, 30 Ask requests per user per hour.

## Before going live
- The Meta calls were tested against a mock of the documented request shapes, not Meta's live API. Test each input type with your key; the image response and edit fields are the least documented.
- Emails aren't verified (add OTP or Google sign-in); no password reset yet; `data.json` should become MySQL/Mongo; add Terms, Privacy and Refund pages for Razorpay live mode.
- Check Meta's country availability policy for your users (dev.meta.ai/legal/geographic-use-policy).
