# Dadrah Legal Consultation Platform

Dadrah is a full-stack, Persian-language legal consultation platform built for local development and product testing. It provides distinct experiences for clients, lawyers, and administrators, with a responsive RTL interface, a local HTTP API, and a persistent SQLite database.

The project runs entirely on your machine. It does not require a hosted backend, an external database, or a ChatGPT-hosted domain.

## Highlights

- Persian, right-to-left interface using the local Sahel font family
- Responsive public website and role-specific dashboards
- Exact primary brand colors: `#1A237E` and `#EFBF04`
- Public lawyer directory with search, filtering, sorting, profiles, availability, and bookmarks
- Free legal questions with optional anonymous publication consent
- Assignment of one question to multiple authorized lawyers
- Separate lawyer answers with administrator-controlled publication
- Phone and in-person consultation booking with server-side pricing
- Atomic appointment-slot reservation to prevent double booking
- Simulated local checkout, payment tracking, cancellation, and refund states
- Secure client-lawyer consultation rooms and persisted chat messages
- Protected document upload and download with file type and size validation
- Verified-consultation review flow with administrator moderation
- Searchable legal questions, reviews, and legal magazine articles
- Administration of users, lawyers, verification, consultations, payments, content, services, FAQs, reviews, support, reports, permissions, and site settings
- Granular administrator capabilities with an immutable primary administrator
- Seeded data and three ready-to-use demo accounts

## Technology Stack

| Layer | Technology |
| --- | --- |
| Web application | React 19, Next.js-compatible App Router, Vinext, Vite |
| Language | TypeScript and modern JavaScript modules |
| Styling | Custom responsive CSS, RTL layout, local Sahel fonts |
| Icons | Lucide React |
| API | Node.js HTTP server |
| Database | SQLite using Node's built-in SQLite support |
| Schema | Drizzle ORM schema and SQL migration |
| Authentication | Token-based local sessions and scrypt password hashing |
| Tests | Node.js test runner, rendered HTML checks, and API workflow tests |

## Requirements

- Node.js `22.13.0` or newer
- npm

The SQLite implementation used by this project is included with supported Node.js versions and does not require a separate database server.

## Quick Start

Clone the repository and install dependencies:

```bash
git clone https://github.com/reza-mohammadvand/Legal-Website.git
cd Legal-Website
npm install
```

Start the frontend and local API together:

```bash
npm run dev
```

Open the following URLs:

| Service | URL |
| --- | --- |
| Website and dashboards | http://localhost:3010 |
| Local API | http://localhost:8787 |
| API health check | http://localhost:8787/api/health |

`npm run dev` starts both services in one process. Stop it with `Ctrl+C` when you are finished.

## Demo Accounts

The database is seeded automatically on first start.

| Role | Username | Password |
| --- | --- | --- |
| Client | `client` | `Client123!` |
| Lawyer | `lawyer` | `Lawyer123!` |
| Primary administrator | `admin` | `Admin123!` |

Use each account to inspect its separate navigation, permissions, data, and workflows.

## Core Workflows

### Free legal question

1. A client selects a legal topic and describes the issue.
2. The client can upload a supporting PDF, JPG, or PNG file.
3. The client decides whether an anonymized version may be published.
4. A direct question is sent only to the selected lawyer. An unassigned question waits for administrator assignment.
5. An administrator assigns up to five relevant lawyers.
6. Authorized lawyers answer from their dashboards.
7. Every answer appears privately in the client's dashboard. Public display requires client consent and administrator publication.

Text questions are free in the current product version.

### Phone consultation

1. The client selects a lawyer, topic, date, and time.
2. The API validates the lawyer and computes the price from the stored server-side tariff.
3. The client accepts the consultation terms.
4. The local payment is recorded as simulated and a tracking code is created.
5. The consultation becomes visible to the client, lawyer, and authorized administrators.

### In-person consultation

1. A verified lawyer creates and manages available appointment slots.
2. The client selects a real available slot on the lawyer's profile.
3. SQLite reserves the slot and creates the consultation and order in one transaction.
4. A database constraint and guarded update prevent the same slot from being booked twice.

