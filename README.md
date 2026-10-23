# Recruiter Inbox Triage

Event-driven inbox triage for a job search. It captures recruiter and job emails
(including LinkedIn-via-email), classifies each one with a **local** LLM, and routes
it into three buckets — so the few real signals (a human recruiter, an interview
invite, a rejection that matters) surface instantly, and the noise stays silent.

Built on self-hosted [n8n](https://n8n.io) + a local LLM (Ollama `llama3.2:3b`).
Classification runs on the host. Email bodies never go to a cloud LLM.
The subject and sender of ALERT and LOG mail do leave the host. They go to Telegram and Notion.

---

## The problem

A job-search inbox floods with job-alert digests, "application viewed" pings,
newsletters, recruiter pitches, and bot mail. The handful of high-value items get
buried. Manual sweeping doesn't scale. This pipeline does the sweeping.

## Architecture

```mermaid
flowchart TD
    A["Gmail inbox<br/>poll 60s"] --> B["Triage rules<br/>allowlist, keywords, noise"]
    B -->|clear| R{"Route to bucket"}
    B -->|ambiguous| L["Local LLM<br/>llama3.2:3b, on-host"]
    L --> R
    R -->|ALERT| AL["Telegram ping<br/>+ email label"]
    R -->|LOG| LO["Notion + label<br/>+ daily digest"]
    R -->|IGNORE| IG["Dropped"]

    classDef alert fill:#fb4c2f,stroke:#822111,color:#fff;
    classDef log fill:#fad165,stroke:#684e07,color:#000;
    classDef ignore fill:#e7e7e7,stroke:#666,color:#000;
    class AL alert;
    class LO log;
    class IG ignore;
```

> Classification is two-stage: cheap deterministic rules first (they resolve most mail and
> protect ALERT recall), then a **local** LLM only for the ambiguous middle. Detail below.

## How classification works

Two stages, **recall-first** (it is worse to miss a real interview than to over-keep):

1. **Deterministic rules** (cheap, first pass)
   - **Sender allowlist** — known ATS platforms (Greenhouse, Lever, Ashby, Workable,
     Comeet, SparkHire, Workday…) → likely a real recruiter → ALERT candidate.
   - **Recruiter keywords** — Hebrew *and* English (job/role/position, recruiting,
     CV, candidate, opportunity, interview…) → keep.
   - **LinkedIn job-alert digests** (e.g. "24 new jobs match your preferences") → IGNORE.
   - **Noise patterns** (newsletters, marketing, bot mail, unsubscribe footers) → IGNORE.

   Mail that these rules settle never reaches the LLM.

2. **Local LLM.** Mail from an ATS sender or with a job keyword goes to a 3B model.
   The model can raise a bucket, for example LOG to ALERT. It can never lower one.
   The workflow calls a local n8n webhook router (`/webhook/llm-route`) that fronts Ollama.
   That router is not in this repo.

### Three buckets

| Bucket | What | Action |
|---|---|---|
| **ALERT** | human recruiter reply · interview invite · rejection from a real application | instant push notification + email label |
| **LOG** | a real job signal worth keeping (incl. ambiguous — default here, never silently dropped) | database row + email label + one **daily digest** |
| **IGNORE** | job-alert digests · newsletters · marketing · bot mail | dropped |

> The model can only raise a bucket. A model mistake cannot drop mail the rules kept.
> Mail with no ATS sender and no job keyword is still dropped by the rules.
> `tests/` checks this guard.

## Privacy-first

- Classification runs **locally** (Ollama). Recruiter names and email bodies are
  **never** sent to a cloud LLM.
- Subject and sender of ALERT mail go to Telegram. Subject and sender of LOG mail go to Notion.
- Secrets come from environment variables (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `NOTION_TOKEN`). They are never stored in the workflow.
- The Notion data-source id is a placeholder in the LOG node. Set it after import.
- The published workflow has all ids/tokens scrubbed to placeholders.

## Notification model

- **ALERT** → instant Telegram (act now).
- **LOG** → filed silently (database + label) → surfaced once a day in a **digest**,
  so nothing slips, without a buzz per job-alert.
- **IGNORE** → gone.

## Stack

| Piece | Role |
|---|---|
| n8n (self-hosted) | orchestration |
| Ollama `llama3.2:3b` | local classifier |
| Gmail API | capture + labels |
| Telegram Bot | instant alerts |
| Notion | the review queue |
| Scheduled job | daily digest of the LOG queue (not in this repo) |

## Files

- [`workflow.sanitized.json`](workflow.sanitized.json) — the n8n workflow, with all
  ids/credentials/tokens replaced by `<PLACEHOLDERS>`. Import into n8n, wire your own
  credentials + env, and set the placeholders.
- [`tests/`](tests/) checks the workflow shape, the placeholders and the triage code.
  Run `node --test tests/*.test.mjs` (Node 20 or later).
- The daily digest is not part of this file.

## Design notes

- **Reuse-first.** This is a new *workflow*, not a new service — it composes
  infrastructure that already exists (a local LLM router, a Telegram bot, a Notion
  workspace). A new trigger is not a new pipeline.
- **3 buckets, not 2.** A binary keep/drop forces every ambiguous mail into a guess.
  The third bucket (LOG) is the safe default for "unsure," keeping the dangerous
  false-negative rate near zero.

## License

MIT — see [LICENSE](LICENSE).
