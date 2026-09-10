# Timelap service status

Public status-only code for status.timelap.app. Operated by Miyo LLC, United States; contact timelapsupport@gmail.com.

GitHub Actions checks the fixed public Timelap homepage, health and release endpoints every 15 minutes. GitHub Pages serves the last observation independently of the application's Vercel deployment. Scheduling delays are possible; observations older than 45 minutes render as unknown. This is not a contractual uptime SLA or an end-to-end scheduling test.

Only fixed status categories and observation times are persisted. No application credentials, private links, database access or scheduling data belong in this repository. The only secret is a sending-only Resend key scoped to send.timelap.app, stored as RESEND_API_KEY in GitHub Actions. Outage/recovery notifications have a fixed recipient, timelapsupport@gmail.com. Mail acceptance is not proof of inbox receipt.

Transitions are queued before sending and retried on the next run if Resend fails. Payload-derived idempotency keys cover provider retries for 24 hours. A prolonged failure to persist state can cause a duplicate email. Pending notifications are public metadata containing only mode and timestamp. Repeated unchanged incidents do not send repeated alerts.

Run `node --test monitor.test.mjs` locally. Dispatch the workflow with exercise=true for two clearly labeled test emails without changing live status. To disable outbound alerts, disable the workflow before removing its key; a missing key leaves notifications queued. Public incident history retains the latest 20 transitions. No analytics or third-party browser resources are loaded.