### Consultation lifecycle

The platform supports registration, acceptance or rejection, an active consultation room, completion, cancellation, review eligibility, and administrative follow-up. Chat messages and protected documents remain associated with the relevant consultation.

## Dashboards

### Client dashboard

- Overview and current activity
- Consultations and cases
- Appointments and calendar
- Consultation messages
- Protected documents
- Orders and invoices
- Free questions and lawyer answers
- Bookmarked lawyers
- Support requests and complaints
- Editable personal profile

### Lawyer dashboard

- Performance overview and online availability
- New consultation requests
- Available appointment-slot management
- Cases and clients
- Consultation rooms and messages
- Authorized documents
- Assigned legal questions and answers
- Revenue and commission summary
- Reviews and performance metrics
- Professional profile and verification documents

### Administrator dashboard

- Platform overview and operational metrics
- Consultation requests and urgent cases
- User management
- Lawyer verification and document review
- Question assignment and answer publication
- Consultation lifecycle management
- Protected document moderation
- Orders, commissions, refunds, and financial reporting
- Article, FAQ, and service management
- Review moderation
- Support and complaint handling
- Reports and platform settings
- Administrator creation and granular permission management
- Direct link to view the public website

## Database

The application stores its local data in:

```text
data/dadrah.sqlite
```

The schema contains 20 related tables covering:

- users, lawyers, sessions, and administrator permissions
- questions, question assignments, and answers
- appointment slots, consultations, orders, and reviews
- bookmarks, documents, conversations, and chat messages
- articles, services, FAQs, support messages, and settings

The source schema is maintained in `db/schema.ts`, while `drizzle/0000_dadrah_core.sql` contains the corresponding SQL migration.

Local database files and uploaded documents are excluded from Git.

### Reset demo data

Stop the running development server, then run:

```bash
npm run db:reset
npm run dev
```

This removes the local SQLite database and test uploads. Fresh seed data is created on the next start.

## Available Commands

```bash
npm run dev          # Start the web application and API
npm run dev:web      # Start only the frontend
npm run dev:api      # Start only the API
npm run build        # Create a production frontend build
npm test             # Build and run all automated tests
npm run test:api     # Run the end-to-end API workflow test
npm run lint         # Run ESLint
npm run db:check     # Validate the 20-table SQL migration
npm run db:reset     # Reset the local database and uploaded test files
```

## Project Structure

```text
app/                       React application, routes, data adapters, and styles
db/                        Drizzle schema and database integration
drizzle/                   SQLite migration
public/                    Local fonts and visual assets
scripts/                   Local development and schema validation scripts
server/                    SQLite setup, seed data, API, and reset utility
tests/                     Rendered-page and API workflow tests
```

## Security Measures

This local build includes several safeguards that are also useful as a production foundation:

- scrypt password hashing with per-user salts
- constant-time password comparison
- random, expiring authentication tokens
- role and capability checks on protected endpoints
- server-authoritative consultation pricing
- atomic slot booking and uniqueness constraints
- ownership checks for questions, orders, chats, and documents
- publication consent enforcement for public answers
- randomized stored filenames
- MIME type, extension, and file-size validation
- protected document download endpoints
- request-body size limits and parameterized SQL statements

## Local Payment Notice

No real payment gateway is connected. Clicking the payment action records a simulated successful payment and does not charge a bank account. Before production use, replace this flow with a trusted gateway, signed callbacks, amount reconciliation, idempotency controls, and audited refund handling.

## Production Checklist

This repository is intended for local development, product review, and workflow testing. Before processing real legal matters or personal data, add and validate at least the following:

- HTTPS, production secrets, and restrictive CORS configuration
- a real payment gateway and verified callback flow
- password recovery and verified email or SMS delivery
- rate limiting, abuse prevention, and audit logs
- encrypted object storage, malware scanning, and retention rules
- database backups and disaster recovery procedures
- monitoring, alerting, and independent security testing
- reviewed terms, privacy policy, consent language, and legal disclaimers

## License

No open-source license has been added to this repository. All rights are reserved unless the repository owner states otherwise.
