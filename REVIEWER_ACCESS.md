# Reviewer access (≤2 minutes)

## 1. Live literature demo
Open https://chive-shrouded-gag.ngrok-free.dev/chat.html  
Ask: *What is buprenorphine used for in opioid use disorder?*  
Expect PMID footnotes + educational disclaimer when retrieval succeeds.

Health: https://chive-shrouded-gag.ngrok-free.dev/api/status → `"ready": true`

## 2. Screencast
https://www.youtube.com/watch?v=WwFCYDoYzm8 (≤2.5 min)

## 3. Offline numbers
```bash
python3 evaluation/verify_results.py
```
Checks the published 33/35 vs 3/35 no-frame contrast and packet pooled mean 4.26.

## 4. Source
- Website: `website/`
- Meeting bot: `meeting-bot/`
- Paper PDF: `ECHO_AI_Demo_Paper_SUBMIT.pdf`
